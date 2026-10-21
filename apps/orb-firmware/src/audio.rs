//! The audio scheduler (docs/ORB.md section 10). The controller asks for named clips; this decides what actually plays: one clip at a time,
//! never overlapping, in a sensible order, with higher-priority clips preempting lower ones.
//!
//! Rules it keeps:
//! * **Ordered, not overlapping.** Startup then the pairing prompt play one after the other; a clip waits for the one playing.
//! * **No nuisance repeats.** A clip that is already playing or queued is not queued again.
//! * **Results preempt.** A payment result (success or failure) interrupts a reminder or a warning; the reminder never plays after a tap
//!   because the controller cancels it ([`AudioScheduler::stop`]) and a queued reminder is removed, not merely skipped.
//! * **Nothing plays late.** A queued clip older than [`AUDIO_QUEUED_MAX_AGE_MS`] is dropped.
//! * **Visuals always remain.** Muted means no sound at all; the lights are unaffected.
//!
//! Clip lengths: the driver tells the scheduler when a clip really ended ([`AudioScheduler::finished`]); until recordings exist, a
//! placeholder length ends it (`duration`). No hardware, no allocation.

use crate::config::*;
use crate::feedback::AudioClip;

/// What the audio driver must do.
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum AudioAction {
    /// Begin playing this clip at this volume (0 to 100).
    Start { clip: AudioClip, volume: u8 },
    /// Stop whatever is playing immediately.
    Stop,
}

/// How urgent a clip is. A higher class interrupts a lower one that is playing; equal or lower classes wait their turn.
#[derive(Debug, PartialEq, Eq, PartialOrd, Ord, Clone, Copy)]
pub enum Priority {
    /// Warnings and reminders: useful, but never worth interrupting anything.
    Advisory = 1,
    /// Setup, connection and status sounds.
    Status = 2,
    /// The outcome of a payment, and the tap acknowledgement.
    Result = 3,
}

pub const fn priority(c: AudioClip) -> Priority {
    match c {
        AudioClip::PaymentReminder | AudioClip::BatteryLow => Priority::Advisory,
        AudioClip::SuccessNotification | AudioClip::FailureNotification | AudioClip::ScanNotification => Priority::Result,
        AudioClip::Startup | AudioClip::Shutdown | AudioClip::PairingPrompt | AudioClip::PairingSuccessful | AudioClip::PairingFailed | AudioClip::TerminalDisconnected => Priority::Status,
    }
}

/// Placeholder clip length until real recordings report their own end (voice clips are longer).
pub const fn duration(c: AudioClip) -> u32 {
    match c {
        AudioClip::PairingPrompt | AudioClip::PaymentReminder | AudioClip::BatteryLow | AudioClip::TerminalDisconnected | AudioClip::PairingFailed => PLACEHOLDER_VOICE_CLIP_MS,
        _ => PLACEHOLDER_CLIP_MS,
    }
}

#[derive(Debug, Clone, Copy)]
struct Queued {
    clip: AudioClip,
    since_ms: u32,
}

#[derive(Debug, Clone, Copy)]
struct Playing {
    clip: AudioClip,
    ends_ms: u32,
}

/// At most one action pair (`Stop` then `Start`) comes out of any single call.
#[derive(Debug, Clone, Copy, Default)]
pub struct AudioActions {
    items: [Option<AudioAction>; 2],
    len: usize,
}
impl AudioActions {
    fn push(&mut self, a: AudioAction) {
        if self.len < self.items.len() {
            self.items[self.len] = Some(a);
            self.len += 1;
        }
    }
    pub fn iter(&self) -> impl Iterator<Item = &AudioAction> {
        self.items[..self.len].iter().filter_map(|a| a.as_ref())
    }
    pub fn len(&self) -> usize {
        self.len
    }
    pub fn is_empty(&self) -> bool {
        self.len == 0
    }
    pub fn contains(&self, a: AudioAction) -> bool {
        self.iter().any(|x| *x == a)
    }
}

pub struct AudioScheduler {
    playing: Option<Playing>,
    queue: [Option<Queued>; AUDIO_QUEUE_MAX],
    volume: u8,
    muted: bool,
}

impl Default for AudioScheduler {
    fn default() -> Self {
        Self::new()
    }
}

impl AudioScheduler {
    pub const fn new() -> Self {
        AudioScheduler { playing: None, queue: [None; AUDIO_QUEUE_MAX], volume: DEFAULT_VOLUME_PERCENT, muted: false }
    }

    pub fn is_playing(&self) -> bool {
        self.playing.is_some()
    }
    pub fn now_playing(&self) -> Option<AudioClip> {
        self.playing.map(|p| p.clip)
    }
    pub fn queued(&self) -> usize {
        self.queue.iter().flatten().count()
    }

    /// Volume and mute from the terminal. Muting stops what is playing and empties the queue (a muted Orb stays quiet).
    pub fn configure(&mut self, volume: u8, muted: bool) -> AudioActions {
        let mut out = AudioActions::default();
        self.volume = volume.min(100);
        self.muted = muted;
        if muted {
            self.queue = [None; AUDIO_QUEUE_MAX];
            if self.playing.take().is_some() {
                out.push(AudioAction::Stop);
            }
        }
        out
    }

    fn is_queued(&self, clip: AudioClip) -> bool {
        self.queue.iter().flatten().any(|q| q.clip == clip)
    }

    /// Ask for a clip. Returns what the driver must do right now.
    pub fn request(&mut self, clip: AudioClip, now_ms: u32) -> AudioActions {
        let mut out = AudioActions::default();
        if self.muted || self.volume == 0 {
            return out;
        }
        self.expire(now_ms);
        if self.playing.map(|p| p.clip) == Some(clip) || self.is_queued(clip) {
            return out;                                           // never repeat a clip that is already on its way
        }
        match self.playing {
            None => self.start(clip, now_ms, &mut out),
            Some(p) if priority(clip) > priority(p.clip) => {
                out.push(AudioAction::Stop);                      // a higher class interrupts the one playing
                self.playing = None;
                self.start(clip, now_ms, &mut out);
            }
            Some(_) => self.enqueue(clip, now_ms),
        }
        out
    }

    /// Cancel a clip: stop it if it is playing, remove it if it is queued. (A reminder that no longer applies.)
    pub fn stop(&mut self, clip: AudioClip, now_ms: u32) -> AudioActions {
        let mut out = AudioActions::default();
        for q in self.queue.iter_mut() {
            if q.map(|x| x.clip) == Some(clip) {
                *q = None;
            }
        }
        if self.playing.map(|p| p.clip) == Some(clip) {
            self.playing = None;
            out.push(AudioAction::Stop);
            self.next(now_ms, &mut out);
        }
        out
    }

    /// The driver reports the clip really ended (or time passed): start the next one waiting.
    pub fn finished(&mut self, now_ms: u32) -> AudioActions {
        let mut out = AudioActions::default();
        self.playing = None;
        self.next(now_ms, &mut out);
        out
    }

    /// Time passed. Ends a placeholder clip at its length and starts the next waiting clip; drops anything that waited too long.
    pub fn tick(&mut self, now_ms: u32) -> AudioActions {
        let mut out = AudioActions::default();
        self.expire(now_ms);
        if let Some(p) = self.playing {
            if (now_ms.wrapping_sub(p.ends_ms) as i32) >= 0 {
                self.playing = None;
                self.next(now_ms, &mut out);
            }
        } else {
            self.next(now_ms, &mut out);
        }
        out
    }

    fn start(&mut self, clip: AudioClip, now_ms: u32, out: &mut AudioActions) {
        self.playing = Some(Playing { clip, ends_ms: now_ms.wrapping_add(duration(clip)) });
        out.push(AudioAction::Start { clip, volume: self.volume });
    }

    fn enqueue(&mut self, clip: AudioClip, now_ms: u32) {
        if let Some(slot) = self.queue.iter_mut().find(|q| q.is_none()) {
            *slot = Some(Queued { clip, since_ms: now_ms });
        } else if let Some(worst) = self.queue.iter_mut().filter_map(|q| q.as_mut()).min_by_key(|q| priority(q.clip)) {
            // A full queue keeps the more important clips: replace the least important one only with something more important.
            if priority(clip) > priority(worst.clip) {
                *worst = Queued { clip, since_ms: now_ms };
            }
        }
    }

    /// The best waiting clip (highest priority, then the one that waited longest) starts when nothing is playing.
    fn next(&mut self, now_ms: u32, out: &mut AudioActions) {
        if self.playing.is_some() || self.muted {
            return;
        }
        self.expire(now_ms);
        let best = self
            .queue
            .iter()
            .enumerate()
            .filter_map(|(i, q)| q.map(|q| (i, q)))
            .max_by(|(_, a), (_, b)| priority(a.clip).cmp(&priority(b.clip)).then(b.since_ms.wrapping_sub(a.since_ms).cmp(&0)))
            .map(|(i, q)| (i, q.clip));
        if let Some((i, clip)) = best {
            self.queue[i] = None;
            self.start(clip, now_ms, out);
        }
    }

    fn expire(&mut self, now_ms: u32) {
        for q in self.queue.iter_mut() {
            if let Some(x) = q {
                if now_ms.wrapping_sub(x.since_ms) >= AUDIO_QUEUED_MAX_AGE_MS {
                    *q = None;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use AudioClip::*;

    fn started(a: &AudioActions) -> Option<AudioClip> {
        a.iter().find_map(|x| if let AudioAction::Start { clip, .. } = x { Some(*clip) } else { None })
    }

    #[test]
    fn a_clip_starts_at_once_when_nothing_plays() {
        let mut s = AudioScheduler::new();
        let a = s.request(Startup, 0);
        assert_eq!(a.iter().copied().collect::<Vec<_>>(), vec![AudioAction::Start { clip: Startup, volume: DEFAULT_VOLUME_PERCENT }]);
        assert_eq!(s.now_playing(), Some(Startup));
    }

    #[test]
    fn startup_then_the_pairing_prompt_play_in_order_without_overlapping() {
        let mut s = AudioScheduler::new();
        assert_eq!(started(&s.request(Startup, 0)), Some(Startup));
        assert!(s.request(PairingPrompt, 0).is_empty());          // waits
        assert_eq!(s.queued(), 1);
        assert!(s.tick(duration(Startup) - 1).is_empty());          // the first is still playing
        assert_eq!(started(&s.tick(duration(Startup))), Some(PairingPrompt));
        assert_eq!(s.queued(), 0);
    }

    #[test]
    fn the_driver_reporting_the_real_end_starts_the_next_clip() {
        let mut s = AudioScheduler::new();
        s.request(Startup, 0);
        s.request(PairingPrompt, 0);
        assert_eq!(started(&s.finished(300)), Some(PairingPrompt));  // the recording was shorter than the placeholder
    }

    #[test]
    fn a_clip_already_playing_or_queued_is_not_repeated() {
        let mut s = AudioScheduler::new();
        s.request(PairingPrompt, 0);
        assert!(s.request(PairingPrompt, 10).is_empty());           // playing
        s.request(PairingFailed, 20);
        assert!(s.request(PairingFailed, 30).is_empty());           // queued
        assert_eq!(s.queued(), 1);
    }

    #[test]
    fn a_result_preempts_a_reminder_and_the_reminder_does_not_come_back() {
        let mut s = AudioScheduler::new();
        s.request(PaymentReminder, 0);
        let a = s.request(SuccessNotification, 100);
        assert!(a.contains(AudioAction::Stop));
        assert_eq!(started(&a), Some(SuccessNotification));
        assert_eq!(s.queued(), 0);                                   // the interrupted reminder is gone, not queued
        assert_eq!(started(&s.tick(100 + duration(SuccessNotification))), None);
    }

    #[test]
    fn equal_or_lower_priority_waits_and_never_interrupts() {
        let mut s = AudioScheduler::new();
        s.request(SuccessNotification, 0);
        assert!(s.request(BatteryLow, 10).is_empty());               // an advisory waits behind a result
        let mut s2 = AudioScheduler::new();
        s2.request(PairingPrompt, 0);
        assert!(s2.request(PairingSuccessful, 5).is_empty());        // same class waits its turn
        assert_eq!(s2.now_playing(), Some(PairingPrompt));
    }

    #[test]
    fn stopping_a_reminder_removes_it_whether_it_plays_or_waits() {
        let mut s = AudioScheduler::new();
        s.request(SuccessNotification, 0);
        s.request(PaymentReminder, 10);                              // queued behind a result
        assert_eq!(s.queued(), 1);
        assert!(s.stop(PaymentReminder, 20).is_empty());
        assert_eq!(s.queued(), 0);
        assert_eq!(started(&s.tick(duration(SuccessNotification))), None);   // nothing left to play
        let mut p = AudioScheduler::new();
        p.request(PaymentReminder, 0);
        let a = p.stop(PaymentReminder, 50);
        assert!(a.contains(AudioAction::Stop));
        assert!(!p.is_playing());
    }

    #[test]
    fn stopping_what_plays_starts_the_next_waiting_clip() {
        let mut s = AudioScheduler::new();
        s.request(PaymentReminder, 0);
        s.request(BatteryLow, 10);                                   // an advisory waits behind the reminder
        let a = s.stop(PaymentReminder, 100);
        assert!(a.contains(AudioAction::Stop));
        assert_eq!(started(&a), Some(BatteryLow));
    }

    #[test]
    fn a_waiting_clip_that_waited_too_long_is_dropped() {
        let mut s = AudioScheduler::new();
        s.request(SuccessNotification, 0);
        s.request(BatteryLow, 10);
        s.finished(AUDIO_QUEUED_MAX_AGE_MS + 100);                    // the result ended long after the warning was asked for
        assert!(!s.is_playing());
        assert_eq!(s.queued(), 0);
    }

    #[test]
    fn the_queue_is_bounded_and_keeps_the_more_important_clips() {
        let mut s = AudioScheduler::new();
        s.request(Startup, 0);
        for c in [BatteryLow, PaymentReminder] { s.request(c, 1); }
        s.request(PairingPrompt, 2);
        s.request(TerminalDisconnected, 3);
        assert_eq!(s.queued(), AUDIO_QUEUE_MAX);
        s.request(PairingFailed, 4);                                  // a status clip replaces an advisory
        assert_eq!(s.queued(), AUDIO_QUEUE_MAX);
        let mut order = Vec::new();
        let mut t = 5;
        s.finished(t);
        while let Some(c) = s.now_playing() { order.push(c); t += 5_000; s.finished(t); }
        assert!(!order.contains(&BatteryLow) || !order.contains(&PaymentReminder));
    }

    #[test]
    fn higher_priority_waiting_clips_go_first() {
        let mut s = AudioScheduler::new();
        s.request(SuccessNotification, 0);
        s.request(BatteryLow, 1);
        s.request(ScanNotification, 2);                               // same class as the one playing: waits
        assert_eq!(started(&s.finished(10)), Some(ScanNotification));
    }

    #[test]
    fn muted_is_silent_and_empties_everything() {
        let mut s = AudioScheduler::new();
        s.request(Startup, 0);
        s.request(PairingPrompt, 0);
        let a = s.configure(70, true);
        assert!(a.contains(AudioAction::Stop));
        assert_eq!(s.queued(), 0);
        assert!(s.request(SuccessNotification, 10).is_empty());
        assert!(s.configure(70, false).is_empty());
        assert_eq!(started(&s.request(SuccessNotification, 20)), Some(SuccessNotification));
    }

    #[test]
    fn volume_is_applied_and_zero_is_silent() {
        let mut s = AudioScheduler::new();
        s.configure(35, false);
        assert_eq!(s.request(Startup, 0).iter().next(), Some(&AudioAction::Start { clip: Startup, volume: 35 }));
        let mut z = AudioScheduler::new();
        z.configure(0, false);
        assert!(z.request(Startup, 0).is_empty());
        let mut loud = AudioScheduler::new();
        loud.configure(250, false);
        assert!(matches!(loud.request(Startup, 0).iter().next(), Some(AudioAction::Start { volume: 100, .. })));
    }

    #[test]
    fn a_full_session_in_order_never_overlaps() {
        // Power-up: startup, then the pairing prompt, then a paired connection, then a payment with a reminder that is cancelled by the tap.
        let mut s = AudioScheduler::new();
        let mut log: Vec<AudioClip> = Vec::new();
        let mut note = |a: AudioActions| { if let Some(c) = started(&a) { log.push(c); } };
        note(s.request(Startup, 0));
        note(s.request(PairingPrompt, 0));
        note(s.tick(duration(Startup)));
        note(s.finished(duration(Startup) + duration(PairingPrompt)));
        note(s.request(PairingSuccessful, 10_000));
        note(s.tick(20_000));                                         // the confirmation sound has ended by now
        note(s.request(PaymentReminder, 20_000));
        note(s.stop(PaymentReminder, 20_500));                        // the tap arrived
        note(s.request(ScanNotification, 20_500));
        note(s.request(SuccessNotification, 20_600));                 // same class waits for the scan sound
        note(s.finished(21_700));
        assert_eq!(log, vec![Startup, PairingPrompt, PairingSuccessful, PaymentReminder, ScanNotification, SuccessNotification]);
    }
}
