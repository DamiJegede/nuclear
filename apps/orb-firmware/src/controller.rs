//! The Orb's state controller (docs/ORB.md sections 4 to 10): one place that decides what the Orb does with every input. It has no hardware
//! and no clock of its own: the board layer feeds it [`Input`]s with the current time in milliseconds, and carries out the [`Actions`] it
//! returns (start or stop the NFC reader, set lights, play a clip, send a message, store something). Everything state-changing is serialised
//! through [`Controller::handle`], so payment commands, reset and recovery cannot race each other.
//!
//! Rules it enforces:
//! * **Terminal connected** means the bound terminal completed the application handshake and its authenticated heartbeat is current. A BLE
//!   link alone is nothing; Ping/Pong never extends liveness.
//! * One reader owner at a time: a payment, a lookup, a staff approval, or reset recovery.
//! * Capturing a tag is **not** payment success. Only an authenticated `PaymentStatus(Completed)` for the same attempt and session shows
//!   success; `Declined` shows failure; a timeout or cancel after capture is an unknown outcome until reconciled.
//! * A new attempt never silently replaces an unresolved one. Only the attempt id and purpose are remembered (never the credential).
//! * Reset needs USB power, no authenticated session and no unresolved attempt, checked again at the moment the card is read.

use crate::battery::{BatteryMonitor, Reading, Warning};
use crate::config::*;
use crate::feedback::{AudioClip, LightPattern};
use crate::message::*;
use crate::ndef;

pub const MAX_ACTIONS: usize = 12;

/// Who owns the NFC reader.
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum NfcRole {
    Operation(Purpose),
    Recovery,
}

/// What to remember across a reboot about an attempt whose tap was captured but whose outcome is not yet confirmed.
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub struct Unresolved {
    pub attempt: AttemptId,
    pub purpose: Purpose,
}

/// An owned copy of a tap URL (the credential), kept in volatile memory only and never logged.
#[derive(Clone, Copy)]
pub struct UrlBuf {
    len: usize,
    bytes: [u8; MAX_URL_LEN],
}
impl UrlBuf {
    pub fn from_bytes(b: &[u8]) -> Option<UrlBuf> {
        if b.len() > MAX_URL_LEN || core::str::from_utf8(b).is_err() {
            return None;
        }
        let mut bytes = [0u8; MAX_URL_LEN];
        bytes[..b.len()].copy_from_slice(b);
        Some(UrlBuf { len: b.len(), bytes })
    }
    pub fn as_str(&self) -> &str {
        core::str::from_utf8(&self.bytes[..self.len]).unwrap_or("")
    }
}
impl core::fmt::Debug for UrlBuf {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        write!(f, "UrlBuf({} bytes)", self.len)       // never prints the credential
    }
}
impl PartialEq for UrlBuf {
    fn eq(&self, o: &UrlBuf) -> bool {
        self.as_str() == o.as_str()
    }
}
impl Eq for UrlBuf {}

/// A message for the terminal. The link layer assigns the message id and the current session generation and encodes it.
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum Outgoing {
    HandshakeResult { accepted: bool, reason: Reason },
    CommandAck { of: u16, accepted: bool, reason: Reason },
    StateChanged(OrbState),
    TapCaptured { purpose: Purpose, attempt: AttemptId, url: UrlBuf },
    Battery(BatteryStatus),
    Error { reason: Reason, attempt: AttemptId },
}

impl Outgoing {
    /// Events the terminal must acknowledge (the Orb resends them with the same id until it does). Handshake results, command acknowledgements
    /// and periodic battery reports are not resent: the terminal retries those itself or the next report replaces them.
    pub fn reliable(&self) -> bool {
        matches!(self, Outgoing::StateChanged(_) | Outgoing::TapCaptured { .. } | Outgoing::Error { .. })
    }
}

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum TxPower {
    Pairing,
    Normal,
}

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum Advertising {
    /// Setup advertising at reduced power.
    Pairing,
    /// Quiet reconnect advertising for the bound terminal only.
    Bound,
    Off,
}

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum Action {
    NfcStart(NfcRole),
    NfcStop,
    Light(LightPattern),
    Audio(AudioClip),
    Send(Outgoing),
    /// Ask the board's authorizer to check the handshake proof; answer with [`Input::HandshakeVerdict`]. The proof scheme (a factory device
    /// credential plus an API-signed binding) is still to be designed: the controller only requires a yes or no.
    VerifyHandshake { kind: HandshakeKind, nonce: [u8; 16], proof: [u8; 32] },
    /// Store the binding atomically (a power loss mid-write must leave either the old or the new state).
    SaveBinding,
    /// Clear the terminal binding, BLE bonds and merchant settings; keep device identity, firmware trust material and calibration.
    ClearBinding,
    /// Store (or clear) the unresolved attempt: identifiers only.
    PersistUnresolved(Option<Unresolved>),
    SetTxPower(TxPower),
    Advertise(Advertising),
    /// Drop the connected peer (it failed the handshake or ran out of time).
    DisconnectPeer,
    SetVolume { volume: u8, muted: bool },
    /// Stop this clip if it is playing and drop it if it is queued (a reminder that no longer applies).
    StopAudio(AudioClip),
    Reboot,
}

/// A small fixed list of actions (no allocation).
#[derive(Debug, Clone, Copy)]
pub struct Actions {
    items: [Option<Action>; MAX_ACTIONS],
    len: usize,
}
impl Actions {
    pub const fn new() -> Self {
        Actions { items: [None; MAX_ACTIONS], len: 0 }
    }
    pub fn push(&mut self, a: Action) {
        if self.len < MAX_ACTIONS {
            self.items[self.len] = Some(a);
            self.len += 1;
        }
    }
    pub fn len(&self) -> usize {
        self.len
    }
    pub fn is_empty(&self) -> bool {
        self.len == 0
    }
    pub fn iter(&self) -> impl Iterator<Item = &Action> {
        self.items[..self.len].iter().filter_map(|a| a.as_ref())
    }
    pub fn contains(&self, f: impl Fn(&Action) -> bool) -> bool {
        self.iter().any(f)
    }
}
impl Default for Actions {
    fn default() -> Self {
        Self::new()
    }
}

/// What the board tells the controller.
#[derive(Debug)]
pub enum Input<'a> {
    /// Once, at power-up, with what storage holds.
    Boot { has_binding: bool, usb_power: bool, unresolved: Option<Unresolved> },
    /// USB power appeared or disappeared (this must work without a reboot).
    UsbPower(bool),
    BleConnected,
    BleDisconnected,
    /// The setup proximity gate's verdict for the current connection (see [`crate::proximity`]).
    ProximityMet(bool),
    /// A decoded message from the connected peer.
    Message { header: Header, message: Message<'a> },
    /// The board's answer to [`Action::VerifyHandshake`].
    HandshakeVerdict { accepted: bool },
    /// The NDEF message read from a tag while the reader was running.
    TagRead(&'a [u8]),
    /// The reader failed to read a tag.
    TagReadFailed(Reason),
    Battery(Reading),
    UpdateStarted,
    UpdateFinished,
    /// A controlled shutdown. `power_ok` is false when there is no energy left to play the shutdown sound.
    ShutdownRequested { power_ok: bool },
    /// The NFC reader is actually listening for the operation the controller started (the board answers [`Action::NfcStart`] with this).
    /// The payment reminder's five seconds start here, not when the command was accepted.
    ReaderReady,
    /// Time passed. Call at least every 100 ms.
    Tick,
}

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum Phase {
    Starting,
    Pairing,
    BoundDisconnected,
    ConnectedIdle,
    AwaitingTap,
    Processing,
    /// A confirmed outcome is on show (`true` = completed, `false` = declined).
    Result(bool),
    Updating,
    ShuttingDown,
}

/// The payment reminder: waits for the reader to be ready, then for five seconds, then plays once.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Reminder {
    None,
    WaitingForReader,
    At(u32),
    Done,
}

#[derive(Debug, Clone, Copy)]
struct Operation {
    purpose: Purpose,
    attempt: AttemptId,
    deadline_ms: u32,
    reminder: Reminder,
}

#[derive(Debug, Clone, Copy)]
struct SessionInfo {
    generation: u16,
    last_heartbeat_ms: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct PendingHandshake {
    kind: HandshakeKind,
}

/// The last few command results, so a retransmitted command gets the same answer instead of running twice.
#[derive(Clone, Copy)]
struct AckCache {
    entries: [Option<(u16, bool, Reason)>; 8],
    next: usize,
}
impl AckCache {
    const fn new() -> Self {
        AckCache { entries: [None; 8], next: 0 }
    }
    fn get(&self, id: u16) -> Option<(bool, Reason)> {
        self.entries.iter().flatten().find(|(i, _, _)| *i == id).map(|(_, a, r)| (*a, *r))
    }
    fn put(&mut self, id: u16, accepted: bool, reason: Reason) {
        self.entries[self.next] = Some((id, accepted, reason));
        self.next = (self.next + 1) % self.entries.len();
    }
    fn clear(&mut self) {
        *self = AckCache::new();
    }
}

pub struct Controller {
    phase: Phase,
    has_binding: bool,
    usb: bool,
    connected: bool,
    session: Option<SessionInfo>,
    next_generation: u16,
    handshake_deadline_ms: Option<u32>,
    pending_handshake: Option<PendingHandshake>,
    proximity_ok: bool,
    op: Option<Operation>,
    unresolved: Option<Unresolved>,
    // recovery polling
    recovery_started: bool,
    recovery_window_until_ms: u32,
    recovery_next_burst_ms: u32,
    recovery_burst_until_ms: Option<u32>,
    recovery_reader_on: bool,
    disconnect_announced: bool,
    result_until_ms: Option<u32>,
    light_off_at_ms: Option<u32>,
    light_override_until_ms: Option<u32>,
    battery: BatteryMonitor,
    pending_battery_warning: Option<Warning>,
    just_connected_report: bool,
    acks: AckCache,
    now_ms: u32,
}

impl Default for Controller {
    fn default() -> Self {
        Self::new()
    }
}

fn due(now: u32, at: u32) -> bool {
    (now.wrapping_sub(at) as i32) >= 0
}

impl Controller {
    pub const fn new() -> Self {
        Controller {
            phase: Phase::Starting,
            has_binding: false,
            usb: false,
            connected: false,
            session: None,
            next_generation: 1,
            handshake_deadline_ms: None,
            pending_handshake: None,
            proximity_ok: false,
            op: None,
            unresolved: None,
            recovery_started: false,
            recovery_window_until_ms: 0,
            recovery_next_burst_ms: 0,
            recovery_burst_until_ms: None,
            recovery_reader_on: false,
            disconnect_announced: false,
            result_until_ms: None,
            light_off_at_ms: None,
            light_override_until_ms: None,
            battery: BatteryMonitor::new(),
            pending_battery_warning: None,
            just_connected_report: false,
            acks: AckCache::new(),
            now_ms: 0,
        }
    }

    pub fn phase(&self) -> Phase {
        self.phase
    }
    pub fn has_binding(&self) -> bool {
        self.has_binding
    }
    /// The generation of the authenticated session, or None when no terminal is connected in the application sense.
    pub fn session_generation(&self) -> Option<u16> {
        self.session.map(|s| s.generation)
    }
    pub fn unresolved(&self) -> Option<Unresolved> {
        self.unresolved
    }
    /// Reset is allowed only with USB power, no authenticated terminal session and no unresolved payment or approval attempt.
    pub fn reset_eligible(&self) -> bool {
        self.usb && self.session.is_none() && self.unresolved.is_none() && self.op.is_none() && !matches!(self.phase, Phase::Starting | Phase::ShuttingDown | Phase::Updating)
    }

    fn orb_state(&self) -> OrbState {
        match self.phase {
            Phase::Starting => OrbState::Starting,
            Phase::Pairing => OrbState::Pairing,
            Phase::BoundDisconnected => OrbState::BoundDisconnected,
            Phase::ConnectedIdle => OrbState::ConnectedIdle,
            Phase::AwaitingTap => OrbState::AwaitingPayment,
            Phase::Processing => OrbState::Processing,
            Phase::Result(true) => OrbState::Completed,
            Phase::Result(false) => OrbState::Declined,
            Phase::Updating => OrbState::Updating,
            Phase::ShuttingDown => OrbState::ShuttingDown,
        }
    }

    fn announce_state(&self, a: &mut Actions) {
        if self.session.is_some() {
            a.push(Action::Send(Outgoing::StateChanged(self.orb_state())));
        }
    }

    /// The single entry point. Returns what the board must do.
    pub fn handle(&mut self, input: Input<'_>, now_ms: u32) -> Actions {
        self.now_ms = now_ms;
        let mut a = Actions::new();
        match input {
            Input::Boot { has_binding, usb_power, unresolved } => self.boot(has_binding, usb_power, unresolved, &mut a),
            Input::UsbPower(on) => {
                self.usb = on;
                if !on {
                    self.stop_recovery(&mut a);
                    self.recovery_started = false;
                }
            }
            Input::BleConnected => {
                self.connected = true;
                self.proximity_ok = false;
                self.handshake_deadline_ms = Some(now_ms.wrapping_add(HANDSHAKE_TIMEOUT_MS));
            }
            Input::BleDisconnected => self.ble_disconnected(&mut a),
            Input::ProximityMet(ok) => self.proximity_ok = ok,
            Input::Message { header, message } => self.message(header, message, &mut a),
            Input::HandshakeVerdict { accepted } => self.verdict(accepted, &mut a),
            Input::TagRead(ndef) => self.tag_read(ndef, &mut a),
            Input::TagReadFailed(reason) => {
                if let (Phase::AwaitingTap, Some(op)) = (self.phase, self.op) {
                    a.push(Action::Send(Outgoing::Error { reason, attempt: op.attempt }));
                }
            }
            Input::Battery(reading) => self.battery_reading(reading, &mut a),
            Input::UpdateStarted => {
                if self.phase == Phase::ConnectedIdle && self.unresolved.is_none() {
                    self.phase = Phase::Updating;
                    a.push(Action::Light(LightPattern::BlueProgress));
                    self.announce_state(&mut a);
                }
            }
            Input::UpdateFinished => {
                if self.phase == Phase::Updating {
                    self.phase = if self.session.is_some() { Phase::ConnectedIdle } else { Phase::BoundDisconnected };
                    a.push(Action::Light(LightPattern::Off));
                    self.announce_state(&mut a);
                }
            }
            Input::ShutdownRequested { power_ok } => {
                self.phase = Phase::ShuttingDown;
                a.push(Action::NfcStop);
                a.push(Action::StopAudio(AudioClip::PaymentReminder));
                a.push(Action::Light(LightPattern::Fade));
                if power_ok {
                    a.push(Action::Audio(AudioClip::Shutdown));
                }
            }
            Input::ReaderReady => {
                // The reader is really listening now: start the reminder's five seconds (once per waiting attempt).
                if let (Phase::AwaitingTap, Some(op)) = (self.phase, self.op) {
                    if op.reminder == Reminder::WaitingForReader {
                        self.op = Some(Operation { reminder: Reminder::At(now_ms.wrapping_add(PAYMENT_REMINDER_DELAY_MS)), ..op });
                    }
                }
            }
            Input::Tick => {}
        }
        self.timers(&mut a);
        self.recovery(&mut a);
        a
    }

    // ---- Boot, pairing, sessions ----------------------------------------------------------------------------------------------------

    fn boot(&mut self, has_binding: bool, usb: bool, unresolved: Option<Unresolved>, a: &mut Actions) {
        self.has_binding = has_binding;
        self.usb = usb;
        self.unresolved = unresolved;
        a.push(Action::Light(LightPattern::StartupSweep));
        a.push(Action::Audio(AudioClip::Startup));
        if has_binding {
            self.phase = Phase::BoundDisconnected;
            a.push(Action::Advertise(Advertising::Bound));
            a.push(Action::Light(LightPattern::BluePulse));
            self.light_off_at_ms = Some(self.now_ms.wrapping_add(1_500));     // a brief pulse, then dark
        } else {
            self.enter_pairing(a);
        }
    }

    /// First run, or after reset: setup power, advertising, blue breathing and the spoken prompt once.
    fn enter_pairing(&mut self, a: &mut Actions) {
        self.phase = Phase::Pairing;
        a.push(Action::SetTxPower(TxPower::Pairing));
        a.push(Action::Advertise(Advertising::Pairing));
        a.push(Action::Light(LightPattern::BlueBreathing));
        a.push(Action::Audio(AudioClip::PairingPrompt));
    }

    fn ble_disconnected(&mut self, a: &mut Actions) {
        self.connected = false;
        self.proximity_ok = false;
        self.handshake_deadline_ms = None;
        self.pending_handshake = None;
        if self.session.is_some() {
            self.end_session(a);
        }
    }

    /// The authenticated session is gone (link lost or heartbeat stale): stop what the terminal started, tell the user once, and wait for it.
    fn end_session(&mut self, a: &mut Actions) {
        self.session = None;
        self.acks.clear();
        self.light_override_until_ms = None;
        // Anything still waiting for a tap is interrupted: no tap was taken, so nothing can have been debited.
        if let (Phase::AwaitingTap, Some(_)) = (self.phase, self.op) {
            self.op = None;
            a.push(Action::NfcStop);
            a.push(Action::StopAudio(AudioClip::PaymentReminder));
        }
        // After a capture the outcome is unknown: the attempt stays unresolved and the terminal reconciles through the API.
        if self.phase == Phase::Processing {
            self.op = None;
        }
        if self.phase == Phase::Result(true) || self.phase == Phase::Result(false) {
            self.result_until_ms = None;
        }
        if self.phase != Phase::Pairing && self.phase != Phase::Updating {
            self.phase = Phase::BoundDisconnected;
        }
        if !self.disconnect_announced {
            self.disconnect_announced = true;
            a.push(Action::Audio(AudioClip::TerminalDisconnected));
        }
        a.push(Action::Light(LightPattern::BluePulse));
        self.light_off_at_ms = Some(self.now_ms.wrapping_add(1_500));
        a.push(Action::Advertise(if self.has_binding { Advertising::Bound } else { Advertising::Pairing }));
    }

    fn message(&mut self, header: Header, message: Message<'_>, a: &mut Actions) {
        // Handshake first: it is the only thing accepted without a session.
        if let Message::Handshake { kind, protocol, nonce, proof } = message {
            self.handshake_request(kind, protocol, nonce, proof, a);
            return;
        }
        let session = match self.session {
            Some(s) => s,
            None => return, // nothing but a handshake is accepted before the application session exists: not even a Ping extends anything
        };
        // A retransmitted command gets its recorded answer, not a second execution.
        if let Some((accepted, reason)) = self.acks.get(header.msg_id) {
            a.push(Action::Send(Outgoing::CommandAck { of: header.msg_id, accepted, reason }));
            return;
        }
        if header.session != session.generation {
            self.ack(header.msg_id, false, Reason::StaleSession, a);
            return;
        }
        match message {
            Message::Heartbeat { .. } => {
                if let Some(s) = self.session.as_mut() {
                    s.last_heartbeat_ms = self.now_ms;
                }
            }
            Message::BeginPayment { attempt, timeout_s, .. } => self.begin(header.msg_id, Purpose::Payment, attempt, timeout_s, a),
            Message::BeginRead { purpose, attempt, timeout_s } => self.begin(header.msg_id, purpose, attempt, timeout_s, a),
            Message::Cancel { attempt } => self.cancel(header.msg_id, attempt, a),
            Message::PaymentStatus { attempt, outcome } => self.payment_status(header.msg_id, attempt, outcome, a),
            Message::GetStatus => {
                self.ack(header.msg_id, true, Reason::Ok, a);
                self.announce_state(a);
            }
            Message::Configure { volume, muted } => {
                if volume > 100 {
                    self.ack(header.msg_id, false, Reason::BadRequest, a);
                } else {
                    a.push(Action::SetVolume { volume, muted });
                    self.ack(header.msg_id, true, Reason::Ok, a);
                }
            }
            Message::SetLightMode { mode, duration_s } => self.set_light(header.msg_id, mode, duration_s, a),
            // An acknowledgement of an Orb event belongs to the link layer's outbox; it is not a command and is never itself acknowledged.
            Message::EventAck { .. } => {}
            // Orb-to-terminal messages are never valid coming the other way.
            _ => self.ack(header.msg_id, false, Reason::Unsupported, a),
        }
    }

    fn ack(&mut self, of: u16, accepted: bool, reason: Reason, a: &mut Actions) {
        self.acks.put(of, accepted, reason);
        a.push(Action::Send(Outgoing::CommandAck { of, accepted, reason }));
    }

    fn handshake_request(&mut self, kind: HandshakeKind, protocol: u8, nonce: [u8; 16], proof: [u8; 32], a: &mut Actions) {
        if self.session.is_some() || self.pending_handshake.is_some() {
            return; // a session or a check is already in progress
        }
        let fail = |a: &mut Actions, reason: Reason, sound: bool| {
            a.push(Action::Send(Outgoing::HandshakeResult { accepted: false, reason }));
            if sound {
                a.push(Action::Audio(AudioClip::PairingFailed));
            }
            a.push(Action::DisconnectPeer);
        };
        if protocol != PROTOCOL_VERSION {
            return fail(a, Reason::Unsupported, kind == HandshakeKind::Bind && self.phase == Phase::Pairing);
        }
        match (self.phase, kind) {
            (Phase::Pairing, HandshakeKind::Bind) => {
                if !self.proximity_ok {
                    return fail(a, Reason::ProximityNotMet, true);
                }
            }
            (Phase::BoundDisconnected, HandshakeKind::Resume) => {}
            // A bound Orb refuses a new bind (a replacement terminal needs an authorized rebind or the physical reset), and an unbound Orb
            // cannot resume anything.
            _ => return fail(a, Reason::Unauthorized, false),
        }
        self.pending_handshake = Some(PendingHandshake { kind });
        a.push(Action::VerifyHandshake { kind, nonce, proof });
    }

    fn verdict(&mut self, accepted: bool, a: &mut Actions) {
        let pending = match self.pending_handshake.take() {
            Some(p) => p,
            None => return,
        };
        if !accepted {
            a.push(Action::Send(Outgoing::HandshakeResult { accepted: false, reason: Reason::Unauthorized }));
            if pending.kind == HandshakeKind::Bind {
                a.push(Action::Audio(AudioClip::PairingFailed));
            }
            a.push(Action::DisconnectPeer);
            return;
        }
        let generation = self.next_generation;
        self.next_generation = if generation == u16::MAX { 1 } else { generation + 1 };
        self.session = Some(SessionInfo { generation, last_heartbeat_ms: self.now_ms });
        self.handshake_deadline_ms = None;
        self.disconnect_announced = false;
        self.just_connected_report = true;
        self.acks.clear();
        self.stop_recovery(a);                                    // a connected terminal stops recovery polling at once
        a.push(Action::Send(Outgoing::HandshakeResult { accepted: true, reason: Reason::Ok }));
        if pending.kind == HandshakeKind::Bind {
            self.has_binding = true;
            a.push(Action::SaveBinding);
            a.push(Action::SetTxPower(TxPower::Normal));          // normal range returns after pairing
            a.push(Action::Audio(AudioClip::PairingSuccessful));
        }
        self.phase = Phase::ConnectedIdle;
        a.push(Action::Light(LightPattern::Off));
        self.light_off_at_ms = None;
        self.announce_state(a);
    }

    // ---- Operations -----------------------------------------------------------------------------------------------------------------

    fn begin(&mut self, id: u16, purpose: Purpose, attempt: AttemptId, timeout_s: u8, a: &mut Actions) {
        if self.unresolved.is_some() {
            return self.ack(id, false, Reason::UnresolvedAttempt, a);
        }
        if self.phase != Phase::ConnectedIdle {
            let reason = if self.phase == Phase::Updating { Reason::Busy } else if self.session.is_none() { Reason::NotConnected } else { Reason::Busy };
            return self.ack(id, false, reason, a);
        }
        let limit = if timeout_s == 0 { SCAN_TIMEOUT_MS } else { (u32::from(timeout_s) * 1_000).min(120_000) };
        self.light_override_until_ms = None;                      // a payment has priority over an emergency or identify light
        self.op = Some(Operation {
            purpose,
            attempt,
            deadline_ms: self.now_ms.wrapping_add(limit),
            reminder: if purpose == Purpose::Payment { Reminder::WaitingForReader } else { Reminder::None },
        });
        self.phase = Phase::AwaitingTap;
        self.ack(id, true, Reason::Ok, a);
        a.push(Action::NfcStart(NfcRole::Operation(purpose)));
        a.push(Action::Light(LightPattern::OrangeArc));
        self.announce_state(a);
    }

    fn cancel(&mut self, id: u16, attempt: AttemptId, a: &mut Actions) {
        match (self.phase, self.op) {
            (Phase::AwaitingTap, Some(op)) if op.attempt == attempt => {
                self.op = None;
                self.phase = Phase::ConnectedIdle;
                self.ack(id, true, Reason::Ok, a);
                a.push(Action::NfcStop);
                a.push(Action::StopAudio(AudioClip::PaymentReminder));
                a.push(Action::Light(LightPattern::Off));
                self.announce_state(a);
            }
            // Cancelling the reader never cancels or reverses an API transaction: after capture the outcome is only the terminal's to report.
            (Phase::Processing, Some(op)) if op.attempt == attempt => self.ack(id, false, Reason::AlreadyCaptured, a),
            _ => self.ack(id, false, Reason::StaleAttempt, a),
        }
    }

    fn tag_read(&mut self, ndef_msg: &[u8], a: &mut Actions) {
        // Reset recovery: only when no operation owns the reader, and eligibility is checked again right now.
        if self.op.is_none() && self.recovery_reader_on {
            if ndef::is_reset_card(ndef_msg) && self.reset_eligible() {
                self.recovery_reader_on = false;
                self.recovery_started = false;
                a.push(Action::NfcStop);
                a.push(Action::ClearBinding);
                self.has_binding = false;
                self.pending_handshake = None;
                a.push(Action::Reboot);                            // the next boot has no binding and enters first-run pairing
            }
            return;
        }
        let op = match (self.phase, self.op) {
            (Phase::AwaitingTap, Some(op)) => op,
            _ => return,
        };
        let mut buf = [0u8; MAX_URL_LEN];
        let url = match ndef::uri_from_ndef(ndef_msg, &mut buf) {
            Ok(n) => UrlBuf::from_bytes(&buf[..n]),
            Err(_) => None,
        };
        let url = match url {
            Some(u) => u,
            None => {
                // Not a payment URL (the reset card included: during a payment it is neither a reset nor a credential).
                a.push(Action::Send(Outgoing::Error { reason: Reason::Unreadable, attempt: op.attempt }));
                return;
            }
        };
        a.push(Action::NfcStop);
        a.push(Action::StopAudio(AudioClip::PaymentReminder));       // a waiting or playing reminder never outlives the tap
        a.push(Action::Audio(AudioClip::ScanNotification));
        a.push(Action::Send(Outgoing::TapCaptured { purpose: op.purpose, attempt: op.attempt, url }));
        match op.purpose {
            Purpose::Lookup => {
                // A lookup is not a payment: the Orb is free again straight away.
                self.op = None;
                self.phase = Phase::ConnectedIdle;
                a.push(Action::Light(LightPattern::Off));
            }
            Purpose::Payment | Purpose::Staff => {
                let u = Unresolved { attempt: op.attempt, purpose: op.purpose };
                self.unresolved = Some(u);
                a.push(Action::PersistUnresolved(Some(u)));
                self.op = Some(Operation { reminder: Reminder::Done, ..op });
                self.phase = Phase::Processing;
                a.push(Action::Light(LightPattern::OrangePulse));
            }
        }
        self.announce_state(a);
    }

    fn payment_status(&mut self, id: u16, attempt: AttemptId, outcome: PaymentOutcome, a: &mut Actions) {
        let live = matches!((self.phase, self.op), (Phase::Processing, Some(op)) if op.attempt == attempt);
        let pending = self.unresolved.map(|u| u.attempt == attempt).unwrap_or(false);
        if !live && !pending {
            return self.ack(id, false, Reason::StaleAttempt, a);
        }
        match outcome {
            // Still working, or the terminal does not know yet: nothing to show, the attempt stays unresolved.
            PaymentOutcome::Processing | PaymentOutcome::Unknown => self.ack(id, true, Reason::Ok, a),
            PaymentOutcome::Completed | PaymentOutcome::Declined => {
                let ok = outcome == PaymentOutcome::Completed;
                self.unresolved = None;
                a.push(Action::PersistUnresolved(None));
                self.ack(id, true, Reason::Ok, a);
                if live {
                    self.op = None;
                    self.phase = Phase::Result(ok);
                    self.result_until_ms = Some(self.now_ms.wrapping_add(RESULT_DISPLAY_MS));
                    if ok {
                        a.push(Action::Light(LightPattern::GreenSweep));
                        a.push(Action::Audio(AudioClip::SuccessNotification));
                    } else {
                        a.push(Action::Light(LightPattern::RedDoublePulse));
                        a.push(Action::Audio(AudioClip::FailureNotification));
                    }
                } else if self.phase == Phase::ConnectedIdle {
                    // Reconciling an old attempt after a reconnect or a reboot: settle it quietly. An old success is never replayed.
                    self.op = None;
                }
                self.announce_state(a);
            }
        }
    }

    fn set_light(&mut self, id: u16, mode: LightMode, duration_s: u16, a: &mut Actions) {
        if self.phase != Phase::ConnectedIdle {
            return self.ack(id, false, Reason::Busy, a);
        }
        match mode {
            LightMode::Normal => {
                self.light_override_until_ms = None;
                a.push(Action::Light(LightPattern::Off));
            }
            LightMode::Identify | LightMode::Emergency => {
                let max = if mode == LightMode::Emergency { EMERGENCY_LIGHT_MAX_MS } else { IDENTIFY_LIGHT_MAX_MS };
                let want = if duration_s == 0 { max } else { (u32::from(duration_s) * 1_000).min(max) };
                self.light_override_until_ms = Some(self.now_ms.wrapping_add(want));
                a.push(Action::Light(if mode == LightMode::Emergency { LightPattern::Emergency } else { LightPattern::Identify }));
            }
        }
        self.ack(id, true, Reason::Ok, a);
    }

    // ---- Battery --------------------------------------------------------------------------------------------------------------------

    fn battery_reading(&mut self, r: Reading, a: &mut Actions) {
        let (status, warning) = self.battery.update(r);
        if let Some(w) = warning {
            let busy = matches!(self.phase, Phase::AwaitingTap | Phase::Processing | Phase::Result(_) | Phase::Starting);
            if busy {
                self.pending_battery_warning = Some(w);          // never obscure or interrupt a payment: announce when idle
            } else if self.phase == Phase::ConnectedIdle {
                a.push(Action::Audio(AudioClip::BatteryLow));
            }
        }
        if self.session.is_some() {
            let just = self.just_connected_report;
            if self.battery.should_report(status, warning, self.now_ms, just) {
                self.just_connected_report = false;
                a.push(Action::Send(Outgoing::Battery(status)));
            }
        }
    }

    // ---- Timers and recovery --------------------------------------------------------------------------------------------------------

    fn timers(&mut self, a: &mut Actions) {
        let now = self.now_ms;
        if let Some(d) = self.handshake_deadline_ms {
            if self.session.is_none() && due(now, d) {
                self.handshake_deadline_ms = None;
                self.pending_handshake = None;
                a.push(Action::DisconnectPeer);                 // an unauthenticated peer cannot occupy the link forever
            }
        }
        if let Some(s) = self.session {
            if now.wrapping_sub(s.last_heartbeat_ms) >= TERMINAL_HEARTBEAT_TIMEOUT_MS && self.connected_or_stale() {
                self.end_session(a);
            }
        }
        if let (Phase::AwaitingTap, Some(op)) = (self.phase, self.op) {
            if due(now, op.deadline_ms) {
                // Nothing was captured: stop the reader, say so, and do not suggest a debit.
                self.op = None;
                self.phase = Phase::ConnectedIdle;
                a.push(Action::NfcStop);
                a.push(Action::StopAudio(AudioClip::PaymentReminder));
                a.push(Action::Light(LightPattern::Off));
                a.push(Action::Send(Outgoing::Error { reason: Reason::Timeout, attempt: op.attempt }));
                self.announce_state(a);
            } else if let Reminder::At(r) = op.reminder {
                if due(now, r) {
                    self.op = Some(Operation { reminder: Reminder::Done, ..op });   // once per waiting attempt
                    a.push(Action::Audio(AudioClip::PaymentReminder));
                }
            }
        }
        if let Some(until) = self.result_until_ms {
            if matches!(self.phase, Phase::Result(_)) && due(now, until) {
                self.result_until_ms = None;
                self.phase = Phase::ConnectedIdle;
                a.push(Action::Light(LightPattern::Off));
                self.announce_state(a);
                if self.pending_battery_warning.take().is_some() {
                    a.push(Action::Audio(AudioClip::BatteryLow));
                }
            }
        }
        if let Some(t) = self.light_off_at_ms {
            if due(now, t) {
                self.light_off_at_ms = None;
                if matches!(self.phase, Phase::BoundDisconnected) {
                    a.push(Action::Light(LightPattern::Off));
                }
            }
        }
        if let Some(t) = self.light_override_until_ms {
            if due(now, t) {
                self.light_override_until_ms = None;
                if self.phase == Phase::ConnectedIdle {
                    a.push(Action::Light(LightPattern::Off));
                }
            }
        }
    }

    fn connected_or_stale(&self) -> bool {
        true
    }

    fn stop_recovery(&mut self, a: &mut Actions) {
        if self.recovery_reader_on {
            self.recovery_reader_on = false;
            a.push(Action::NfcStop);
        }
        self.recovery_burst_until_ms = None;
    }

    /// USB-power recovery polling: a window of continuous discovery after power appears, then short bursts with the field off between them.
    /// Only while the Orb is eligible; a connected terminal or a payment stops it at once. Never a continuous full-power field.
    fn recovery(&mut self, a: &mut Actions) {
        let now = self.now_ms;
        if !self.reset_eligible() {
            self.stop_recovery(a);
            return;
        }
        if !self.recovery_started {
            self.recovery_started = true;
            self.recovery_window_until_ms = now.wrapping_add(USB_RECOVERY_WINDOW_MS);
            self.recovery_next_burst_ms = self.recovery_window_until_ms;
            self.recovery_reader_on = true;
            a.push(Action::NfcStart(NfcRole::Recovery));
            return;
        }
        let in_window = !due(now, self.recovery_window_until_ms);
        if in_window {
            if !self.recovery_reader_on {
                self.recovery_reader_on = true;
                a.push(Action::NfcStart(NfcRole::Recovery));
            }
            return;
        }
        // After the window: bursts.
        if self.recovery_reader_on {
            let end = self.recovery_burst_until_ms.unwrap_or(self.recovery_window_until_ms);
            if due(now, end) {
                self.recovery_reader_on = false;
                self.recovery_burst_until_ms = None;
                self.recovery_next_burst_ms = now.wrapping_add(RECOVERY_POLL_INTERVAL_MS);
                a.push(Action::NfcStop);
            }
        } else if due(now, self.recovery_next_burst_ms) {
            self.recovery_reader_on = true;
            self.recovery_burst_until_ms = Some(now.wrapping_add(RECOVERY_SCAN_BURST_MS));
            a.push(Action::NfcStart(NfcRole::Recovery));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const A1: AttemptId = [1; 16];
    const A2: AttemptId = [2; 16];

    fn hdr(id: u16, session: u16) -> Header {
        Header { msg_id: id, session }
    }

    fn boot(bound: bool, usb: bool) -> (Controller, Actions) {
        let mut c = Controller::new();
        let a = c.handle(Input::Boot { has_binding: bound, usb_power: usb, unresolved: None }, 0);
        (c, a)
    }

    fn connect(c: &mut Controller, kind: HandshakeKind, t: u32) -> u16 {
        c.handle(Input::BleConnected, t);
        c.handle(Input::ProximityMet(true), t);
        let a = c.handle(Input::Message { header: hdr(1, 0), message: Message::Handshake { kind, protocol: PROTOCOL_VERSION, nonce: [0; 16], proof: [0; 32] } }, t);
        assert!(a.contains(|x| matches!(x, Action::VerifyHandshake { .. })));
        c.handle(Input::HandshakeVerdict { accepted: true }, t);
        c.session_generation().expect("session")
    }

    fn begin(c: &mut Controller, g: u16, id: u16, attempt: AttemptId, t: u32) -> Actions {
        c.handle(Input::Message { header: hdr(id, g), message: Message::BeginPayment { attempt, amount_cents: 100, currency: *b"USD", timeout_s: 0 } }, t)
    }

    fn url_ndef(buf: &mut [u8; 128]) -> usize {
        let url = b"nuclear.example/v1/abcdef";
        // NDEF short record: type U, prefix 0 (none)
        let n = 1 + url.len();
        buf[0] = 0xD1;
        buf[1] = 1;
        buf[2] = n as u8;
        buf[3] = b'U';
        buf[4] = 0;
        buf[5..5 + url.len()].copy_from_slice(url);
        5 + url.len()
    }

    #[test]
    fn first_boot_enters_pairing() {
        let (c, a) = boot(false, false);
        assert_eq!(c.phase(), Phase::Pairing);
        assert!(a.contains(|x| *x == Action::Advertise(Advertising::Pairing)));
        assert!(a.contains(|x| *x == Action::Audio(AudioClip::PairingPrompt)));
    }

    #[test]
    fn bound_boot_is_quiet() {
        let (c, a) = boot(true, false);
        assert_eq!(c.phase(), Phase::BoundDisconnected);
        assert!(a.contains(|x| *x == Action::Advertise(Advertising::Bound)));
        assert!(!a.contains(|x| *x == Action::Audio(AudioClip::PairingPrompt)));
    }

    #[test]
    fn bind_needs_proximity() {
        let (mut c, _) = boot(false, false);
        c.handle(Input::BleConnected, 10);
        let a = c.handle(Input::Message { header: hdr(1, 0), message: Message::Handshake { kind: HandshakeKind::Bind, protocol: PROTOCOL_VERSION, nonce: [0; 16], proof: [0; 32] } }, 20);
        assert!(a.contains(|x| *x == Action::DisconnectPeer));
        assert!(c.session_generation().is_none());
    }

    #[test]
    fn bind_succeeds_and_saves() {
        let (mut c, _) = boot(false, false);
        c.handle(Input::BleConnected, 10);
        c.handle(Input::ProximityMet(true), 11);
        c.handle(Input::Message { header: hdr(1, 0), message: Message::Handshake { kind: HandshakeKind::Bind, protocol: PROTOCOL_VERSION, nonce: [0; 16], proof: [0; 32] } }, 20);
        let a = c.handle(Input::HandshakeVerdict { accepted: true }, 30);
        assert!(a.contains(|x| *x == Action::SaveBinding));
        assert!(a.contains(|x| *x == Action::Audio(AudioClip::PairingSuccessful)));
        assert_eq!(c.phase(), Phase::ConnectedIdle);
        assert!(c.has_binding());
    }

    #[test]
    fn rejected_proof_disconnects() {
        let (mut c, _) = boot(true, false);
        c.handle(Input::BleConnected, 10);
        c.handle(Input::Message { header: hdr(1, 0), message: Message::Handshake { kind: HandshakeKind::Resume, protocol: PROTOCOL_VERSION, nonce: [0; 16], proof: [0; 32] } }, 20);
        let a = c.handle(Input::HandshakeVerdict { accepted: false }, 30);
        assert!(a.contains(|x| *x == Action::DisconnectPeer));
        assert!(c.session_generation().is_none());
    }

    #[test]
    fn bound_orb_refuses_a_new_bind() {
        let (mut c, _) = boot(true, false);
        c.handle(Input::BleConnected, 10);
        c.handle(Input::ProximityMet(true), 11);
        let a = c.handle(Input::Message { header: hdr(1, 0), message: Message::Handshake { kind: HandshakeKind::Bind, protocol: PROTOCOL_VERSION, nonce: [0; 16], proof: [0; 32] } }, 20);
        assert!(a.contains(|x| *x == Action::DisconnectPeer));
    }

    #[test]
    fn silent_peer_is_dropped() {
        let (mut c, _) = boot(true, false);
        c.handle(Input::BleConnected, 0);
        let a = c.handle(Input::Tick, HANDSHAKE_TIMEOUT_MS + 1);
        assert!(a.contains(|x| *x == Action::DisconnectPeer));
    }

    #[test]
    fn heartbeat_only_from_authenticated_session() {
        let (mut c, _) = boot(true, false);
        c.handle(Input::BleConnected, 0);
        c.handle(Input::Message { header: hdr(5, 0), message: Message::Heartbeat { counter: 1 } }, 100);
        assert!(c.session_generation().is_none());
    }

    #[test]
    fn payment_flow_completes_only_on_authenticated_status() {
        let (mut c, _) = boot(true, false);
        let g = connect(&mut c, HandshakeKind::Resume, 100);
        let a = begin(&mut c, g, 10, A1, 200);
        assert_eq!(c.phase(), Phase::AwaitingTap);
        assert!(a.contains(|x| matches!(x, Action::NfcStart(NfcRole::Operation(Purpose::Payment)))));
        let mut buf = [0u8; 128];
        let n = url_ndef(&mut buf);
        let a = c.handle(Input::TagRead(&buf[..n]), 300);
        assert_eq!(c.phase(), Phase::Processing);
        assert!(a.contains(|x| matches!(x, Action::Send(Outgoing::TapCaptured { .. }))));
        assert!(a.contains(|x| matches!(x, Action::PersistUnresolved(Some(_)))));
        assert!(!a.contains(|x| *x == Action::Audio(AudioClip::SuccessNotification)));
        let a = c.handle(Input::Message { header: hdr(11, g), message: Message::PaymentStatus { attempt: A1, outcome: PaymentOutcome::Completed } }, 400);
        assert_eq!(c.phase(), Phase::Result(true));
        assert!(a.contains(|x| *x == Action::Audio(AudioClip::SuccessNotification)));
        assert!(a.contains(|x| *x == Action::PersistUnresolved(None)));
        assert!(c.unresolved().is_none());
        c.handle(Input::Tick, 400 + RESULT_DISPLAY_MS);
        assert_eq!(c.phase(), Phase::ConnectedIdle);
    }

    #[test]
    fn declined_shows_failure() {
        let (mut c, _) = boot(true, false);
        let g = connect(&mut c, HandshakeKind::Resume, 0);
        begin(&mut c, g, 10, A1, 10);
        let mut buf = [0u8; 128];
        let n = url_ndef(&mut buf);
        c.handle(Input::TagRead(&buf[..n]), 20);
        let a = c.handle(Input::Message { header: hdr(11, g), message: Message::PaymentStatus { attempt: A1, outcome: PaymentOutcome::Declined } }, 30);
        assert!(a.contains(|x| *x == Action::Audio(AudioClip::FailureNotification)));
        assert_eq!(c.phase(), Phase::Result(false));
    }

    #[test]
    fn status_for_another_attempt_is_stale() {
        let (mut c, _) = boot(true, false);
        let g = connect(&mut c, HandshakeKind::Resume, 0);
        begin(&mut c, g, 10, A1, 10);
        let mut buf = [0u8; 128];
        let n = url_ndef(&mut buf);
        c.handle(Input::TagRead(&buf[..n]), 20);
        let a = c.handle(Input::Message { header: hdr(11, g), message: Message::PaymentStatus { attempt: A2, outcome: PaymentOutcome::Completed } }, 30);
        assert!(a.contains(|x| matches!(x, Action::Send(Outgoing::CommandAck { accepted: false, reason: Reason::StaleAttempt, .. }))));
        assert_eq!(c.phase(), Phase::Processing);
    }

    #[test]
    fn unresolved_attempt_blocks_a_new_one() {
        let (mut c, _) = boot(true, false);
        let g = connect(&mut c, HandshakeKind::Resume, 0);
        begin(&mut c, g, 10, A1, 10);
        let mut buf = [0u8; 128];
        let n = url_ndef(&mut buf);
        c.handle(Input::TagRead(&buf[..n]), 20);
        let a = begin(&mut c, g, 12, A2, 30);
        assert!(a.contains(|x| matches!(x, Action::Send(Outgoing::CommandAck { accepted: false, reason: Reason::UnresolvedAttempt, .. }))));
    }

    #[test]
    fn unknown_outcome_keeps_the_attempt_unresolved() {
        let (mut c, _) = boot(true, false);
        let g = connect(&mut c, HandshakeKind::Resume, 0);
        begin(&mut c, g, 10, A1, 10);
        let mut buf = [0u8; 128];
        let n = url_ndef(&mut buf);
        c.handle(Input::TagRead(&buf[..n]), 20);
        c.handle(Input::Message { header: hdr(11, g), message: Message::PaymentStatus { attempt: A1, outcome: PaymentOutcome::Unknown } }, 30);
        assert!(c.unresolved().is_some());
        assert_eq!(c.phase(), Phase::Processing);
    }

    #[test]
    fn cancel_before_tap_returns_to_idle_and_after_tap_is_refused() {
        let (mut c, _) = boot(true, false);
        let g = connect(&mut c, HandshakeKind::Resume, 0);
        begin(&mut c, g, 10, A1, 10);
        let a = c.handle(Input::Message { header: hdr(11, g), message: Message::Cancel { attempt: A1 } }, 20);
        assert!(a.contains(|x| *x == Action::NfcStop));
        assert_eq!(c.phase(), Phase::ConnectedIdle);
        begin(&mut c, g, 12, A2, 30);
        let mut buf = [0u8; 128];
        let n = url_ndef(&mut buf);
        c.handle(Input::TagRead(&buf[..n]), 40);
        let a = c.handle(Input::Message { header: hdr(13, g), message: Message::Cancel { attempt: A2 } }, 50);
        assert!(a.contains(|x| matches!(x, Action::Send(Outgoing::CommandAck { accepted: false, reason: Reason::AlreadyCaptured, .. }))));
    }

    #[test]
    fn retransmitted_command_runs_once() {
        let (mut c, _) = boot(true, false);
        let g = connect(&mut c, HandshakeKind::Resume, 0);
        let first = begin(&mut c, g, 10, A1, 10);
        assert!(first.contains(|x| matches!(x, Action::NfcStart(_))));
        let again = begin(&mut c, g, 10, A1, 20);
        assert!(!again.contains(|x| matches!(x, Action::NfcStart(_))));
        assert!(again.contains(|x| matches!(x, Action::Send(Outgoing::CommandAck { of: 10, accepted: true, .. }))));
    }

    #[test]
    fn stale_session_generation_is_refused() {
        let (mut c, _) = boot(true, false);
        let g = connect(&mut c, HandshakeKind::Resume, 0);
        let a = begin(&mut c, g.wrapping_add(1), 10, A1, 10);
        assert!(a.contains(|x| matches!(x, Action::Send(Outgoing::CommandAck { accepted: false, reason: Reason::StaleSession, .. }))));
        assert_eq!(c.phase(), Phase::ConnectedIdle);
    }

    #[test]
    fn scan_timeout_before_tap_stops_the_reader() {
        let (mut c, _) = boot(true, false);
        let g = connect(&mut c, HandshakeKind::Resume, 0);
        c.handle(Input::Message { header: hdr(10, g), message: Message::Heartbeat { counter: 1 } }, 1);
        begin(&mut c, g, 11, A1, 2);
        let mut t = 2;
        let mut stopped = false;
        while t < SCAN_TIMEOUT_MS + 3_000 {
            t += 1_000;
            let a = c.handle(Input::Message { header: hdr(100 + (t / 1000) as u16, g), message: Message::Heartbeat { counter: 1 } }, t);
            if a.contains(|x| matches!(x, Action::Send(Outgoing::Error { reason: Reason::Timeout, .. }))) {
                stopped = true;
                assert!(a.contains(|x| *x == Action::NfcStop));
                break;
            }
        }
        assert!(stopped);
        assert_eq!(c.phase(), Phase::ConnectedIdle);
    }

    #[test]
    fn stale_heartbeat_ends_the_session_and_interrupts_waiting() {
        let (mut c, _) = boot(true, false);
        let g = connect(&mut c, HandshakeKind::Resume, 0);
        begin(&mut c, g, 10, A1, 10);
        let a = c.handle(Input::Tick, TERMINAL_HEARTBEAT_TIMEOUT_MS + 50);
        assert!(c.session_generation().is_none());
        assert!(a.contains(|x| *x == Action::NfcStop));
        assert!(a.contains(|x| *x == Action::Audio(AudioClip::TerminalDisconnected)));
        assert_eq!(c.phase(), Phase::BoundDisconnected);
    }

    #[test]
    fn disconnect_after_capture_keeps_attempt_unresolved() {
        let (mut c, _) = boot(true, false);
        let g = connect(&mut c, HandshakeKind::Resume, 0);
        begin(&mut c, g, 10, A1, 10);
        let mut buf = [0u8; 128];
        let n = url_ndef(&mut buf);
        c.handle(Input::TagRead(&buf[..n]), 20);
        c.handle(Input::BleDisconnected, 30);
        assert!(c.unresolved().is_some());
        assert_eq!(c.phase(), Phase::BoundDisconnected);
    }

    #[test]
    fn disconnect_sound_plays_once() {
        let (mut c, _) = boot(true, false);
        let g = connect(&mut c, HandshakeKind::Resume, 0);
        let _ = g;
        let a = c.handle(Input::BleDisconnected, 10);
        assert!(a.contains(|x| *x == Action::Audio(AudioClip::TerminalDisconnected)));
        let a = c.handle(Input::Tick, 20);
        assert!(!a.contains(|x| *x == Action::Audio(AudioClip::TerminalDisconnected)));
    }

    #[test]
    fn lookup_frees_the_orb_and_leaves_nothing_unresolved() {
        let (mut c, _) = boot(true, false);
        let g = connect(&mut c, HandshakeKind::Resume, 0);
        c.handle(Input::Message { header: hdr(10, g), message: Message::BeginRead { purpose: Purpose::Lookup, attempt: A1, timeout_s: 0 } }, 10);
        let mut buf = [0u8; 128];
        let n = url_ndef(&mut buf);
        c.handle(Input::TagRead(&buf[..n]), 20);
        assert_eq!(c.phase(), Phase::ConnectedIdle);
        assert!(c.unresolved().is_none());
    }

    #[test]
    fn non_url_tag_is_not_a_credential() {
        let (mut c, _) = boot(true, false);
        let g = connect(&mut c, HandshakeKind::Resume, 0);
        begin(&mut c, g, 10, A1, 10);
        let a = c.handle(Input::TagRead(&[0x00, 0x01, 0x02]), 20);
        assert!(a.contains(|x| matches!(x, Action::Send(Outgoing::Error { reason: Reason::Unreadable, .. }))));
        assert_eq!(c.phase(), Phase::AwaitingTap);
    }

    #[test]
    fn debug_never_prints_the_credential() {
        let u = UrlBuf::from_bytes(b"secret-url").unwrap();
        assert!(!format!("{:?}", u).contains("secret"));
    }

    // ---- reset ----

    fn reset_card(buf: &mut [u8; 64]) -> usize {
        let text = b"SAY_GOODBYE";
        let n = 1 + 2 + text.len();
        buf[0] = 0xD1;
        buf[1] = 1;
        buf[2] = n as u8;
        buf[3] = b'T';
        buf[4] = 2;
        buf[5] = b'e';
        buf[6] = b'n';
        buf[7..7 + text.len()].copy_from_slice(text);
        7 + text.len()
    }

    #[test]
    fn reset_needs_usb_power() {
        let (mut c, a) = boot(true, false);
        assert!(!a.contains(|x| matches!(x, Action::NfcStart(NfcRole::Recovery))));
        let a = c.handle(Input::Tick, 100);
        assert!(!a.contains(|x| matches!(x, Action::NfcStart(NfcRole::Recovery))));
        assert!(!c.reset_eligible());
    }

    #[test]
    fn reset_card_clears_binding_when_eligible() {
        let (mut c, a) = boot(true, true);
        assert!(a.contains(|x| matches!(x, Action::NfcStart(NfcRole::Recovery))));
        let mut buf = [0u8; 64];
        let n = reset_card(&mut buf);
        let a = c.handle(Input::TagRead(&buf[..n]), 50);
        assert!(a.contains(|x| *x == Action::ClearBinding));
        assert!(a.contains(|x| *x == Action::Reboot));
        assert!(!c.has_binding());
    }

    #[test]
    fn reset_refused_with_an_unresolved_attempt() {
        let mut c = Controller::new();
        let a = c.handle(Input::Boot { has_binding: true, usb_power: true, unresolved: Some(Unresolved { attempt: A1, purpose: Purpose::Payment }) }, 0);
        assert!(!a.contains(|x| matches!(x, Action::NfcStart(NfcRole::Recovery))));
        assert!(!c.reset_eligible());
    }

    #[test]
    fn connected_terminal_stops_recovery_and_blocks_reset() {
        let (mut c, _) = boot(true, true);
        c.handle(Input::BleConnected, 10);
        c.handle(Input::Message { header: hdr(1, 0), message: Message::Handshake { kind: HandshakeKind::Resume, protocol: PROTOCOL_VERSION, nonce: [0; 16], proof: [0; 32] } }, 20);
        let a = c.handle(Input::HandshakeVerdict { accepted: true }, 30);
        assert!(a.contains(|x| *x == Action::NfcStop));
        let mut buf = [0u8; 64];
        let n = reset_card(&mut buf);
        let a = c.handle(Input::TagRead(&buf[..n]), 40);
        assert!(!a.contains(|x| *x == Action::ClearBinding));
        assert!(c.has_binding());
    }

    #[test]
    fn unplugging_usb_stops_recovery_polling() {
        let (mut c, _) = boot(true, true);
        let a = c.handle(Input::UsbPower(false), 10);
        assert!(a.contains(|x| *x == Action::NfcStop));
    }

    #[test]
    fn recovery_uses_bursts_after_the_window() {
        let (mut c, _) = boot(true, true);
        let a = c.handle(Input::Tick, USB_RECOVERY_WINDOW_MS + 1);
        assert!(a.contains(|x| *x == Action::NfcStop) || !a.contains(|x| matches!(x, Action::NfcStart(_))));
        let mut starts = 0;
        let mut stops = 0;
        let mut t = USB_RECOVERY_WINDOW_MS + 1;
        for _ in 0..200 {
            t += 100;
            let a = c.handle(Input::Tick, t);
            starts += a.iter().filter(|x| matches!(x, Action::NfcStart(_))).count();
            stops += a.iter().filter(|x| **x == Action::NfcStop).count();
        }
        assert!(starts >= 1 && stops >= 1);
    }

    #[test]
    fn reset_card_during_payment_is_not_a_reset() {
        let (mut c, _) = boot(true, true);
        let g = connect(&mut c, HandshakeKind::Resume, 0);
        begin(&mut c, g, 10, A1, 10);
        let mut buf = [0u8; 64];
        let n = reset_card(&mut buf);
        let a = c.handle(Input::TagRead(&buf[..n]), 20);
        assert!(!a.contains(|x| *x == Action::ClearBinding));
        assert_eq!(c.phase(), Phase::AwaitingTap);
    }

    // ---- other ----

    #[test]
    fn battery_warning_waits_for_idle() {
        let (mut c, _) = boot(true, false);
        let g = connect(&mut c, HandshakeKind::Resume, 0);
        begin(&mut c, g, 10, A1, 10);
        let a = c.handle(Input::Battery(Reading { percent: Some(3), millivolts: 3_000, charging: false, external_power: false, temperature_c: Some(20) }), 20);
        assert!(!a.contains(|x| *x == Action::Audio(AudioClip::BatteryLow)));
    }

    #[test]
    fn emergency_light_yields_to_a_payment() {
        let (mut c, _) = boot(true, false);
        let g = connect(&mut c, HandshakeKind::Resume, 0);
        c.handle(Input::Message { header: hdr(10, g), message: Message::SetLightMode { mode: LightMode::Emergency, duration_s: 0 } }, 10);
        let a = begin(&mut c, g, 11, A1, 20);
        assert!(a.contains(|x| *x == Action::Light(LightPattern::OrangeArc)));
        assert_eq!(c.phase(), Phase::AwaitingTap);
    }

    #[test]
    fn controlled_shutdown_skips_sound_without_power() {
        let (mut c, _) = boot(true, false);
        let a = c.handle(Input::ShutdownRequested { power_ok: false }, 10);
        assert!(!a.contains(|x| *x == Action::Audio(AudioClip::Shutdown)));
        assert_eq!(c.phase(), Phase::ShuttingDown);
    }

    #[test]
    fn wrong_protocol_version_is_refused() {
        let (mut c, _) = boot(true, false);
        c.handle(Input::BleConnected, 0);
        let a = c.handle(Input::Message { header: hdr(1, 0), message: Message::Handshake { kind: HandshakeKind::Resume, protocol: PROTOCOL_VERSION + 1, nonce: [0; 16], proof: [0; 32] } }, 5);
        assert!(a.contains(|x| *x == Action::DisconnectPeer));
    }

    // ---- payment reminder (docs/ORB.md section 7: start the timer when the reader is actually ready) ----

    fn reminder_played(a: &Actions) -> bool {
        a.contains(|x| *x == Action::Audio(AudioClip::PaymentReminder))
    }
    fn awaiting(t: u32) -> (Controller, u16, u32) {
        let (mut c, _) = boot(true, false);
        let g = connect(&mut c, HandshakeKind::Resume, t);
        c.handle(Input::Message { header: hdr(10, g), message: Message::Heartbeat { counter: 1 } }, t + 1);
        begin(&mut c, g, 11, A1, t + 2);
        (c, g, t + 2)
    }
    /// Ticks (with heartbeats so the session stays alive) until `until`, returning true if the reminder played.
    fn run_until(c: &mut Controller, g: u16, from: u32, until: u32) -> bool {
        let mut played = false;
        let mut t = from;
        let mut id = 1000u16;
        while t < until {
            t += 500;
            id = id.wrapping_add(1);
            played |= reminder_played(&c.handle(Input::Message { header: hdr(id, g), message: Message::Heartbeat { counter: 1 } }, t));
            played |= reminder_played(&c.handle(Input::Tick, t));
        }
        played
    }

    #[test]
    fn reminder_does_not_start_until_the_reader_is_ready() {
        let (mut c, g, t) = awaiting(0);
        assert!(!run_until(&mut c, g, t, t + 12_000));              // accepted but the reader never became ready: no reminder
    }

    #[test]
    fn reminder_plays_once_five_seconds_after_the_reader_is_ready() {
        let (mut c, g, t) = awaiting(0);
        c.handle(Input::ReaderReady, t + 800);
        assert!(!run_until(&mut c, g, t + 800, t + 800 + PAYMENT_REMINDER_DELAY_MS - 600));   // not yet
        let a = c.handle(Input::Tick, t + 800 + PAYMENT_REMINDER_DELAY_MS);
        assert!(reminder_played(&a));
        assert!(!run_until(&mut c, g, t + 800 + PAYMENT_REMINDER_DELAY_MS, t + 25_000));      // once per waiting attempt
    }

    #[test]
    fn a_second_reader_ready_does_not_restart_the_reminder() {
        let (mut c, g, t) = awaiting(0);
        c.handle(Input::ReaderReady, t);
        c.handle(Input::ReaderReady, t + 3_000);                    // a repeated readiness signal changes nothing
        assert!(reminder_played(&c.handle(Input::Tick, t + PAYMENT_REMINDER_DELAY_MS)));
        let _ = g;
    }

    #[test]
    fn a_tap_stops_the_reminder_before_it_plays_and_while_it_is_queued() {
        let (mut c, g, t) = awaiting(0);
        c.handle(Input::ReaderReady, t);
        let mut buf = [0u8; 128];
        let n = url_ndef(&mut buf);
        let a = c.handle(Input::TagRead(&buf[..n]), t + 4_000);
        assert!(a.contains(|x| *x == Action::StopAudio(AudioClip::PaymentReminder)));
        assert!(!run_until(&mut c, g, t + 4_000, t + 20_000));
    }

    #[test]
    fn cancel_timeout_and_disconnect_stop_the_reminder_too() {
        let (mut c, g, t) = awaiting(0);
        c.handle(Input::ReaderReady, t);
        let a = c.handle(Input::Message { header: hdr(40, g), message: Message::Cancel { attempt: A1 } }, t + 1_000);
        assert!(a.contains(|x| *x == Action::StopAudio(AudioClip::PaymentReminder)));
        assert!(!run_until(&mut c, g, t + 1_000, t + 12_000));

        let (mut c2, g2, t2) = awaiting(0);
        c2.handle(Input::ReaderReady, t2);
        let mut timed_out = Actions::new();
        let mut tt = t2;
        let mut id = 2000u16;
        while tt < t2 + SCAN_TIMEOUT_MS + 2_000 {
            tt += 500;
            id = id.wrapping_add(1);
            let a = c2.handle(Input::Message { header: hdr(id, g2), message: Message::Heartbeat { counter: 1 } }, tt);
            if a.contains(|x| matches!(x, Action::Send(Outgoing::Error { reason: Reason::Timeout, .. }))) { timed_out = a; break; }
        }
        assert!(timed_out.contains(|x| *x == Action::StopAudio(AudioClip::PaymentReminder)));

        let (mut c3, _g3, t3) = awaiting(0);
        c3.handle(Input::ReaderReady, t3);
        let a = c3.handle(Input::BleDisconnected, t3 + 2_000);
        assert!(a.contains(|x| *x == Action::StopAudio(AudioClip::PaymentReminder)));
    }

    #[test]
    fn lookups_have_no_reminder_and_stray_reader_ready_is_ignored() {
        let (mut c, _) = boot(true, false);
        let g = connect(&mut c, HandshakeKind::Resume, 0);
        c.handle(Input::ReaderReady, 5);                            // nothing is waiting: ignored
        c.handle(Input::Message { header: hdr(10, g), message: Message::BeginRead { purpose: Purpose::Lookup, attempt: A1, timeout_s: 0 } }, 10);
        c.handle(Input::ReaderReady, 20);
        assert!(!run_until(&mut c, g, 20, 12_000));
    }

    #[test]
    fn an_event_ack_is_accepted_silently() {
        let (mut c, _) = boot(true, false);
        let g = connect(&mut c, HandshakeKind::Resume, 0);
        let a = c.handle(Input::Message { header: hdr(60, g), message: Message::EventAck { of: 5 } }, 10);
        assert!(a.is_empty());
    }

    #[test]
    fn only_events_the_terminal_must_confirm_are_reliable() {
        assert!(Outgoing::StateChanged(OrbState::Completed).reliable());
        assert!(Outgoing::Error { reason: Reason::Timeout, attempt: A1 }.reliable());
        assert!(!Outgoing::CommandAck { of: 1, accepted: true, reason: Reason::Ok }.reliable());
        assert!(!Outgoing::HandshakeResult { accepted: true, reason: Reason::Ok }.reliable());
    }
}
