//! The one board and behaviour configuration module (docs/ORB.md section 11). Everything board-dependent or tunable is a top-level constant
//! here, so it can change without touching drivers or logic.
//!
//! * Pins are **PROPOSED** by hardware/design/pin-plan.md (ESP32-C3FH4X strapping, flash, USB and deep-sleep-wake constraints checked
//!   against the datasheet; hardware/src/check.py keeps the schematic and this plan identical). They are not final until the board is reviewed.
//! * Values marked PROPOSED come from ORB.md's proposals; values marked UNCALIBRATED need measurement on the assembled Orb and tablets.

// ---- Hardware (ESP32-C3FH4X, PN7161, WS2812B) ---------------------------------------------------------------------------------
pub const LED_COUNT: usize = 23;
/// There is no physical button on the Orb, so there is no button pin.
pub const LED_DATA_PIN: Option<u8> = Some(6);
/// Enable for the LED power rail (TPS22918): 23 idle LEDs would draw about 23 mA, so the rail is off unless a pattern is showing.
pub const LED_ENABLE_PIN: Option<u8> = Some(3);
/// The PN7161 is the I2C version (PN7161A1HN/C101E): there are no SPI pins. It shares the I2C bus with the fuel gauge.
pub const NFC_IRQ_PIN: Option<u8> = Some(0);
pub const NFC_VEN_PIN: Option<u8> = Some(1);
pub const AUDIO_BCLK_PIN: Option<u8> = Some(7);
pub const AUDIO_LRCLK_PIN: Option<u8> = Some(10);
/// GPIO20 (U0RXD): UART0 is not used, the console is on native USB.
pub const AUDIO_DATA_PIN: Option<u8> = Some(20);
/// GPIO21 (U0TXD) drives the amplifier's SD_MODE through 2 k with a 100 k pull-down; ROM boot messages can pulse it briefly at reset.
pub const AUDIO_SHUTDOWN_PIN: Option<u8> = Some(21);
/// GPIO8 (a strapping pin): the VBUS divider. High during USB download, which is what download mode needs.
pub const USB_POWER_SENSE_PIN: Option<u8> = Some(8);
/// GPIO2 (a strapping pin): the BQ24074 /CHG output, low while charging, with a 100 k pull-up.
pub const CHARGE_STATUS_PIN: Option<u8> = Some(2);
/// The shared I2C bus: PN7161 and MAX17048.
pub const I2C_SDA_PIN: Option<u8> = Some(4);
pub const I2C_SCL_PIN: Option<u8> = Some(5);
/// 7-bit addresses: PN7161 with I2C_ADR0 = I2C_ADR1 = GND, and the MAX17048.
pub const NFC_I2C_ADDRESS: u8 = 0x28;
pub const FUEL_GAUGE_I2C_ADDRESS: u8 = 0x36;
/// GPIO9 is the boot pad and GPIO18/19 are native USB: never assign them.
pub const RESERVED_PINS: [u8; 3] = [9, 18, 19];

// ---- Pairing ------------------------------------------------------------------------------------------------------------------------
/// Reduced advertising and connection transmit power during setup (dBm). UNCALIBRATED: measure on the assembled Orb and supported iPads.
pub const PAIRING_TX_POWER_DBM: i8 = -12;
/// Normal service power, restored after pairing. UNCALIBRATED.
pub const NORMAL_TX_POWER_DBM: i8 = 3;
/// The RSSI a setup connection must sustain (dBm). UNCALIBRATED; RSSI is a rough proximity proxy, not a distance or a security measure.
pub const PAIRING_MIN_RSSI_DBM: i8 = -55;
/// Below `PAIRING_MIN_RSSI_DBM - PAIRING_RSSI_HYSTERESIS_DB` the dwell restarts; in between it neither advances nor resets (no flapping).
pub const PAIRING_RSSI_HYSTERESIS_DB: i8 = 4;
/// Samples averaged before comparing with the threshold.
pub const PAIRING_RSSI_SAMPLE_WINDOW: usize = 4;
/// PROPOSED: how long the signal must stay strong.
pub const PAIRING_PROXIMITY_HOLD_MS: u32 = 2_000;
/// PROPOSED: a peer that does not finish the application handshake by then is disconnected, so it cannot occupy the link.
pub const HANDSHAKE_TIMEOUT_MS: u32 = 5_000;

// ---- Liveness -----------------------------------------------------------------------------------------------------------------------
/// PROPOSED: the terminal's authenticated heartbeat interval and the point at which the Orb treats the session as lost.
pub const TERMINAL_HEARTBEAT_INTERVAL_MS: u32 = 2_000;
pub const TERMINAL_HEARTBEAT_TIMEOUT_MS: u32 = 6_000;

// ---- Reset card and recovery --------------------------------------------------------------------------------------------------------
/// The deliberately copyable reset card: one NDEF Text record whose text is exactly this (case-sensitive ASCII).
pub const RESET_CARD_TEXT: &str = "SAY_GOODBYE";
/// PROPOSED: after USB power appears (or boot with USB present) the Orb listens for the card this long.
pub const USB_RECOVERY_WINDOW_MS: u32 = 60_000;
/// UNCALIBRATED: after the window, short bursts of discovery with the field off in between.
pub const RECOVERY_POLL_INTERVAL_MS: u32 = 5_000;
pub const RECOVERY_SCAN_BURST_MS: u32 = 500;

// ---- Operations ---------------------------------------------------------------------------------------------------------------------
/// PROPOSED: how long a payment waits for a tap.
pub const SCAN_TIMEOUT_MS: u32 = 30_000;
pub const PAYMENT_REMINDER_DELAY_MS: u32 = 5_000;
/// The largest application message before fragmentation, and the largest URL a tap may carry.
pub const MAX_MESSAGE_LEN: usize = 256;
pub const MAX_URL_LEN: usize = 192;
/// Partly received messages are dropped after this long without the next fragment.
pub const FRAGMENT_TIMEOUT_MS: u32 = 2_000;
/// Unacknowledged events are resent with the same ids, up to this many times, this often.
pub const ACK_TIMEOUT_MS: u32 = 1_500;
pub const MAX_RETRIES: u8 = 3;
/// How long a result (green or red) is shown before the Orb returns to idle.
pub const RESULT_DISPLAY_MS: u32 = 3_000;

// ---- Audio scheduling (placeholder clips until recordings exist) ---------------------------------------------------------------------
/// At most this many clips wait behind the one playing; a clip already playing or queued is not queued twice.
pub const AUDIO_QUEUE_MAX: usize = 4;
/// A queued clip that has waited this long is dropped, so nothing plays long after the moment it described.
pub const AUDIO_QUEUED_MAX_AGE_MS: u32 = 4_000;
/// PLACEHOLDER clip lengths used until real recordings report their own end (ms). UNMEASURED.
pub const PLACEHOLDER_CLIP_MS: u32 = 1_200;
pub const PLACEHOLDER_VOICE_CLIP_MS: u32 = 2_000;

// ---- Light animations (names and shapes are final, colors and timings are for tuning) --------------------------------------------------
/// Suggested render rate for the LED driver.
pub const ANIMATION_FRAME_MS: u32 = 33;
pub const STARTUP_SWEEP_MS: u32 = 1_200;
pub const BREATHING_PERIOD_MS: u32 = 3_000;
pub const BLUE_PULSE_MS: u32 = 1_500;
pub const ARC_PERIOD_MS: u32 = 1_600;
pub const ORANGE_PULSE_PERIOD_MS: u32 = 1_000;
pub const GREEN_SWEEP_MS: u32 = 600;
pub const RED_DOUBLE_PULSE_MS: u32 = 900;
pub const FADE_OUT_MS: u32 = 800;
pub const EMERGENCY_FLASH_PERIOD_MS: u32 = 500;
pub const IDENTIFY_BLINK_PERIOD_MS: u32 = 500;
/// How many LEDs the orange waiting arc covers.
pub const ARC_LEDS: usize = 9;

// ---- Reliable events and storage ------------------------------------------------------------------------------------------------------
/// Events waiting for a terminal acknowledgement (docs/ORB.md section 7).
pub const OUTBOX_CAPACITY: usize = 4;

// ---- Presentation and power ---------------------------------------------------------------------------------------------------------
/// Latest operating model (docs/ORB.md 2026-10-21): full-brightness animations; the earlier 50% cap is superseded. Validate the exact LED
/// revision, peak current and animation coverage on hardware before release.
pub const NORMAL_LED_BRIGHTNESS_CAP_PERCENT: u8 = 100;
/// Emergency and identify light are bounded. PROPOSED.
pub const EMERGENCY_LIGHT_MAX_MS: u32 = 600_000;
pub const IDENTIFY_LIGHT_MAX_MS: u32 = 10_000;
pub const DEFAULT_VOLUME_PERCENT: u8 = 70;
/// Battery warnings: once at each level, re-armed after the charge recovers by the hysteresis.
pub const BATTERY_WARN_PERCENT: u8 = 20;
pub const BATTERY_VERY_LOW_PERCENT: u8 = 10;
pub const BATTERY_HYSTERESIS_PERCENT: u8 = 3;
/// Battery telemetry is sent on change of at least this many points, on warning transitions and at least this often while connected.
pub const BATTERY_MIN_REPORT_DELTA_PERCENT: u8 = 1;
pub const BATTERY_REPORT_INTERVAL_MS: u32 = 60_000;
/// Below this the pack is treated as critical. UNCALIBRATED: validate with the chosen cell, protection circuit and fuel gauge.
pub const BATTERY_CRITICAL_MILLIVOLTS: u16 = 3_300;

#[cfg(test)]
mod pin_tests {
    use super::*;

    const ASSIGNED: [Option<u8>; 12] = [
        LED_DATA_PIN, LED_ENABLE_PIN, NFC_IRQ_PIN, NFC_VEN_PIN, AUDIO_BCLK_PIN, AUDIO_LRCLK_PIN, AUDIO_DATA_PIN, AUDIO_SHUTDOWN_PIN, USB_POWER_SENSE_PIN,
        CHARGE_STATUS_PIN, I2C_SDA_PIN, I2C_SCL_PIN,
    ];

    #[test]
    fn pins_are_unique_exposed_and_not_reserved() {
        // GPIO0-10 and 18-21 are the FH4X application pins; GPIO11 stays VDD_SPI.
        let exposed = |p: u8| p <= 10 || (18..=21).contains(&p);
        let mut seen = [false; 22];
        for p in ASSIGNED.iter().flatten() {
            assert!(exposed(*p), "GPIO{p} is not on the module");
            assert!(!RESERVED_PINS.contains(p), "GPIO{p} is reserved");
            assert!(!seen[*p as usize], "GPIO{p} is assigned twice");
            seen[*p as usize] = true;
        }
    }

    #[test]
    fn i2c_devices_do_not_share_an_address() {
        assert_ne!(NFC_I2C_ADDRESS, FUEL_GAUGE_I2C_ADDRESS);
    }
}
