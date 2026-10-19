//! Reads the URL out of an NDEF message holding one URI record, which is what an NTAG 424 DNA tag returns when it has secure dynamic
//! messaging switched on: the URL carries encrypted tag data and a counter that the server checks. The Orb never verifies it itself.

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum NdefError {
    Truncated,
    NotAUriRecord,
    UnsupportedRecord,
    BufferTooSmall,
}

const PREFIXES: [&str; 5] = ["", "http://www.", "https://www.", "http://", "https://"];

/// Writes the full URL of the first URI record in `msg` into `out` and returns its length. `msg` is the NDEF message itself, without
/// the 2-byte length that precedes it in the tag's NDEF file (see [`strip_nlen`]).
pub fn uri_from_ndef(msg: &[u8], out: &mut [u8]) -> Result<usize, NdefError> {
    if msg.len() < 3 {
        return Err(NdefError::Truncated);
    }
    let header = msg[0];
    let short = header & 0x10 != 0;      // SR: the payload length is one byte
    let has_id = header & 0x08 != 0;     // IL: an id length byte follows
    let tnf = header & 0x07;
    if !short {
        return Err(NdefError::UnsupportedRecord);
    }
    if tnf != 0x01 {
        return Err(NdefError::NotAUriRecord);
    }
    let type_len = msg[1] as usize;
    let payload_len = msg[2] as usize;
    let mut i = 3;
    let id_len = if has_id {
        if msg.len() <= i {
            return Err(NdefError::Truncated);
        }
        i += 1;
        msg[3] as usize
    } else {
        0
    };
    if msg.len() < i + type_len + id_len + payload_len {
        return Err(NdefError::Truncated);
    }
    if type_len != 1 || msg[i] != b'U' {
        return Err(NdefError::NotAUriRecord);
    }
    i += type_len + id_len;
    let payload = &msg[i..i + payload_len];
    if payload.is_empty() {
        return Err(NdefError::Truncated);
    }
    let prefix = match PREFIXES.get(payload[0] as usize) {
        Some(p) => p.as_bytes(),
        None => return Err(NdefError::UnsupportedRecord),
    };
    let rest = &payload[1..];
    if out.len() < prefix.len() + rest.len() {
        return Err(NdefError::BufferTooSmall);
    }
    out[..prefix.len()].copy_from_slice(prefix);
    out[prefix.len()..prefix.len() + rest.len()].copy_from_slice(rest);
    Ok(prefix.len() + rest.len())
}

/// Writes the text of the first Text record (type `T`) in `msg` into `out` and returns its length. Only UTF-8 text is accepted (the status
/// byte's UTF-16 flag is refused); the language code is skipped.
pub fn text_from_ndef(msg: &[u8], out: &mut [u8]) -> Result<usize, NdefError> {
    let payload = well_known_payload(msg, b'T')?;
    if payload.is_empty() {
        return Err(NdefError::Truncated);
    }
    let status = payload[0];
    if status & 0x80 != 0 {
        return Err(NdefError::UnsupportedRecord);          // UTF-16
    }
    let lang_len = (status & 0x3F) as usize;
    if payload.len() < 1 + lang_len {
        return Err(NdefError::Truncated);
    }
    let text = &payload[1 + lang_len..];
    if out.len() < text.len() {
        return Err(NdefError::BufferTooSmall);
    }
    out[..text.len()].copy_from_slice(text);
    Ok(text.len())
}

/// True only for a Text record whose text is exactly `config::RESET_CARD_TEXT` (case-sensitive, no extra bytes, no URL, no substring).
/// The caller must act on this only inside the eligible recovery handler, never during a normal payment.
pub fn is_reset_card(msg: &[u8]) -> bool {
    let mut buf = [0u8; 32];
    match text_from_ndef(msg, &mut buf) {
        Ok(n) => &buf[..n] == crate::config::RESET_CARD_TEXT.as_bytes(),
        Err(_) => false,
    }
}

/// The payload of the first short, well-known record of the given type.
fn well_known_payload(msg: &[u8], want: u8) -> Result<&[u8], NdefError> {
    if msg.len() < 3 {
        return Err(NdefError::Truncated);
    }
    let header = msg[0];
    if header & 0x10 == 0 {
        return Err(NdefError::UnsupportedRecord);
    }
    if header & 0x07 != 0x01 {
        return Err(NdefError::NotAUriRecord);
    }
    let has_id = header & 0x08 != 0;
    let type_len = msg[1] as usize;
    let payload_len = msg[2] as usize;
    let mut i = 3;
    let mut id_len = 0;
    if has_id {
        if msg.len() <= i {
            return Err(NdefError::Truncated);
        }
        id_len = msg[i] as usize;
        i += 1;
    }
    if msg.len() < i + type_len + id_len + payload_len {
        return Err(NdefError::Truncated);
    }
    if type_len != 1 || msg[i] != want {
        return Err(NdefError::NotAUriRecord);
    }
    i += type_len + id_len;
    Ok(&msg[i..i + payload_len])
}

/// A tag's NDEF file starts with a 2-byte big-endian length; returns the message that follows it.
pub fn strip_nlen(file: &[u8]) -> Result<&[u8], NdefError> {
    if file.len() < 2 {
        return Err(NdefError::Truncated);
    }
    let n = ((file[0] as usize) << 8) | file[1] as usize;
    if file.len() < 2 + n {
        return Err(NdefError::Truncated);
    }
    Ok(&file[2..2 + n])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(prefix: u8, rest: &str) -> Vec<u8> {
        let mut payload = vec![prefix];
        payload.extend_from_slice(rest.as_bytes());
        let mut m = vec![0xD1, 0x01, payload.len() as u8, b'U'];   // MB, ME, SR, TNF = well known
        m.extend_from_slice(&payload);
        m
    }

    #[test]
    fn expands_the_uri_prefix() {
        let mut out = [0u8; 128];
        let n = uri_from_ndef(&record(0x04, "tag.example/v1/ABCDEF"), &mut out).unwrap();
        assert_eq!(&out[..n], b"https://tag.example/v1/ABCDEF");
        let n = uri_from_ndef(&record(0x00, "https://raw.example/x"), &mut out).unwrap();
        assert_eq!(&out[..n], b"https://raw.example/x");
        let n = uri_from_ndef(&record(0x02, "tag.example/a"), &mut out).unwrap();
        assert_eq!(&out[..n], b"https://www.tag.example/a");
    }

    #[test]
    fn rejects_what_is_not_a_uri_record() {
        let mut out = [0u8; 64];
        assert_eq!(uri_from_ndef(&[0xD1, 0x01], &mut out), Err(NdefError::Truncated));
        assert_eq!(uri_from_ndef(&[0xD2, 0x01, 0x01, b'T', 0x00], &mut out), Err(NdefError::NotAUriRecord));   // a media record
        assert_eq!(uri_from_ndef(&record(0x7F, "x"), &mut out), Err(NdefError::UnsupportedRecord));
        let mut small = [0u8; 4];
        assert_eq!(uri_from_ndef(&record(0x04, "tag.example/long"), &mut small), Err(NdefError::BufferTooSmall));
    }

    fn text_record(status: u8, lang: &str, text: &str) -> Vec<u8> {
        let mut payload = vec![status | lang.len() as u8];
        payload.extend_from_slice(lang.as_bytes());
        payload.extend_from_slice(text.as_bytes());
        let mut m = vec![0xD1, 0x01, payload.len() as u8, b'T'];
        m.extend_from_slice(&payload);
        m
    }

    #[test]
    fn reads_a_text_record_and_skips_the_language() {
        let mut out = [0u8; 32];
        let n = text_from_ndef(&text_record(0x00, "en", "SAY_GOODBYE"), &mut out).unwrap();
        assert_eq!(&out[..n], b"SAY_GOODBYE");
        assert_eq!(text_from_ndef(&text_record(0x80, "en", "x"), &mut out), Err(NdefError::UnsupportedRecord));   // UTF-16
        assert_eq!(text_from_ndef(&record(0x04, "tag.example/x"), &mut out), Err(NdefError::NotAUriRecord));          // a URI, not text
    }

    #[test]
    fn only_the_exact_card_resets() {
        assert!(is_reset_card(&text_record(0x00, "en", "SAY_GOODBYE")));
        assert!(is_reset_card(&text_record(0x00, "", "SAY_GOODBYE")));
        assert!(!is_reset_card(&text_record(0x00, "en", "say_goodbye")));          // case matters
        assert!(!is_reset_card(&text_record(0x00, "en", "SAY_GOODBYE ")));         // no extra bytes
        assert!(!is_reset_card(&text_record(0x00, "en", "xSAY_GOODBYEx")));        // no substring match
        assert!(!is_reset_card(&text_record(0x80, "en", "SAY_GOODBYE")));          // UTF-16 refused
        assert!(!is_reset_card(&record(0x00, "SAY_GOODBYE")));                     // a URI record with that text is not the card
        assert!(!is_reset_card(&[]));
    }

    #[test]
    fn strips_the_length_that_starts_the_ndef_file() {
        let msg = record(0x04, "a.b/c");
        let mut file = vec![0x00, msg.len() as u8];
        file.extend_from_slice(&msg);
        assert_eq!(strip_nlen(&file).unwrap(), &msg[..]);
        assert_eq!(strip_nlen(&[0x00, 0x09, 1]), Err(NdefError::Truncated));
    }
}
