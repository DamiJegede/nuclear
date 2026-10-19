//! What the Orb does with each frame from the terminal app, each clock tick and each tag read. It decides; the board code acts on the
//! answer (start or stop the NFC front end, send a frame). One tap per request: a successful read returns the Orb to idle.
use crate::protocol::{Frame, OrbError};

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum State {
    Idle,
    /// Waiting for a tap. `deadline_ms` is None when the app asked to wait until cancelled.
    Listening { deadline_ms: Option<u32> },
}

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum Action {
    None,
    StartPolling,
    StopPolling,
    SendPong,
    SendFailure(OrbError),
}

pub struct Session {
    state: State,
}

impl Default for Session {
    fn default() -> Self {
        Self::new()
    }
}

impl Session {
    pub const fn new() -> Self {
        Session { state: State::Idle }
    }

    pub fn state(&self) -> State {
        self.state
    }

    pub fn on_frame(&mut self, frame: &Frame<'_>, now_ms: u32) -> Action {
        match frame {
            Frame::ReadRequest { timeout_seconds } => match self.state {
                State::Listening { .. } => Action::SendFailure(OrbError::Busy),
                State::Idle => {
                    let deadline = if *timeout_seconds == 0 {
                        None
                    } else {
                        Some(now_ms.wrapping_add(u32::from(*timeout_seconds) * 1000))
                    };
                    self.state = State::Listening { deadline_ms: deadline };
                    Action::StartPolling
                }
            },
            Frame::Cancel => match self.state {
                State::Listening { .. } => {
                    self.state = State::Idle;
                    Action::StopPolling
                }
                State::Idle => Action::None,
            },
            Frame::Ping => Action::SendPong,
            _ => Action::None,
        }
    }

    /// Call regularly. Returns `Some(Timeout)` once, when the request's deadline has passed (the Orb is idle again).
    pub fn on_tick(&mut self, now_ms: u32) -> Option<OrbError> {
        if let State::Listening { deadline_ms: Some(deadline) } = self.state {
            // Wrap-safe: the deadline has passed when `now - deadline` is not negative as a signed number.
            if (now_ms.wrapping_sub(deadline) as i32) >= 0 {
                self.state = State::Idle;
                return Some(OrbError::Timeout);
            }
        }
        None
    }

    /// A tag was read. Returns true when it answers a pending request (and the Orb goes idle); false when nobody asked.
    pub fn on_tag_read(&mut self) -> bool {
        match self.state {
            State::Listening { .. } => {
                self.state = State::Idle;
                true
            }
            State::Idle => false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_read_request_starts_listening_and_a_tap_ends_it() {
        let mut s = Session::new();
        assert_eq!(s.on_frame(&Frame::ReadRequest { timeout_seconds: 30 }, 1_000), Action::StartPolling);
        assert_eq!(s.state(), State::Listening { deadline_ms: Some(31_000) });
        assert!(s.on_tag_read());
        assert_eq!(s.state(), State::Idle);
        assert!(!s.on_tag_read());   // a second tap nobody asked for is ignored
    }

    #[test]
    fn a_second_request_while_listening_is_busy() {
        let mut s = Session::new();
        s.on_frame(&Frame::ReadRequest { timeout_seconds: 0 }, 0);
        assert_eq!(s.on_frame(&Frame::ReadRequest { timeout_seconds: 5 }, 10), Action::SendFailure(OrbError::Busy));
    }

    #[test]
    fn cancel_and_ping() {
        let mut s = Session::new();
        assert_eq!(s.on_frame(&Frame::Cancel, 0), Action::None);
        s.on_frame(&Frame::ReadRequest { timeout_seconds: 0 }, 0);
        assert_eq!(s.on_frame(&Frame::Cancel, 5), Action::StopPolling);
        assert_eq!(s.state(), State::Idle);
        assert_eq!(s.on_frame(&Frame::Ping, 5), Action::SendPong);
    }

    #[test]
    fn times_out_once_even_across_the_clock_wrapping() {
        let mut s = Session::new();
        let start = u32::MAX - 500;
        s.on_frame(&Frame::ReadRequest { timeout_seconds: 2 }, start);
        assert_eq!(s.on_tick(start.wrapping_add(1_000)), None);
        assert_eq!(s.on_tick(start.wrapping_add(2_000)), Some(OrbError::Timeout));
        assert_eq!(s.state(), State::Idle);
        assert_eq!(s.on_tick(start.wrapping_add(3_000)), None);
    }

    #[test]
    fn zero_seconds_waits_until_cancelled() {
        let mut s = Session::new();
        s.on_frame(&Frame::ReadRequest { timeout_seconds: 0 }, 0);
        assert_eq!(s.on_tick(u32::MAX / 2), None);
    }
}
