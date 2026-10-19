//! The Bluetooth LE frame format between the Orb and the terminal app.
//!
//! ```text
//! | type: u8 | length: u8 | payload: length bytes |
//! ```
//!
//! One frame per BLE write or notification. The payload is at most [`MAX_PAYLOAD`] bytes (the link MTU is negotiated to at least 64).
//! Strings are UTF-8 without a terminator. This must stay in step with `apps/merchant-terminal/Sources/NuclearTerminalKit/OrbProtocol.swift`.

pub const MAX_PAYLOAD: usize = 62;

const HELLO: u8 = 0x01;
const READ_REQUEST: u8 = 0x10;
const CANCEL: u8 = 0x11;
const TAP_READ: u8 = 0x20;
const FAILURE: u8 = 0x7F;
const PING: u8 = 0xF0;
const PONG: u8 = 0xF1;

/// Why a tap could not be read.
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum OrbError {
    Timeout = 1,
    NoTag = 2,
    Unreadable = 3,
    Busy = 4,
    UnsupportedTag = 5,
}

impl OrbError {
    pub fn from_u8(v: u8) -> Option<OrbError> {
        match v {
            1 => Some(OrbError::Timeout),
            2 => Some(OrbError::NoTag),
            3 => Some(OrbError::Unreadable),
            4 => Some(OrbError::Busy),
            5 => Some(OrbError::UnsupportedTag),
            _ => None,
        }
    }
}

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum ProtocolError {
    Truncated,
    UnknownType(u8),
    BadPayload,
    TooLong,
    BufferTooSmall,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Frame<'a> {
    /// Orb to app, right after connecting: MAC address, model and firmware version.
    Hello { uid: [u8; 6], model: &'a str, firmware: &'a str },
    /// App to Orb: start listening for a tap (0 seconds means until cancelled).
    ReadRequest { timeout_seconds: u8 },
    /// App to Orb: stop listening.
    Cancel,
    /// Orb to app: the NDEF URL read from the tag.
    TapRead { url: &'a str },
    /// Orb to app: the tap could not be read.
    Failure(OrbError),
    Ping,
    Pong,
}

impl<'a> Frame<'a> {
    /// Writes the frame into `out` and returns the number of bytes used.
    pub fn encode(&self, out: &mut [u8]) -> Result<usize, ProtocolError> {
        if out.len() < 2 {
            return Err(ProtocolError::BufferTooSmall);
        }
        let (ty, len) = match self {
            Frame::Hello { uid, model, firmware } => {
                let m = model.as_bytes();
                let f = firmware.as_bytes();
                let total = 6 + 1 + m.len() + 1 + f.len();
                if m.len() > 255 || f.len() > 255 || total > MAX_PAYLOAD {
                    return Err(ProtocolError::TooLong);
                }
                if out.len() < 2 + total {
                    return Err(ProtocolError::BufferTooSmall);
                }
                out[2..8].copy_from_slice(uid);
                out[8] = m.len() as u8;
                out[9..9 + m.len()].copy_from_slice(m);
                out[9 + m.len()] = f.len() as u8;
                out[10 + m.len()..10 + m.len() + f.len()].copy_from_slice(f);
                (HELLO, total)
            }
            Frame::ReadRequest { timeout_seconds } => {
                if out.len() < 3 {
                    return Err(ProtocolError::BufferTooSmall);
                }
                out[2] = *timeout_seconds;
                (READ_REQUEST, 1)
            }
            Frame::Cancel => (CANCEL, 0),
            Frame::TapRead { url } => {
                let u = url.as_bytes();
                if u.len() > MAX_PAYLOAD {
                    return Err(ProtocolError::TooLong);
                }
                if out.len() < 2 + u.len() {
                    return Err(ProtocolError::BufferTooSmall);
                }
                out[2..2 + u.len()].copy_from_slice(u);
                (TAP_READ, u.len())
            }
            Frame::Failure(e) => {
                if out.len() < 3 {
                    return Err(ProtocolError::BufferTooSmall);
                }
                out[2] = *e as u8;
                (FAILURE, 1)
            }
            Frame::Ping => (PING, 0),
            Frame::Pong => (PONG, 0),
        };
        out[0] = ty;
        out[1] = len as u8;
        Ok(2 + len)
    }

    /// Reads one frame from the start of `bytes`.
    pub fn decode(bytes: &'a [u8]) -> Result<Frame<'a>, ProtocolError> {
        if bytes.len() < 2 {
            return Err(ProtocolError::Truncated);
        }
        let ty = bytes[0];
        let len = bytes[1] as usize;
        if len > MAX_PAYLOAD {
            return Err(ProtocolError::TooLong);
        }
        if bytes.len() < 2 + len {
            return Err(ProtocolError::Truncated);
        }
        let p = &bytes[2..2 + len];
        match ty {
            HELLO => {
                if p.len() < 8 {
                    return Err(ProtocolError::BadPayload);
                }
                let mut uid = [0u8; 6];
                uid.copy_from_slice(&p[0..6]);
                let m_len = p[6] as usize;
                if p.len() < 7 + m_len + 1 {
                    return Err(ProtocolError::BadPayload);
                }
                let model = core::str::from_utf8(&p[7..7 + m_len]).map_err(|_| ProtocolError::BadPayload)?;
                let f_len = p[7 + m_len] as usize;
                if p.len() != 8 + m_len + f_len {
                    return Err(ProtocolError::BadPayload);
                }
                let firmware = core::str::from_utf8(&p[8 + m_len..]).map_err(|_| ProtocolError::BadPayload)?;
                Ok(Frame::Hello { uid, model, firmware })
            }
            READ_REQUEST => {
                if p.len() != 1 {
                    return Err(ProtocolError::BadPayload);
                }
                Ok(Frame::ReadRequest { timeout_seconds: p[0] })
            }
            CANCEL => Ok(Frame::Cancel),
            TAP_READ => {
                let url = core::str::from_utf8(p).map_err(|_| ProtocolError::BadPayload)?;
                Ok(Frame::TapRead { url })
            }
            FAILURE => {
                if p.len() != 1 {
                    return Err(ProtocolError::BadPayload);
                }
                match OrbError::from_u8(p[0]) {
                    Some(e) => Ok(Frame::Failure(e)),
                    None => Err(ProtocolError::BadPayload),
                }
            }
            PING => Ok(Frame::Ping),
            PONG => Ok(Frame::Pong),
            other => Err(ProtocolError::UnknownType(other)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn round_trip(f: Frame<'_>) {
        let mut buf = [0u8; 64];
        let n = f.encode(&mut buf).unwrap();
        assert_eq!(Frame::decode(&buf[..n]).unwrap(), f);
    }

    #[test]
    fn every_frame_round_trips() {
        round_trip(Frame::Hello { uid: [0xAA, 0xBB, 0xCC, 0x00, 0x11, 0x22], model: "Orb 2", firmware: "1.4.2" });
        round_trip(Frame::ReadRequest { timeout_seconds: 30 });
        round_trip(Frame::Cancel);
        round_trip(Frame::TapRead { url: "https://tag.example/v1/0123456789abcdef0123456789abcdef" });
        round_trip(Frame::Failure(OrbError::NoTag));
        round_trip(Frame::Ping);
        round_trip(Frame::Pong);
    }

    #[test]
    fn matches_the_swift_side_byte_for_byte() {
        let mut buf = [0u8; 8];
        let n = Frame::ReadRequest { timeout_seconds: 5 }.encode(&mut buf).unwrap();
        assert_eq!(&buf[..n], &[0x10, 1, 5]);
    }

    #[test]
    fn rejects_bad_input() {
        assert_eq!(Frame::decode(&[0x20, 5, 1, 2]), Err(ProtocolError::Truncated));
        assert_eq!(Frame::decode(&[0x99, 0]), Err(ProtocolError::UnknownType(0x99)));
        assert_eq!(Frame::decode(&[]), Err(ProtocolError::Truncated));
        assert_eq!(Frame::decode(&[0x10, 2, 1, 2]), Err(ProtocolError::BadPayload));
        assert_eq!(Frame::decode(&[0x7F, 1, 99]), Err(ProtocolError::BadPayload));
        assert_eq!(Frame::decode(&[0x20, 63]), Err(ProtocolError::TooLong));
    }

    #[test]
    fn refuses_to_overflow() {
        let long = "x".repeat(63);
        let mut buf = [0u8; 80];
        assert_eq!(Frame::TapRead { url: &long }.encode(&mut buf), Err(ProtocolError::TooLong));
        let mut tiny = [0u8; 2];
        assert_eq!(Frame::ReadRequest { timeout_seconds: 1 }.encode(&mut tiny), Err(ProtocolError::BufferTooSmall));
    }
}
