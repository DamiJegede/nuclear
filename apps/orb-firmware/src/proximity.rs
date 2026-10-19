//! The setup proximity gate (docs/ORB.md section 5): during pairing, the Orb only accepts a binding once the connection's RSSI has stayed
//! strong for a dwell time. It smooths over the last few samples and uses hysteresis so a fluctuating signal does not flap.
//!
//! RSSI is a rough proximity proxy: not a distance, not an identity and not a security measure. This gate applies only to pairing, never to
//! normal operation or reconnection.

use crate::config::{PAIRING_MIN_RSSI_DBM, PAIRING_PROXIMITY_HOLD_MS, PAIRING_RSSI_HYSTERESIS_DB, PAIRING_RSSI_SAMPLE_WINDOW};

pub struct ProximityGate {
    samples: [i8; PAIRING_RSSI_SAMPLE_WINDOW],
    count: usize,
    next: usize,
    strong_since_ms: Option<u32>,
}

impl Default for ProximityGate {
    fn default() -> Self {
        Self::new()
    }
}

impl ProximityGate {
    pub const fn new() -> Self {
        ProximityGate { samples: [i8::MIN; PAIRING_RSSI_SAMPLE_WINDOW], count: 0, next: 0, strong_since_ms: None }
    }

    /// Forget everything (a new connection, or leaving pairing).
    pub fn reset(&mut self) {
        *self = Self::new();
    }

    fn average(&self) -> i16 {
        let n = self.count.max(1);
        let sum: i32 = self.samples[..self.count].iter().map(|&s| i32::from(s)).sum();
        (sum / n as i32) as i16
    }

    /// Feeds one RSSI reading (dBm) and returns true once the dwell is satisfied (and stays true while the signal holds).
    pub fn push(&mut self, rssi_dbm: i8, now_ms: u32) -> bool {
        self.samples[self.next] = rssi_dbm;
        self.next = (self.next + 1) % PAIRING_RSSI_SAMPLE_WINDOW;
        self.count = (self.count + 1).min(PAIRING_RSSI_SAMPLE_WINDOW);
        let avg = self.average();
        let min = i16::from(PAIRING_MIN_RSSI_DBM);
        if avg >= min {
            if self.strong_since_ms.is_none() {
                self.strong_since_ms = Some(now_ms);
            }
        } else if avg < min - i16::from(PAIRING_RSSI_HYSTERESIS_DB) {
            self.strong_since_ms = None;             // clearly too weak: the dwell starts over
        }                                            // in the hysteresis band: neither advance nor reset
        match self.strong_since_ms {
            Some(t) => now_ms.wrapping_sub(t) >= PAIRING_PROXIMITY_HOLD_MS,
            None => false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const STRONG: i8 = PAIRING_MIN_RSSI_DBM + 10;
    const BAND: i8 = PAIRING_MIN_RSSI_DBM - 2;      // inside the hysteresis band
    const WEAK: i8 = PAIRING_MIN_RSSI_DBM - 20;

    #[test]
    fn needs_a_sustained_strong_signal() {
        let mut g = ProximityGate::new();
        assert!(!g.push(STRONG, 0));
        assert!(!g.push(STRONG, 500));
        assert!(!g.push(STRONG, PAIRING_PROXIMITY_HOLD_MS - 1));
        assert!(g.push(STRONG, PAIRING_PROXIMITY_HOLD_MS));
    }

    #[test]
    fn a_weak_signal_restarts_the_dwell() {
        let mut g = ProximityGate::new();
        for t in 0..8u32 {
            g.push(STRONG, t * 200);
        }
        for t in 8..14u32 {
            g.push(WEAK, t * 200);                    // the average drops well below the band
        }
        assert!(!g.push(STRONG, 3_000));
        assert!(!g.push(STRONG, 3_200));
    }

    #[test]
    fn the_hysteresis_band_does_not_flap() {
        let mut g = ProximityGate::new();
        for t in 0..4u32 {
            g.push(STRONG, t * 100);
        }
        // A brief dip into the band keeps the dwell running instead of restarting it.
        for t in 4..8u32 {
            g.push(BAND, t * 100);
        }
        assert!(g.push(STRONG, PAIRING_PROXIMITY_HOLD_MS + 1));
    }

    #[test]
    fn never_satisfied_by_a_weak_signal() {
        let mut g = ProximityGate::new();
        for t in 0..50u32 {
            assert!(!g.push(WEAK, t * 200));
        }
    }
}
