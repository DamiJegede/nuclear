//! Protocol version 1: application messages between the Orb and the terminal app (docs/ORB.md section 8).
//!
//! A message is `| opcode: u8 | message id: u16 | session generation: u16 | body |` (big-endian), at most [`crate::config::MAX_MESSAGE_LEN`] bytes.
//! It travels over BLE in fragments (see [`crate::fragment`]). Every operational message has an id; the session generation changes with every
//! authenticated session, so a result from an older session can be recognised and refused. Financial messages also carry the attempt id (the
//! 16 bytes of the terminal's attempt UUID, which the terminal also uses as the API idempotency key).
//!
//! **The opcodes are PROVISIONAL** and, like the GATT UUIDs, are not final until the Rust and Swift sides are exercised on hardware. The
//! `PROTOCOL_VERSION` is negotiated in `Hello` / `Handshake` so incompatible peers can refuse each other.
//! The Swift side is `apps/merchant-terminal/Sources/NuclearTerminalKit/OrbMessages.swift`; `docs/orb-protocol-vectors.md` lists shared vectors.

pub const PROTOCOL_VERSION: u8 = 1;
pub type AttemptId = [u8; 16];

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub struct Header {
    pub msg_id: u16,
    pub session: u16,
}

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum MessageError {
    Truncated,
    UnknownOpcode(u8),
    BadBody,
    TooLong,
    BufferTooSmall,
}

macro_rules! byte_enum {
    ($(#[$m:meta])* $name:ident { $($variant:ident = $val:expr),+ $(,)? }) => {
        $(#[$m])*
        #[derive(Debug, PartialEq, Eq, Clone, Copy)]
        pub enum $name { $($variant = $val),+ }
        impl $name {
            pub fn from_u8(v: u8) -> Option<$name> {
                match v { $($val => Some($name::$variant),)+ _ => None }
            }
        }
    };
}

byte_enum!(HandshakeKind { Bind = 0, Resume = 1 });
byte_enum!(Purpose { Payment = 1, Lookup = 2, Staff = 3 });
byte_enum!(PaymentOutcome { Processing = 0, Completed = 1, Declined = 2, Unknown = 3 });
byte_enum!(LightMode { Normal = 0, Identify = 1, Emergency = 2 });
byte_enum!(
    /// The Orb's operational state as reported to the terminal (the table in docs/ORB.md section 4).
    OrbState {
        Starting = 0, Pairing = 1, BoundDisconnected = 2, ConnectedIdle = 3, AwaitingPayment = 4, Processing = 5,
        Completed = 6, Declined = 7, Updating = 8, ShuttingDown = 9,
    }
);
byte_enum!(
    /// Why a command was refused, or an error occurred.
    Reason {
        Ok = 0, Busy = 1, NotConnected = 2, StaleSession = 3, StaleAttempt = 4, AlreadyCaptured = 5, Unsupported = 6, BadRequest = 7,
        ProximityNotMet = 8, Unauthorized = 9, UnresolvedAttempt = 10, Timeout = 11, Unreadable = 12, UnsupportedTag = 13,
    }
);

/// Battery telemetry (docs/ORB.md section 9). `percent` is `None` when the Orb has no valid estimate; `temperature_c` only when supported.
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub struct BatteryStatus {
    pub percent: Option<u8>,
    pub millivolts: u16,
    pub charging: bool,
    pub external_power: bool,
    pub low: bool,
    pub critical: bool,
    pub temperature_c: Option<i8>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Message<'a> {
    // ---- terminal -> Orb
    Handshake { kind: HandshakeKind, protocol: u8, nonce: [u8; 16], proof: [u8; 32] },
    Heartbeat { counter: u32 },
    BeginPayment { attempt: AttemptId, amount_cents: u64, currency: [u8; 3], timeout_s: u8 },
    BeginRead { purpose: Purpose, attempt: AttemptId, timeout_s: u8 },
    Cancel { attempt: AttemptId },
    PaymentStatus { attempt: AttemptId, outcome: PaymentOutcome },
    GetStatus,
    Configure { volume: u8, muted: bool },
    SetLightMode { mode: LightMode, duration_s: u16 },
    /// Acknowledges an Orb event (state changed, tap captured, error) by its message id so the Orb stops resending it.
    EventAck { of: u16 },
    // ---- Orb -> terminal
    Hello { uid: [u8; 6], model: &'a str, firmware: &'a str, protocol: u8, capabilities: u16 },
    HandshakeResult { accepted: bool, reason: Reason },
    CommandAck { of: u16, accepted: bool, reason: Reason },
    StateChanged { state: OrbState },
    TapCaptured { purpose: Purpose, attempt: AttemptId, url: &'a str },
    Battery(BatteryStatus),
    /// A correlated error that is **not** a payment failure. `attempt` is all zeros when there is none.
    Error { reason: Reason, attempt: AttemptId },
}

const OP_HANDSHAKE: u8 = 0x01;
const OP_HEARTBEAT: u8 = 0x02;
const OP_BEGIN_PAYMENT: u8 = 0x03;
const OP_BEGIN_READ: u8 = 0x04;
const OP_CANCEL: u8 = 0x05;
const OP_PAYMENT_STATUS: u8 = 0x06;
const OP_GET_STATUS: u8 = 0x07;
const OP_CONFIGURE: u8 = 0x08;
const OP_SET_LIGHT: u8 = 0x09;
const OP_EVENT_ACK: u8 = 0x0A;
const OP_HELLO: u8 = 0x81;
const OP_HANDSHAKE_RESULT: u8 = 0x82;
const OP_COMMAND_ACK: u8 = 0x83;
const OP_STATE_CHANGED: u8 = 0x84;
const OP_TAP_CAPTURED: u8 = 0x85;
const OP_BATTERY: u8 = 0x86;
const OP_ERROR: u8 = 0x87;

/// Bytes before the body.
pub const HEADER_LEN: usize = 5;
/// The value of `percent` / `temperature_c` on the wire when unknown.
const PERCENT_UNKNOWN: u8 = 0xFF;
const TEMP_UNKNOWN: i8 = i8::MIN;

struct W<'b> {
    buf: &'b mut [u8],
    n: usize,
}
impl<'b> W<'b> {
    fn put(&mut self, bytes: &[u8]) -> Result<(), MessageError> {
        if self.n + bytes.len() > self.buf.len() {
            return Err(MessageError::BufferTooSmall);
        }
        self.buf[self.n..self.n + bytes.len()].copy_from_slice(bytes);
        self.n += bytes.len();
        Ok(())
    }
    fn u8(&mut self, v: u8) -> Result<(), MessageError> {
        self.put(&[v])
    }
    fn u16(&mut self, v: u16) -> Result<(), MessageError> {
        self.put(&v.to_be_bytes())
    }
    fn str8(&mut self, s: &str) -> Result<(), MessageError> {
        if s.len() > 255 {
            return Err(MessageError::TooLong);
        }
        self.u8(s.len() as u8)?;
        self.put(s.as_bytes())
    }
}

struct R<'a> {
    b: &'a [u8],
    i: usize,
}
impl<'a> R<'a> {
    fn take(&mut self, n: usize) -> Result<&'a [u8], MessageError> {
        if self.i + n > self.b.len() {
            return Err(MessageError::BadBody);
        }
        let s = &self.b[self.i..self.i + n];
        self.i += n;
        Ok(s)
    }
    fn u8(&mut self) -> Result<u8, MessageError> {
        Ok(self.take(1)?[0])
    }
    fn u16(&mut self) -> Result<u16, MessageError> {
        let s = self.take(2)?;
        Ok(u16::from_be_bytes([s[0], s[1]]))
    }
    fn u32(&mut self) -> Result<u32, MessageError> {
        let s = self.take(4)?;
        Ok(u32::from_be_bytes([s[0], s[1], s[2], s[3]]))
    }
    fn u64(&mut self) -> Result<u64, MessageError> {
        let s = self.take(8)?;
        let mut a = [0u8; 8];
        a.copy_from_slice(s);
        Ok(u64::from_be_bytes(a))
    }
    fn arr<const N: usize>(&mut self) -> Result<[u8; N], MessageError> {
        let s = self.take(N)?;
        let mut a = [0u8; N];
        a.copy_from_slice(s);
        Ok(a)
    }
    fn str8(&mut self) -> Result<&'a str, MessageError> {
        let n = self.u8()? as usize;
        core::str::from_utf8(self.take(n)?).map_err(|_| MessageError::BadBody)
    }
    fn rest_str(&mut self) -> Result<&'a str, MessageError> {
        let s = &self.b[self.i..];
        self.i = self.b.len();
        core::str::from_utf8(s).map_err(|_| MessageError::BadBody)
    }
    fn done(&self) -> Result<(), MessageError> {
        if self.i == self.b.len() {
            Ok(())
        } else {
            Err(MessageError::BadBody)
        }
    }
}

fn reason(r: &mut R) -> Result<Reason, MessageError> {
    Reason::from_u8(r.u8()?).ok_or(MessageError::BadBody)
}

impl<'a> Message<'a> {
    /// Writes `header` and the message into `out`; returns the length.
    pub fn encode(&self, header: Header, out: &mut [u8]) -> Result<usize, MessageError> {
        let mut w = W { buf: out, n: 0 };
        let op = match self {
            Message::Handshake { .. } => OP_HANDSHAKE,
            Message::Heartbeat { .. } => OP_HEARTBEAT,
            Message::BeginPayment { .. } => OP_BEGIN_PAYMENT,
            Message::BeginRead { .. } => OP_BEGIN_READ,
            Message::Cancel { .. } => OP_CANCEL,
            Message::PaymentStatus { .. } => OP_PAYMENT_STATUS,
            Message::GetStatus => OP_GET_STATUS,
            Message::Configure { .. } => OP_CONFIGURE,
            Message::SetLightMode { .. } => OP_SET_LIGHT,
            Message::EventAck { .. } => OP_EVENT_ACK,
            Message::Hello { .. } => OP_HELLO,
            Message::HandshakeResult { .. } => OP_HANDSHAKE_RESULT,
            Message::CommandAck { .. } => OP_COMMAND_ACK,
            Message::StateChanged { .. } => OP_STATE_CHANGED,
            Message::TapCaptured { .. } => OP_TAP_CAPTURED,
            Message::Battery(_) => OP_BATTERY,
            Message::Error { .. } => OP_ERROR,
        };
        w.u8(op)?;
        w.u16(header.msg_id)?;
        w.u16(header.session)?;
        match self {
            Message::Handshake { kind, protocol, nonce, proof } => {
                w.u8(*kind as u8)?;
                w.u8(*protocol)?;
                w.put(nonce)?;
                w.put(proof)?;
            }
            Message::Heartbeat { counter } => w.put(&counter.to_be_bytes())?,
            Message::BeginPayment { attempt, amount_cents, currency, timeout_s } => {
                w.put(attempt)?;
                w.put(&amount_cents.to_be_bytes())?;
                w.put(currency)?;
                w.u8(*timeout_s)?;
            }
            Message::BeginRead { purpose, attempt, timeout_s } => {
                w.u8(*purpose as u8)?;
                w.put(attempt)?;
                w.u8(*timeout_s)?;
            }
            Message::Cancel { attempt } => w.put(attempt)?,
            Message::PaymentStatus { attempt, outcome } => {
                w.put(attempt)?;
                w.u8(*outcome as u8)?;
            }
            Message::GetStatus => {}
            Message::Configure { volume, muted } => {
                w.u8(*volume)?;
                w.u8(*muted as u8)?;
            }
            Message::SetLightMode { mode, duration_s } => {
                w.u8(*mode as u8)?;
                w.u16(*duration_s)?;
            }
            Message::EventAck { of } => w.u16(*of)?,
            Message::Hello { uid, model, firmware, protocol, capabilities } => {
                w.put(uid)?;
                w.u8(*protocol)?;
                w.u16(*capabilities)?;
                w.str8(model)?;
                w.str8(firmware)?;
            }
            Message::HandshakeResult { accepted, reason } => {
                w.u8(*accepted as u8)?;
                w.u8(*reason as u8)?;
            }
            Message::CommandAck { of, accepted, reason } => {
                w.u16(*of)?;
                w.u8(*accepted as u8)?;
                w.u8(*reason as u8)?;
            }
            Message::StateChanged { state } => w.u8(*state as u8)?,
            Message::TapCaptured { purpose, attempt, url } => {
                w.u8(*purpose as u8)?;
                w.put(attempt)?;
                w.put(url.as_bytes())?;
            }
            Message::Battery(b) => {
                w.u8(b.percent.unwrap_or(PERCENT_UNKNOWN))?;
                w.u16(b.millivolts)?;
                w.u8((b.charging as u8) | ((b.external_power as u8) << 1) | ((b.low as u8) << 2) | ((b.critical as u8) << 3))?;
                w.u8(b.temperature_c.unwrap_or(TEMP_UNKNOWN) as u8)?;
            }
            Message::Error { reason, attempt } => {
                w.u8(*reason as u8)?;
                w.put(attempt)?;
            }
        }
        if w.n > crate::config::MAX_MESSAGE_LEN {
            return Err(MessageError::TooLong);
        }
        Ok(w.n)
    }

    pub fn decode(bytes: &'a [u8]) -> Result<(Header, Message<'a>), MessageError> {
        if bytes.len() < HEADER_LEN {
            return Err(MessageError::Truncated);
        }
        if bytes.len() > crate::config::MAX_MESSAGE_LEN {
            return Err(MessageError::TooLong);
        }
        let op = bytes[0];
        let header = Header { msg_id: u16::from_be_bytes([bytes[1], bytes[2]]), session: u16::from_be_bytes([bytes[3], bytes[4]]) };
        let mut r = R { b: &bytes[HEADER_LEN..], i: 0 };
        let m = match op {
            OP_HANDSHAKE => {
                let kind = HandshakeKind::from_u8(r.u8()?).ok_or(MessageError::BadBody)?;
                let protocol = r.u8()?;
                Message::Handshake { kind, protocol, nonce: r.arr()?, proof: r.arr()? }
            }
            OP_HEARTBEAT => Message::Heartbeat { counter: r.u32()? },
            OP_BEGIN_PAYMENT => Message::BeginPayment { attempt: r.arr()?, amount_cents: r.u64()?, currency: r.arr()?, timeout_s: r.u8()? },
            OP_BEGIN_READ => {
                let purpose = Purpose::from_u8(r.u8()?).ok_or(MessageError::BadBody)?;
                Message::BeginRead { purpose, attempt: r.arr()?, timeout_s: r.u8()? }
            }
            OP_CANCEL => Message::Cancel { attempt: r.arr()? },
            OP_PAYMENT_STATUS => {
                let attempt = r.arr()?;
                Message::PaymentStatus { attempt, outcome: PaymentOutcome::from_u8(r.u8()?).ok_or(MessageError::BadBody)? }
            }
            OP_GET_STATUS => Message::GetStatus,
            OP_CONFIGURE => {
                let volume = r.u8()?;
                Message::Configure { volume, muted: r.u8()? != 0 }
            }
            OP_SET_LIGHT => {
                let mode = LightMode::from_u8(r.u8()?).ok_or(MessageError::BadBody)?;
                Message::SetLightMode { mode, duration_s: r.u16()? }
            }
            OP_EVENT_ACK => Message::EventAck { of: r.u16()? },
            OP_HELLO => {
                let uid = r.arr()?;
                let protocol = r.u8()?;
                let capabilities = r.u16()?;
                Message::Hello { uid, protocol, capabilities, model: r.str8()?, firmware: r.str8()? }
            }
            OP_HANDSHAKE_RESULT => {
                let accepted = r.u8()? != 0;
                Message::HandshakeResult { accepted, reason: reason(&mut r)? }
            }
            OP_COMMAND_ACK => {
                let of = r.u16()?;
                let accepted = r.u8()? != 0;
                Message::CommandAck { of, accepted, reason: reason(&mut r)? }
            }
            OP_STATE_CHANGED => Message::StateChanged { state: OrbState::from_u8(r.u8()?).ok_or(MessageError::BadBody)? },
            OP_TAP_CAPTURED => {
                let purpose = Purpose::from_u8(r.u8()?).ok_or(MessageError::BadBody)?;
                let attempt = r.arr()?;
                Message::TapCaptured { purpose, attempt, url: r.rest_str()? }
            }
            OP_BATTERY => {
                let p = r.u8()?;
                let millivolts = r.u16()?;
                let f = r.u8()?;
                let t = r.u8()? as i8;
                Message::Battery(BatteryStatus {
                    percent: if p == PERCENT_UNKNOWN { None } else { Some(p) },
                    millivolts,
                    charging: f & 1 != 0,
                    external_power: f & 2 != 0,
                    low: f & 4 != 0,
                    critical: f & 8 != 0,
                    temperature_c: if t == TEMP_UNKNOWN { None } else { Some(t) },
                })
            }
            OP_ERROR => {
                let rs = reason(&mut r)?;
                Message::Error { reason: rs, attempt: r.arr()? }
            }
            other => return Err(MessageError::UnknownOpcode(other)),
        };
        r.done()?;
        Ok((header, m))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ATTEMPT: AttemptId = [0x12, 0x34, 0x56, 0x78, 0x9A, 0xBC, 0xDE, 0xF0, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88];
    const H: Header = Header { msg_id: 0x0102, session: 0x0304 };

    fn round(m: Message<'_>) {
        let mut buf = [0u8; 256];
        let n = m.encode(H, &mut buf).unwrap();
        let (h, d) = Message::decode(&buf[..n]).unwrap();
        assert_eq!(h, H);
        assert_eq!(d, m);
    }

    #[test]
    fn every_message_round_trips() {
        round(Message::Handshake { kind: HandshakeKind::Bind, protocol: 1, nonce: [7; 16], proof: [9; 32] });
        round(Message::Heartbeat { counter: 0xDEADBEEF });
        round(Message::BeginPayment { attempt: ATTEMPT, amount_cents: 12_999, currency: *b"USD", timeout_s: 30 });
        round(Message::BeginRead { purpose: Purpose::Lookup, attempt: ATTEMPT, timeout_s: 0 });
        round(Message::Cancel { attempt: ATTEMPT });
        round(Message::PaymentStatus { attempt: ATTEMPT, outcome: PaymentOutcome::Completed });
        round(Message::GetStatus);
        round(Message::Configure { volume: 70, muted: true });
        round(Message::SetLightMode { mode: LightMode::Emergency, duration_s: 600 });
        round(Message::EventAck { of: 0xBEEF });
        round(Message::Hello { uid: [1, 2, 3, 4, 5, 6], model: "Orb 1", firmware: "0.1.0", protocol: 1, capabilities: 0b11 });
        round(Message::HandshakeResult { accepted: false, reason: Reason::ProximityNotMet });
        round(Message::CommandAck { of: 77, accepted: true, reason: Reason::Ok });
        round(Message::StateChanged { state: OrbState::AwaitingPayment });
        round(Message::TapCaptured { purpose: Purpose::Payment, attempt: ATTEMPT, url: "https://tag.example/v1/0123456789abcdef0123456789abcdef" });
        round(Message::Battery(BatteryStatus { percent: Some(83), millivolts: 3987, charging: true, external_power: true, low: false, critical: false, temperature_c: Some(24) }));
        round(Message::Battery(BatteryStatus { percent: None, millivolts: 3300, charging: false, external_power: false, low: true, critical: true, temperature_c: None }));
        round(Message::Error { reason: Reason::Timeout, attempt: ATTEMPT });
    }

    /// The same bytes are asserted in the Swift tests (apps/merchant-terminal Tests): the two sides must agree on the wire.
    #[test]
    fn golden_vectors() {
        let mut buf = [0u8; 256];
        let n = Message::Heartbeat { counter: 1 }.encode(Header { msg_id: 0x0001, session: 0x0002 }, &mut buf).unwrap();
        assert_eq!(&buf[..n], &[0x02, 0x00, 0x01, 0x00, 0x02, 0x00, 0x00, 0x00, 0x01]);
        let n = Message::BeginPayment { attempt: [0xAA; 16], amount_cents: 1250, currency: *b"USD", timeout_s: 30 }
            .encode(Header { msg_id: 0x0010, session: 0x0003 }, &mut buf)
            .unwrap();
        assert_eq!(
            &buf[..n],
            &[0x03, 0x00, 0x10, 0x00, 0x03, 0xAA, 0xAA, 0xAA, 0xAA, 0xAA, 0xAA, 0xAA, 0xAA, 0xAA, 0xAA, 0xAA, 0xAA, 0xAA, 0xAA, 0xAA, 0xAA,
              0, 0, 0, 0, 0, 0, 0x04, 0xE2, b'U', b'S', b'D', 30]
        );
        let n = Message::StateChanged { state: OrbState::ConnectedIdle }.encode(Header { msg_id: 5, session: 1 }, &mut buf).unwrap();
        assert_eq!(&buf[..n], &[0x84, 0x00, 0x05, 0x00, 0x01, 0x03]);
        let n = Message::EventAck { of: 0x0102 }.encode(Header { msg_id: 7, session: 3 }, &mut buf).unwrap();
        assert_eq!(&buf[..n], &[0x0A, 0x00, 0x07, 0x00, 0x03, 0x01, 0x02]);
    }

    #[test]
    fn bad_input_is_refused() {
        assert_eq!(Message::decode(&[0x02, 0, 1]), Err(MessageError::Truncated));
        assert_eq!(Message::decode(&[0x55, 0, 1, 0, 1]), Err(MessageError::UnknownOpcode(0x55)));
        assert_eq!(Message::decode(&[0x02, 0, 1, 0, 1, 0, 0]), Err(MessageError::BadBody));                // heartbeat too short
        assert_eq!(Message::decode(&[0x07, 0, 1, 0, 1, 9]), Err(MessageError::BadBody));                   // trailing byte
        assert_eq!(Message::decode(&[0x84, 0, 1, 0, 1, 99]), Err(MessageError::BadBody));                  // unknown state
        let mut tiny = [0u8; 4];
        assert_eq!(Message::GetStatus.encode(H, &mut tiny), Err(MessageError::BufferTooSmall));
    }

    #[test]
    fn a_long_url_is_refused_not_truncated() {
        let long = "x".repeat(300);
        let mut buf = [0u8; 512];
        assert_eq!(Message::TapCaptured { purpose: Purpose::Payment, attempt: ATTEMPT, url: &long }.encode(H, &mut buf), Err(MessageError::TooLong));
    }
}
