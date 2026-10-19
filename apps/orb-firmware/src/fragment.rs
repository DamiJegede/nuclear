//! Splitting messages into BLE-sized fragments and putting them back together (docs/ORB.md section 8).
//!
//! The usable size of one BLE write or notification is the negotiated ATT MTU minus the 3 bytes of ATT overhead, and it can be small:
//! never assume 64. The link layer passes that capacity to [`Fragments::new`]; any capacity above [`FRAGMENT_HEADER_LEN`] works.
//!
//! ```text
//! | flags: u8 | message id: u16 | index: u8 | chunk |        flags: bit0 FIRST, bit1 LAST
//! ```
//!
//! Fragments of one message arrive in order (BLE preserves order). The reassembler is bounded, drops a message that stalls, ignores
//! duplicate fragments and duplicate whole messages (a retransmission), and rejects anything out of order or too long.

use crate::config::{FRAGMENT_TIMEOUT_MS, MAX_MESSAGE_LEN};

pub const FRAGMENT_HEADER_LEN: usize = 4;
const FIRST: u8 = 0x01;
const LAST: u8 = 0x02;

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum FragmentError {
    /// The capacity cannot hold the header plus at least one byte.
    CapacityTooSmall,
    /// The message does not fit [`MAX_MESSAGE_LEN`].
    MessageTooLong,
    BufferTooSmall,
    /// Shorter than a header, or flags that make no sense.
    Malformed,
    /// A fragment that is not the next one expected (the partial message is dropped).
    OutOfOrder,
    /// The message grew past [`MAX_MESSAGE_LEN`] (the partial message is dropped).
    Overflow,
}

/// Produces the fragments of one message, one per call to [`Fragments::next_into`].
pub struct Fragments<'a> {
    msg: &'a [u8],
    msg_id: u16,
    chunk: usize,
    offset: usize,
    index: u8,
    started: bool,
}

impl<'a> Fragments<'a> {
    /// `capacity` is the largest value one BLE write can carry.
    pub fn new(msg: &'a [u8], msg_id: u16, capacity: usize) -> Result<Fragments<'a>, FragmentError> {
        if capacity <= FRAGMENT_HEADER_LEN {
            return Err(FragmentError::CapacityTooSmall);
        }
        if msg.len() > MAX_MESSAGE_LEN {
            return Err(FragmentError::MessageTooLong);
        }
        let chunk = capacity - FRAGMENT_HEADER_LEN;
        // The index is one byte, so a message must fit in 256 fragments.
        if msg.len().div_ceil(chunk).max(1) > 256 {
            return Err(FragmentError::CapacityTooSmall);
        }
        Ok(Fragments { msg, msg_id, chunk, offset: 0, index: 0, started: false })
    }

    /// Writes the next fragment into `out` and returns its length, or `Ok(None)` when all have been produced.
    pub fn next_into(&mut self, out: &mut [u8]) -> Result<Option<usize>, FragmentError> {
        if self.started && self.offset >= self.msg.len() {
            return Ok(None);
        }
        let remaining = self.msg.len() - self.offset;
        let take = remaining.min(self.chunk);
        if out.len() < FRAGMENT_HEADER_LEN + take {
            return Err(FragmentError::BufferTooSmall);
        }
        let mut flags = 0;
        if !self.started {
            flags |= FIRST;
        }
        if self.offset + take >= self.msg.len() {
            flags |= LAST;
        }
        out[0] = flags;
        out[1..3].copy_from_slice(&self.msg_id.to_be_bytes());
        out[3] = self.index;
        out[FRAGMENT_HEADER_LEN..FRAGMENT_HEADER_LEN + take].copy_from_slice(&self.msg[self.offset..self.offset + take]);
        self.offset += take;
        self.index = self.index.wrapping_add(1);
        self.started = true;
        Ok(Some(FRAGMENT_HEADER_LEN + take))
    }
}

/// Puts fragments back together. One partial message at a time.
pub struct Reassembler {
    buf: [u8; MAX_MESSAGE_LEN],
    len: usize,
    msg_id: u16,
    next_index: u8,
    receiving: bool,
    last_activity_ms: u32,
    /// The id of the last message handed out, so a retransmitted copy is ignored.
    last_done: Option<u16>,
}

impl Default for Reassembler {
    fn default() -> Self {
        Self::new()
    }
}

impl Reassembler {
    pub const fn new() -> Self {
        Reassembler { buf: [0; MAX_MESSAGE_LEN], len: 0, msg_id: 0, next_index: 0, receiving: false, last_activity_ms: 0, last_done: None }
    }

    fn reset(&mut self) {
        self.len = 0;
        self.receiving = false;
        self.next_index = 0;
    }

    /// Drops a partial message that has stalled. Call regularly.
    pub fn expire(&mut self, now_ms: u32) {
        if self.receiving && now_ms.wrapping_sub(self.last_activity_ms) >= FRAGMENT_TIMEOUT_MS {
            self.reset();
        }
    }

    /// Feeds one fragment. Returns `Ok(Some((message id, message bytes)))` when it completes a message, `Ok(None)` when more is expected or
    /// the fragment was a harmless duplicate.
    pub fn push(&mut self, fragment: &[u8], now_ms: u32) -> Result<Option<(u16, &[u8])>, FragmentError> {
        self.expire(now_ms);
        if fragment.len() < FRAGMENT_HEADER_LEN {
            return Err(FragmentError::Malformed);
        }
        let flags = fragment[0];
        if flags & !(FIRST | LAST) != 0 {
            return Err(FragmentError::Malformed);
        }
        let id = u16::from_be_bytes([fragment[1], fragment[2]]);
        let index = fragment[3];
        let chunk = &fragment[FRAGMENT_HEADER_LEN..];

        if flags & FIRST != 0 {
            if index != 0 {
                return Err(FragmentError::Malformed);
            }
            if self.last_done == Some(id) {
                return Ok(None);                       // a retransmitted copy of a message already delivered
            }
            if self.receiving && self.msg_id == id {
                return Ok(None);                       // a repeated first fragment of the message in progress
            }
            self.reset();                              // a new message replaces a stalled partial one
            self.receiving = true;
            self.msg_id = id;
        } else {
            if !self.receiving {
                // A middle fragment of a message that is not in progress: a stray or a duplicate of a finished one.
                return if self.last_done == Some(id) { Ok(None) } else { Err(FragmentError::OutOfOrder) };
            }
            if id != self.msg_id {
                self.reset();
                return Err(FragmentError::OutOfOrder);
            }
            if index.wrapping_add(1) == self.next_index {
                return Ok(None);                       // the fragment we just took, repeated
            }
            if index != self.next_index {
                self.reset();
                return Err(FragmentError::OutOfOrder);
            }
        }
        if self.len + chunk.len() > MAX_MESSAGE_LEN {
            self.reset();
            return Err(FragmentError::Overflow);
        }
        self.buf[self.len..self.len + chunk.len()].copy_from_slice(chunk);
        self.len += chunk.len();
        self.next_index = index.wrapping_add(1);
        self.last_activity_ms = now_ms;
        if flags & LAST != 0 {
            self.receiving = false;
            self.last_done = Some(self.msg_id);
            let done = self.len;
            self.len = 0;
            return Ok(Some((self.msg_id, &self.buf[..done])));
        }
        Ok(None)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn split(msg: &[u8], id: u16, capacity: usize) -> Vec<Vec<u8>> {
        let mut f = Fragments::new(msg, id, capacity).unwrap();
        let mut out = Vec::new();
        let mut buf = vec![0u8; capacity];
        while let Some(n) = f.next_into(&mut buf).unwrap() {
            assert!(n <= capacity);
            out.push(buf[..n].to_vec());
        }
        out
    }

    fn message(n: usize) -> Vec<u8> {
        (0..n).map(|i| (i % 251) as u8).collect()
    }

    #[test]
    fn a_message_survives_any_capacity() {
        for capacity in [5usize, 6, 8, 20, 23, 64, 244] {
            for len in [0usize, 1, 7, 100, 256] {
                let msg = message(len);
                let frags = split(&msg, 0x1234, capacity);
                let mut r = Reassembler::new();
                let mut got = None;
                for f in &frags {
                    if let Some((id, bytes)) = r.push(f, 0).unwrap() {
                        got = Some((id, bytes.to_vec()));
                    }
                }
                assert_eq!(got, Some((0x1234, msg)), "capacity {capacity} len {len}");
            }
        }
    }

    #[test]
    fn rejects_capacity_that_cannot_carry_a_byte() {
        assert_eq!(Fragments::new(&[1], 1, 4).err(), Some(FragmentError::CapacityTooSmall));
        assert_eq!(Fragments::new(&[0; 257], 1, 64).err(), Some(FragmentError::MessageTooLong));
    }

    #[test]
    fn duplicates_are_ignored() {
        let msg = message(50);
        let frags = split(&msg, 9, 20);
        let mut r = Reassembler::new();
        assert!(r.push(&frags[0], 0).unwrap().is_none());
        assert!(r.push(&frags[0], 1).unwrap().is_none());           // repeated first fragment
        assert!(r.push(&frags[1], 2).unwrap().is_none());
        assert!(r.push(&frags[1], 3).unwrap().is_none());           // repeated middle fragment
        let mut done = None;
        for f in &frags[2..] {
            if let Some((_, b)) = r.push(f, 4).unwrap() {
                done = Some(b.to_vec());
            }
        }
        assert_eq!(done, Some(msg));
        // A retransmission of the whole message afterwards is dropped, not delivered twice.
        for f in &frags {
            assert!(r.push(f, 5).unwrap().is_none());
        }
    }

    #[test]
    fn out_of_order_drops_the_partial_message() {
        let msg = message(60);
        let frags = split(&msg, 3, 20);
        let mut r = Reassembler::new();
        r.push(&frags[0], 0).unwrap();
        assert_eq!(r.push(&frags[2], 1).err(), Some(FragmentError::OutOfOrder));
        // The stalled rest is now a stray: refused, and a fresh message works.
        assert_eq!(r.push(&frags[1], 2).err(), Some(FragmentError::OutOfOrder));
        let fresh = split(&message(10), 4, 20);
        assert!(r.push(&fresh[0], 3).unwrap().is_some());
    }

    #[test]
    fn a_stalled_message_expires() {
        let frags = split(&message(60), 3, 20);
        let mut r = Reassembler::new();
        r.push(&frags[0], 0).unwrap();
        r.expire(FRAGMENT_TIMEOUT_MS);
        assert_eq!(r.push(&frags[1], FRAGMENT_TIMEOUT_MS + 1).err(), Some(FragmentError::OutOfOrder));
    }

    #[test]
    fn malformed_fragments_are_refused() {
        let mut r = Reassembler::new();
        assert_eq!(r.push(&[1, 0, 1], 0).err(), Some(FragmentError::Malformed));
        assert_eq!(r.push(&[0x80, 0, 1, 0, 9], 0).err(), Some(FragmentError::Malformed));
        assert_eq!(r.push(&[0x01, 0, 1, 5, 9], 0).err(), Some(FragmentError::Malformed));      // FIRST must have index 0
    }

    #[test]
    fn a_message_cannot_grow_without_bound() {
        let mut r = Reassembler::new();
        let big = [0u8; 100];
        let mut frag = vec![0x01, 0, 7, 0];
        frag.extend_from_slice(&big);
        r.push(&frag, 0).unwrap();
        let mut idx = 1u8;
        let mut res = Ok(None);
        for _ in 0..3 {
            let mut f = vec![0x00, 0, 7, idx];
            f.extend_from_slice(&big);
            res = r.push(&f, 0).map(|o| o.map(|(i, _)| i));
            idx += 1;
            if res.is_err() {
                break;
            }
        }
        assert_eq!(res.err(), Some(FragmentError::Overflow));
    }
}
