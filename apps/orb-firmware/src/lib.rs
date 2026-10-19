//! Portable core of the Orb firmware: everything that does not touch hardware, so it is unit-tested on a laptop with `cargo test` and
//! later linked into the board support code (the PN7161 NFC front end and the Bluetooth LE stack). `no_std`, no allocation.
//!
//! * [`protocol`]: the BLE frames exchanged with the merchant terminal app (`../merchant-terminal` implements the same format).
//! * [`ndef`]: pulls the URL out of the NDEF message an NTAG 424 DNA tag returns (the secure-messaging URL the server verifies).
//! * [`session`]: the small state machine that decides what to do with each frame, tick and tag read.
#![cfg_attr(not(test), no_std)]

pub mod battery;
pub mod config;
pub mod controller;
pub mod feedback;
pub mod fragment;
pub mod message;
pub mod ndef;
pub mod protocol;
pub mod proximity;
pub mod session;

/// Firmware version reported in the `Hello` frame.
pub const FIRMWARE_VERSION: &str = env!("CARGO_PKG_VERSION");
/// Model name reported in the `Hello` frame.
pub const MODEL: &str = "Orb 1";
