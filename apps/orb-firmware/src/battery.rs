//! Battery reporting and warnings (docs/ORB.md section 9). Pure decisions: the board reads the fuel gauge or voltage and calls these.
//!
//! A protection circuit is not a fuel gauge: `percent` is `None` unless the hardware gives a valid estimate. Percentages are warned at
//! once per level (20% and 10%) and re-armed after the charge recovers by the hysteresis; a warning never interrupts a payment (the
//! controller defers the sound until the Orb is idle).

use crate::config::*;
pub use crate::message::BatteryStatus;

/// A reading from the board, before warnings are decided.
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub struct Reading {
    pub percent: Option<u8>,
    pub millivolts: u16,
    pub charging: bool,
    pub external_power: bool,
    pub temperature_c: Option<i8>,
}

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum Warning {
    Low,
    VeryLow,
    Critical,
}

pub struct BatteryMonitor {
    warned_low: bool,
    warned_very_low: bool,
    warned_critical: bool,
    last_reported: Option<(BatteryStatus, u32)>,
}

impl Default for BatteryMonitor {
    fn default() -> Self {
        Self::new()
    }
}

impl BatteryMonitor {
    pub const fn new() -> Self {
        BatteryMonitor { warned_low: false, warned_very_low: false, warned_critical: false, last_reported: None }
    }

    /// Turns a reading into the status to report, and a warning when a new level was just crossed.
    pub fn update(&mut self, r: Reading) -> (BatteryStatus, Option<Warning>) {
        let critical = r.millivolts != 0 && r.millivolts <= BATTERY_CRITICAL_MILLIVOLTS && !r.external_power;
        let low = matches!(r.percent, Some(p) if p <= BATTERY_WARN_PERCENT) || critical;
        let status = BatteryStatus {
            percent: r.percent,
            millivolts: r.millivolts,
            charging: r.charging,
            external_power: r.external_power,
            low,
            critical,
            temperature_c: r.temperature_c,
        };
        let mut warning = None;
        if let Some(p) = r.percent {
            // Re-arm once the charge has recovered past the hysteresis.
            if p >= BATTERY_WARN_PERCENT + BATTERY_HYSTERESIS_PERCENT {
                self.warned_low = false;
            }
            if p >= BATTERY_VERY_LOW_PERCENT + BATTERY_HYSTERESIS_PERCENT {
                self.warned_very_low = false;
            }
            if !r.external_power && p <= BATTERY_VERY_LOW_PERCENT && !self.warned_very_low {
                self.warned_very_low = true;
                self.warned_low = true;
                warning = Some(Warning::VeryLow);
            } else if !r.external_power && p <= BATTERY_WARN_PERCENT && !self.warned_low {
                self.warned_low = true;
                warning = Some(Warning::Low);
            }
        }
        if critical && !self.warned_critical {
            self.warned_critical = true;
            warning = Some(Warning::Critical);
        } else if !critical && r.millivolts > BATTERY_CRITICAL_MILLIVOLTS + 100 {
            self.warned_critical = false;
        }
        (status, warning)
    }

    /// Should this status be sent now? On a connection, on a charging or external-power change, on a change of at least the minimum number of
    /// points, on a warning, and otherwise at least every report interval.
    pub fn should_report(&mut self, status: BatteryStatus, warning: Option<Warning>, now_ms: u32, just_connected: bool) -> bool {
        let report = match self.last_reported {
            None => true,
            Some((last, at)) => {
                just_connected
                    || warning.is_some()
                    || last.charging != status.charging
                    || last.external_power != status.external_power
                    || last.low != status.low
                    || last.critical != status.critical
                    || match (last.percent, status.percent) {
                        (Some(a), Some(b)) => a.abs_diff(b) >= BATTERY_MIN_REPORT_DELTA_PERCENT,
                        (None, None) => false,
                        _ => true,
                    }
                    || now_ms.wrapping_sub(at) >= BATTERY_REPORT_INTERVAL_MS
            }
        };
        if report {
            self.last_reported = Some((status, now_ms));
        }
        report
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reading(percent: u8, external: bool) -> Reading {
        Reading { percent: Some(percent), millivolts: 3_900, charging: external, external_power: external, temperature_c: None }
    }

    #[test]
    fn warns_once_per_level_and_rearms_after_recovery() {
        let mut m = BatteryMonitor::new();
        assert_eq!(m.update(reading(40, false)).1, None);
        assert_eq!(m.update(reading(20, false)).1, Some(Warning::Low));
        assert_eq!(m.update(reading(19, false)).1, None);               // not again
        assert_eq!(m.update(reading(10, false)).1, Some(Warning::VeryLow));
        assert_eq!(m.update(reading(9, false)).1, None);
        // Charged back up past the hysteresis: warns again on the way down.
        m.update(reading(30, true));
        m.update(reading(30, false));
        assert_eq!(m.update(reading(20, false)).1, Some(Warning::Low));
    }

    #[test]
    fn no_warning_while_on_external_power() {
        let mut m = BatteryMonitor::new();
        assert_eq!(m.update(reading(8, true)).1, None);
        assert!(m.update(reading(8, true)).0.low);             // still reported as low, just not announced
    }

    #[test]
    fn an_unknown_percentage_is_reported_as_unknown_and_critical_voltage_still_warns() {
        let mut m = BatteryMonitor::new();
        let (s, w) = m.update(Reading { percent: None, millivolts: 3_250, charging: false, external_power: false, temperature_c: None });
        assert_eq!(s.percent, None);
        assert!(s.critical && s.low);
        assert_eq!(w, Some(Warning::Critical));
        let (_, w2) = m.update(Reading { percent: None, millivolts: 3_250, charging: false, external_power: false, temperature_c: None });
        assert_eq!(w2, None);
    }

    #[test]
    fn reports_on_connect_change_warning_and_every_minute() {
        let mut m = BatteryMonitor::new();
        let (s, w) = m.update(reading(80, false));
        assert!(m.should_report(s, w, 0, true));
        let (s, w) = m.update(reading(80, false));
        assert!(!m.should_report(s, w, 1_000, false));                                  // nothing changed
        let (s, w) = m.update(reading(79, false));
        assert!(m.should_report(s, w, 2_000, false));                                   // one point
        let (s, w) = m.update(reading(79, true));
        assert!(m.should_report(s, w, 3_000, false));                                   // external power appeared
        let (s, w) = m.update(reading(79, true));
        assert!(!m.should_report(s, w, 4_000, false));
        let (s, w) = m.update(reading(79, true));
        assert!(m.should_report(s, w, 3_000 + BATTERY_REPORT_INTERVAL_MS, false));      // the periodic report
    }
}
