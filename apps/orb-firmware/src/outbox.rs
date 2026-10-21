//! Reliable event delivery (docs/ORB.md section 6). `StateChanged`, `TapCaptured` and `Error` must reach the terminal even if a BLE
//! notification is lost, so each is kept here after it is sent and **resent byte for byte, with the same message id**, until the terminal
//! answers with `EventAck { of: id }`. The terminal de-duplicates by id, so a resend is harmless.
//!
//! Bounded and allocation-free: [`OUTBOX_CAPACITY`] events, each up to [`MAX_MESSAGE_LEN`] bytes. A new event for a state whose older event
//! is still unconfirmed supersedes it (the terminal only needs the latest state), but tap and error events are never replaced.
//! After [`MAX_RETRIES`] resends an event is given up on and reported, so the controller can surface a link problem instead of
//! retrying forever.

use crate::config::*;

/// What the sender must do with an event.
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum Delivery<'a> {
    /// Send these bytes now (first send or a resend; they are identical every time).
    Send { msg_id: u16, bytes: &'a [u8] },
    /// The event was never acknowledged after every retry.
    GaveUp { msg_id: u16 },
}

/// How an event is replaced by a newer one.
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum Kind {
    /// Only the latest matters: a newer `State` event drops an unconfirmed older one.
    State,
    /// Every one must arrive (a captured tap, an error): never replaced.
    Must,
}

#[derive(Clone, Copy)]
struct Entry {
    msg_id: u16,
    kind: Kind,
    len: usize,
    bytes: [u8; MAX_MESSAGE_LEN],
    /// When it was last sent; `None` until the first send.
    sent_ms: Option<u32>,
    resends: u8,
}

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum OutboxError {
    /// The encoded event is longer than [`MAX_MESSAGE_LEN`].
    TooLong,
    /// Every slot holds an event that must be kept; nothing can be added until one is acknowledged.
    Full,
}

pub struct Outbox {
    slots: [Option<Entry>; OUTBOX_CAPACITY],
}

impl Default for Outbox {
    fn default() -> Self {
        Self::new()
    }
}

impl Outbox {
    pub const fn new() -> Self {
        Outbox { slots: [None; OUTBOX_CAPACITY] }
    }

    /// Number of events still waiting for an acknowledgement.
    pub fn pending(&self) -> usize {
        self.slots.iter().flatten().count()
    }

    /// Queue an already-encoded event. It is sent by the next [`Outbox::poll`].
    pub fn push(&mut self, msg_id: u16, kind: Kind, bytes: &[u8]) -> Result<(), OutboxError> {
        if bytes.len() > MAX_MESSAGE_LEN {
            return Err(OutboxError::TooLong);
        }
        if kind == Kind::State {
            for s in self.slots.iter_mut() {
                if matches!(s, Some(e) if e.kind == Kind::State) {
                    *s = None;                                      // the newer state replaces the unconfirmed older one
                }
            }
        }
        let slot = self.slots.iter_mut().find(|s| s.is_none()).ok_or(OutboxError::Full)?;
        let mut buf = [0u8; MAX_MESSAGE_LEN];
        buf[..bytes.len()].copy_from_slice(bytes);
        *slot = Some(Entry { msg_id, kind, len: bytes.len(), bytes: buf, sent_ms: None, resends: 0 });
        Ok(())
    }

    /// The terminal acknowledged this event. Returns whether it was waiting (a duplicate or unknown ack changes nothing).
    pub fn ack(&mut self, msg_id: u16) -> bool {
        for s in self.slots.iter_mut() {
            if matches!(s, Some(e) if e.msg_id == msg_id) {
                *s = None;
                return true;
            }
        }
        false
    }

    /// Drop everything (the session ended: a new session starts with a fresh state report, old events must not be replayed into it).
    pub fn clear(&mut self) {
        self.slots = [None; OUTBOX_CAPACITY];
    }

    /// The next thing to do at `now_ms`, if any. Call repeatedly until it returns `None` (oldest first). Sending marks the event as sent now.
    pub fn poll(&mut self, now_ms: u32) -> Option<Delivery<'_>> {
        let mut pick: Option<usize> = None;
        for i in 0..self.slots.len() {
            let Some(e) = self.slots[i] else { continue };
            match e.sent_ms {
                None => {}
                Some(t) if now_ms.wrapping_sub(t) >= ACK_TIMEOUT_MS => {
                    if e.resends >= MAX_RETRIES {
                        self.slots[i] = None;                       // removed, so it is reported exactly once
                        return Some(Delivery::GaveUp { msg_id: e.msg_id });
                    }
                }
                Some(_) => continue,
            }
            // Oldest first: the lowest wrapping distance in send order is approximated by slot order (slots fill in order of arrival).
            pick = Some(i);
            break;
        }
        let i = pick?;
        let e = self.slots[i].as_mut().unwrap();
        if e.sent_ms.is_some() {
            e.resends += 1;
        }
        e.sent_ms = Some(now_ms);
        let e = self.slots[i].as_ref().unwrap();
        Some(Delivery::Send { msg_id: e.msg_id, bytes: &e.bytes[..e.len] })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn send(o: &mut Outbox, t: u32) -> Option<(u16, Vec<u8>)> {
        match o.poll(t) {
            Some(Delivery::Send { msg_id, bytes }) => Some((msg_id, bytes.to_vec())),
            _ => None,
        }
    }

    #[test]
    fn a_new_event_goes_out_once_then_waits_for_its_ack() {
        let mut o = Outbox::new();
        o.push(7, Kind::Must, &[1, 2, 3]).unwrap();
        assert_eq!(send(&mut o, 0), Some((7, vec![1, 2, 3])));
        assert_eq!(send(&mut o, 10), None);
        assert_eq!(send(&mut o, ACK_TIMEOUT_MS - 1), None);
        assert_eq!(o.pending(), 1);
    }

    #[test]
    fn an_unacknowledged_event_is_resent_identically_after_the_timeout() {
        let mut o = Outbox::new();
        o.push(7, Kind::Must, &[9, 9, 9, 9]).unwrap();
        let first = send(&mut o, 0).unwrap();
        let again = send(&mut o, ACK_TIMEOUT_MS).unwrap();
        assert_eq!(first, again);                                       // same id, same bytes
        assert_eq!(send(&mut o, ACK_TIMEOUT_MS + 1), None);              // the timer restarted
    }

    #[test]
    fn an_ack_stops_the_resends() {
        let mut o = Outbox::new();
        o.push(7, Kind::Must, &[1]).unwrap();
        send(&mut o, 0);
        assert!(o.ack(7));
        assert_eq!(o.pending(), 0);
        assert_eq!(send(&mut o, ACK_TIMEOUT_MS * 5), None);
    }

    #[test]
    fn duplicate_and_unknown_acks_change_nothing() {
        let mut o = Outbox::new();
        o.push(7, Kind::Must, &[1]).unwrap();
        o.push(8, Kind::Must, &[2]).unwrap();
        assert!(!o.ack(99));
        assert!(o.ack(7));
        assert!(!o.ack(7));
        assert_eq!(o.pending(), 1);
    }

    #[test]
    fn it_gives_up_after_the_retries_and_says_so_once() {
        let mut o = Outbox::new();
        o.push(7, Kind::Must, &[1]).unwrap();
        let mut t = 0;
        let mut sends = 0;
        loop {
            match o.poll(t) {
                Some(Delivery::Send { .. }) => sends += 1,
                Some(Delivery::GaveUp { msg_id }) => {
                    assert_eq!(msg_id, 7);
                    break;
                }
                None => t += ACK_TIMEOUT_MS,
            }
            assert!(sends <= MAX_RETRIES as usize + 1, "never gives up");
        }
        assert_eq!(sends, MAX_RETRIES as usize + 1);                     // the first send plus every retry
        assert_eq!(o.pending(), 0);
        assert!(o.poll(t + ACK_TIMEOUT_MS * 10).is_none());              // reported once only
    }

    #[test]
    fn a_newer_state_replaces_an_older_unconfirmed_state_but_not_a_tap() {
        let mut o = Outbox::new();
        o.push(1, Kind::State, &[1]).unwrap();
        o.push(2, Kind::Must, &[2]).unwrap();                            // a captured tap
        o.push(3, Kind::State, &[3]).unwrap();                           // supersedes state 1
        assert_eq!(o.pending(), 2);
        assert!(!o.ack(1));
        assert!(o.ack(2));
        assert!(o.ack(3));
    }

    #[test]
    fn events_are_sent_oldest_first() {
        let mut o = Outbox::new();
        o.push(1, Kind::Must, &[1]).unwrap();
        o.push(2, Kind::Must, &[2]).unwrap();
        assert_eq!(send(&mut o, 0).unwrap().0, 1);
        assert_eq!(send(&mut o, 0).unwrap().0, 2);
        assert_eq!(send(&mut o, 0), None);
    }

    #[test]
    fn it_is_bounded_and_refuses_when_full_of_events_that_must_arrive() {
        let mut o = Outbox::new();
        for i in 0..OUTBOX_CAPACITY as u16 {
            o.push(i, Kind::Must, &[0]).unwrap();
        }
        assert_eq!(o.push(99, Kind::Must, &[0]), Err(OutboxError::Full));
        assert!(o.ack(0));
        assert!(o.push(99, Kind::Must, &[0]).is_ok());
    }

    #[test]
    fn an_oversized_event_is_refused() {
        let mut o = Outbox::new();
        assert_eq!(o.push(1, Kind::Must, &[0u8; MAX_MESSAGE_LEN + 1]), Err(OutboxError::TooLong));
        assert!(o.push(1, Kind::Must, &[0u8; MAX_MESSAGE_LEN]).is_ok());
    }

    #[test]
    fn clear_forgets_everything_for_a_new_session() {
        let mut o = Outbox::new();
        o.push(1, Kind::Must, &[1]).unwrap();
        send(&mut o, 0);
        o.clear();
        assert_eq!(o.pending(), 0);
        assert_eq!(send(&mut o, ACK_TIMEOUT_MS * 9), None);
    }

    #[test]
    fn the_resend_timer_survives_clock_wraparound() {
        let mut o = Outbox::new();
        o.push(1, Kind::Must, &[1]).unwrap();
        let t0 = u32::MAX - 100;
        assert!(send(&mut o, t0).is_some());
        assert_eq!(send(&mut o, t0.wrapping_add(ACK_TIMEOUT_MS - 1)), None);
        assert!(send(&mut o, t0.wrapping_add(ACK_TIMEOUT_MS)).is_some());
    }
}
