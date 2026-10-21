//! The nonblocking LED renderer (docs/ORB.md sections 4 and 10). A pattern is a pure function of time: the LED driver calls
//! [`Animator::render`] every [`ANIMATION_FRAME_MS`] with the current time and pushes the frame out; nothing here waits or sleeps, so BLE,
//! NFC deadlines and audio are never held up. Setting a new pattern replaces the old one at once (obsolete animations never finish).
//!
//! Colors are first guesses (blue pairing and connection, orange awaiting and processing, green success, red decline) and every duration
//! comes from `config.rs`: all of it is for tuning on hardware. Normal patterns are scaled by `NORMAL_LED_BRIGHTNESS_CAP_PERCENT`;
//! `Emergency` is its own mode and ignores that cap. Integer math only.

use crate::config::*;
use crate::feedback::LightPattern;

#[derive(Debug, PartialEq, Eq, Clone, Copy, Default)]
pub struct Rgb {
    pub r: u8,
    pub g: u8,
    pub b: u8,
}

impl Rgb {
    pub const OFF: Rgb = Rgb { r: 0, g: 0, b: 0 };
    pub const BLUE: Rgb = Rgb { r: 0, g: 80, b: 255 };
    pub const ORANGE: Rgb = Rgb { r: 255, g: 100, b: 0 };
    pub const GREEN: Rgb = Rgb { r: 0, g: 255, b: 60 };
    pub const RED: Rgb = Rgb { r: 255, g: 0, b: 0 };
    pub const WHITE: Rgb = Rgb { r: 255, g: 255, b: 255 };

    /// Scale by `level` (0 to 255).
    pub const fn scaled(self, level: u8) -> Rgb {
        Rgb { r: ((self.r as u16 * level as u16) / 255) as u8, g: ((self.g as u16 * level as u16) / 255) as u8, b: ((self.b as u16 * level as u16) / 255) as u8 }
    }
    pub const fn is_off(self) -> bool {
        self.r == 0 && self.g == 0 && self.b == 0
    }
}

pub type Frame = [Rgb; LED_COUNT];

/// A triangle wave over `period` ms: 0 at the start, 255 at the middle, back to 0.
fn triangle(elapsed: u32, period: u32) -> u8 {
    let p = elapsed % period.max(1);
    let half = (period / 2).max(1);
    let v = if p < half { p * 255 / half } else { (period - p) * 255 / (period - half).max(1) };
    v.min(255) as u8
}

/// Smooth the triangle into a "breathing" ease (squares it, so the dark part lingers).
fn ease(v: u8) -> u8 {
    ((v as u16 * v as u16) / 255) as u8
}

pub struct Animator {
    pattern: LightPattern,
    started_ms: u32,
    progress_percent: u8,
    /// The last frame handed out, kept so a `Fade` starts from what was on the LEDs.
    last: Frame,
    fade_from: Frame,
}

impl Default for Animator {
    fn default() -> Self {
        Self::new()
    }
}

impl Animator {
    pub const fn new() -> Self {
        Animator { pattern: LightPattern::Off, started_ms: 0, progress_percent: 0, last: [Rgb::OFF; LED_COUNT], fade_from: [Rgb::OFF; LED_COUNT] }
    }

    pub fn pattern(&self) -> LightPattern {
        self.pattern
    }

    /// Switch pattern. Asking for the pattern already showing does not restart it (a repeated request must not make the light jump).
    pub fn set(&mut self, pattern: LightPattern, now_ms: u32) {
        if pattern == self.pattern {
            return;
        }
        if pattern == LightPattern::Fade {
            self.fade_from = self.last;
        }
        self.pattern = pattern;
        self.started_ms = now_ms;
    }

    /// Progress for `BlueProgress` (firmware update), 0 to 100.
    pub fn set_progress(&mut self, percent: u8) {
        self.progress_percent = percent.min(100);
    }

    /// True once a one-shot pattern has played out (the frame stays at its final look); looping patterns never finish. `Off` is done.
    pub fn is_done(&self, now_ms: u32) -> bool {
        let e = now_ms.wrapping_sub(self.started_ms);
        match self.pattern {
            LightPattern::Off => true,
            LightPattern::StartupSweep => e >= STARTUP_SWEEP_MS,
            LightPattern::BluePulse => e >= BLUE_PULSE_MS,
            LightPattern::GreenSweep => e >= GREEN_SWEEP_MS,
            LightPattern::RedDoublePulse => e >= RED_DOUBLE_PULSE_MS,
            LightPattern::Fade => e >= FADE_OUT_MS,
            _ => false,
        }
    }

    /// Draw the pattern for time `now_ms` into `frame`. Cheap and side-effect free apart from remembering the last frame.
    pub fn render(&mut self, now_ms: u32, frame: &mut Frame) {
        let e = now_ms.wrapping_sub(self.started_ms);
        *frame = [Rgb::OFF; LED_COUNT];
        let cap = (NORMAL_LED_BRIGHTNESS_CAP_PERCENT as u16 * 255 / 100) as u8;
        match self.pattern {
            LightPattern::Off => {}
            LightPattern::StartupSweep => {
                // A short bright head travelling once around the ring.
                let pos = (e.min(STARTUP_SWEEP_MS) as usize * LED_COUNT) / STARTUP_SWEEP_MS as usize;
                if e < STARTUP_SWEEP_MS {
                    for k in 0..4usize {
                        let i = (pos + LED_COUNT - k) % LED_COUNT;
                        frame[i] = Rgb::BLUE.scaled(255 - (k as u8) * 60).scaled(cap);
                    }
                }
            }
            LightPattern::BluePulse => {
                if e < BLUE_PULSE_MS {
                    fill(frame, Rgb::BLUE.scaled(ease(triangle(e, BLUE_PULSE_MS))).scaled(cap));
                }
            }
            LightPattern::BlueBreathing => fill(frame, Rgb::BLUE.scaled(ease(triangle(e, BREATHING_PERIOD_MS))).scaled(cap)),
            LightPattern::OrangeArc => {
                let head = ((e % ARC_PERIOD_MS) as usize * LED_COUNT) / ARC_PERIOD_MS as usize;
                for k in 0..ARC_LEDS {
                    let i = (head + LED_COUNT - k) % LED_COUNT;
                    let fade = 255 - (k * 255 / ARC_LEDS) as u16;          // the arc's tail fades out
                    frame[i] = Rgb::ORANGE.scaled(fade as u8).scaled(cap);
                }
            }
            LightPattern::OrangePulse => fill(frame, Rgb::ORANGE.scaled(ease(triangle(e, ORANGE_PULSE_PERIOD_MS))).scaled(cap)),
            LightPattern::GreenSweep => {
                // Fills around the ring and stays lit; the controller moves on to `Fade` when it wants it gone.
                let lit = ((e.min(GREEN_SWEEP_MS) as usize * LED_COUNT) / GREEN_SWEEP_MS as usize).max(1);
                for px in frame.iter_mut().take(lit) {
                    *px = Rgb::GREEN.scaled(cap);
                }
            }
            LightPattern::RedDoublePulse => {
                if e < RED_DOUBLE_PULSE_MS {
                    let half = RED_DOUBLE_PULSE_MS / 2;
                    let v = triangle(e % half, half);                      // two pulses
                    fill(frame, Rgb::RED.scaled(ease(v)).scaled(cap));
                }
            }
            LightPattern::BlueProgress => {
                let lit = (self.progress_percent as usize * LED_COUNT) / 100;
                for px in frame.iter_mut().take(lit) {
                    *px = Rgb::BLUE.scaled(cap);
                }
            }
            LightPattern::Fade => {
                if e < FADE_OUT_MS {
                    let left = (255 - (e * 255 / FADE_OUT_MS)) as u8;
                    for (o, f) in frame.iter_mut().zip(self.fade_from.iter()) {
                        *o = f.scaled(left);
                    }
                }
            }
            LightPattern::Identify => {
                // Blink on and off, so a person can tell which Orb is meant.
                if (e / (IDENTIFY_BLINK_PERIOD_MS / 2).max(1)) % 2 == 0 {
                    fill(frame, Rgb::WHITE.scaled(cap));
                }
            }
            LightPattern::Emergency => {
                // Its own mode: full output, red and white alternating, not limited by the normal cap.
                let on_red = (e / (EMERGENCY_FLASH_PERIOD_MS / 2).max(1)) % 2 == 0;
                fill(frame, if on_red { Rgb::RED } else { Rgb::WHITE });
            }
        }
        self.last = *frame;
    }
}

fn fill(frame: &mut Frame, c: Rgb) {
    for px in frame.iter_mut() {
        *px = c;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use LightPattern::*;

    fn lit(f: &Frame) -> usize {
        f.iter().filter(|p| !p.is_off()).count()
    }
    fn frame_at(a: &mut Animator, t: u32) -> Frame {
        let mut f = [Rgb::OFF; LED_COUNT];
        a.render(t, &mut f);
        f
    }
    fn peak(f: &Frame) -> u8 {
        f.iter().map(|p| p.r.max(p.g).max(p.b)).max().unwrap()
    }

    #[test]
    fn off_is_dark_and_done() {
        let mut a = Animator::new();
        assert_eq!(lit(&frame_at(&mut a, 0)), 0);
        assert!(a.is_done(0));
    }

    #[test]
    fn the_frame_has_one_pixel_per_led() {
        assert_eq!(Frame::default().len(), 28);
    }

    #[test]
    fn startup_sweep_moves_around_and_finishes_dark() {
        let mut a = Animator::new();
        a.set(StartupSweep, 100);
        let first = frame_at(&mut a, 100 + 50);
        let later = frame_at(&mut a, 100 + 600);
        assert!(lit(&first) > 0 && lit(&later) > 0);
        assert_ne!(first, later);                                      // it travels
        assert!(!a.is_done(100 + STARTUP_SWEEP_MS - 1));
        assert!(a.is_done(100 + STARTUP_SWEEP_MS));
        assert_eq!(lit(&frame_at(&mut a, 100 + STARTUP_SWEEP_MS)), 0);
    }

    #[test]
    fn breathing_loops_and_never_finishes() {
        let mut a = Animator::new();
        a.set(BlueBreathing, 0);
        let dim = peak(&frame_at(&mut a, 0));
        let bright = peak(&frame_at(&mut a, BREATHING_PERIOD_MS / 2));
        assert!(bright > dim + 100);
        assert_eq!(frame_at(&mut a, 40), frame_at(&mut a, 40 + BREATHING_PERIOD_MS));   // periodic
        assert!(!a.is_done(1_000_000));
    }

    #[test]
    fn the_orange_arc_covers_a_fixed_stretch_and_rotates() {
        let mut a = Animator::new();
        a.set(OrangeArc, 0);
        let f0 = frame_at(&mut a, 0);
        let f1 = frame_at(&mut a, ARC_PERIOD_MS / 4);
        assert_eq!(lit(&f0), ARC_LEDS);
        assert_eq!(lit(&f1), ARC_LEDS);
        assert_ne!(f0, f1);
        assert_eq!(frame_at(&mut a, 10), frame_at(&mut a, 10 + ARC_PERIOD_MS));
    }

    #[test]
    fn orange_pulse_breathes_between_dark_and_bright() {
        let mut a = Animator::new();
        a.set(OrangePulse, 0);
        assert!(peak(&frame_at(&mut a, ORANGE_PULSE_PERIOD_MS / 2)) > 200);
        assert!(peak(&frame_at(&mut a, 0)) < 5);
    }

    #[test]
    fn green_sweep_fills_the_ring_and_stays_lit_when_done() {
        let mut a = Animator::new();
        a.set(GreenSweep, 0);
        let part = lit(&frame_at(&mut a, GREEN_SWEEP_MS / 2));
        assert!(part > 5 && part < LED_COUNT);
        assert!(!a.is_done(GREEN_SWEEP_MS - 1));
        let end = frame_at(&mut a, GREEN_SWEEP_MS + 5_000);
        assert_eq!(lit(&end), LED_COUNT);
        assert!(end.iter().all(|p| p.g > p.r && p.g > p.b));           // green
        assert!(a.is_done(GREEN_SWEEP_MS));
    }

    #[test]
    fn red_double_pulse_pulses_twice_then_goes_dark() {
        let mut a = Animator::new();
        a.set(RedDoublePulse, 0);
        let mut peaks = 0;
        let mut prev = 0u8;
        let mut rising = false;
        for t in (0..RED_DOUBLE_PULSE_MS).step_by(10) {
            let v = peak(&frame_at(&mut a, t));
            if v > prev { rising = true; } else if v < prev && rising { peaks += 1; rising = false; }
            prev = v;
        }
        assert_eq!(peaks, 2);
        assert_eq!(lit(&frame_at(&mut a, RED_DOUBLE_PULSE_MS)), 0);
        assert!(frame_at(&mut a, 100).iter().all(|p| p.g == 0 && p.b == 0));        // only red
    }

    #[test]
    fn progress_lights_a_matching_share_of_the_ring() {
        let mut a = Animator::new();
        a.set(BlueProgress, 0);
        assert_eq!(lit(&frame_at(&mut a, 5)), 0);
        a.set_progress(50);
        assert_eq!(lit(&frame_at(&mut a, 5)), LED_COUNT / 2);
        a.set_progress(250);                                           // clamped
        assert_eq!(lit(&frame_at(&mut a, 5)), LED_COUNT);
    }

    #[test]
    fn fade_starts_from_what_was_showing_and_ends_dark() {
        let mut a = Animator::new();
        a.set(GreenSweep, 0);
        frame_at(&mut a, GREEN_SWEEP_MS + 10);                          // full green on the ring
        a.set(Fade, 1_000);
        let start = frame_at(&mut a, 1_000);
        assert_eq!(lit(&start), LED_COUNT);
        let mid = frame_at(&mut a, 1_000 + FADE_OUT_MS / 2);
        assert!(peak(&mid) < peak(&start) && peak(&mid) > 0);
        assert!(a.is_done(1_000 + FADE_OUT_MS));
        assert_eq!(lit(&frame_at(&mut a, 1_000 + FADE_OUT_MS)), 0);
    }

    #[test]
    fn identify_blinks_the_whole_ring() {
        let mut a = Animator::new();
        a.set(Identify, 0);
        assert_eq!(lit(&frame_at(&mut a, 0)), LED_COUNT);
        assert_eq!(lit(&frame_at(&mut a, IDENTIFY_BLINK_PERIOD_MS / 2)), 0);
        assert_eq!(lit(&frame_at(&mut a, IDENTIFY_BLINK_PERIOD_MS)), LED_COUNT);
    }

    #[test]
    fn emergency_flashes_at_full_output() {
        let mut a = Animator::new();
        a.set(Emergency, 0);
        let on = frame_at(&mut a, 0);
        assert!(on.iter().all(|p| *p == Rgb::RED));
        let alt = frame_at(&mut a, EMERGENCY_FLASH_PERIOD_MS / 2);
        assert!(alt.iter().all(|p| *p == Rgb::WHITE));
        assert!(!a.is_done(10_000_000));
    }

    #[test]
    fn a_new_pattern_replaces_the_old_at_once_and_repeating_one_does_not_restart_it() {
        let mut a = Animator::new();
        a.set(OrangeArc, 0);
        let before = frame_at(&mut a, 500);
        a.set(OrangeArc, 500);                                          // same pattern: no restart
        assert_eq!(frame_at(&mut a, 500), before);
        a.set(Off, 510);
        assert_eq!(lit(&frame_at(&mut a, 510)), 0);                     // an obsolete animation does not linger
        a.set(GreenSweep, 520);
        assert!(lit(&frame_at(&mut a, 521)) >= 1);
    }

    #[test]
    fn scaling_keeps_colors_in_range_and_time_wraps_safely() {
        assert_eq!(Rgb::WHITE.scaled(0), Rgb::OFF);
        assert_eq!(Rgb::WHITE.scaled(255), Rgb::WHITE);
        let mut a = Animator::new();
        a.set(OrangePulse, u32::MAX - 100);
        let f = frame_at(&mut a, 200);                                  // the clock wrapped past u32::MAX
        let mut fresh = Animator::new();
        fresh.set(OrangePulse, 0);
        assert_eq!(f, frame_at(&mut fresh, 301));                       // 301 ms elapsed either way
        assert!(!a.is_done(200));
    }

    #[test]
    fn normal_patterns_respect_the_brightness_cap_and_emergency_does_not() {
        let cap = (NORMAL_LED_BRIGHTNESS_CAP_PERCENT as u16 * 255 / 100) as u8;
        let mut a = Animator::new();
        for p in [BluePulse, BlueBreathing, OrangeArc, OrangePulse, GreenSweep, RedDoublePulse, Identify] {
            a.set(p, 0);
            for t in (0..3_000).step_by(37) {
                assert!(peak(&frame_at(&mut a, t)) <= cap, "{:?} at {}", p, t);
            }
        }
        a.set(Emergency, 0);
        assert_eq!(peak(&frame_at(&mut a, 0)), 255);
    }
}
