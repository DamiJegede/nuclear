//! What the Orb shows and plays. The controller only names these; the board's LED and audio drivers render them.

/// LED animations (docs/ORB.md sections 4 and 10). Normal output is capped at 50%; `Emergency` is a separate mode.
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum LightPattern {
    Off,
    StartupSweep,
    BluePulse,
    BlueBreathing,
    OrangeArc,
    OrangePulse,
    GreenSweep,
    RedDoublePulse,
    BlueProgress,
    Fade,
    Identify,
    Emergency,
}

/// Local, versioned audio assets. The terminal sends event names, never streamed audio.
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum AudioClip {
    Startup,
    Shutdown,
    PairingPrompt,
    PairingSuccessful,
    PairingFailed,
    TerminalDisconnected,
    ScanNotification,
    SuccessNotification,
    FailureNotification,
    BatteryLow,
    PaymentReminder,
}
