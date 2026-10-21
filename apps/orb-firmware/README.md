# Orb firmware (Rust)

The firmware for the **Orb**, the small NFC reader a merchant places on the counter. It reads the NTAG 424 DNA tag in a customer's band or
card and hands the tag's secure URL to the merchant's iPad over Bluetooth LE. The Orb has **no internet connection and holds no keys**: it
only relays what the tag says. The server (`apps/api`) checks the tag's cryptography and replay counter, and the iPad app
(`../merchant-terminal`) sends the payment.

```
tag  --NFC-->  Orb  --BLE-->  iPad (merchant-terminal)  --HTTPS-->  apps/api
```

## What is here

A `no_std` Rust library, `orb_firmware`, with everything that does not need hardware, unit-tested on a laptop (127 tests). It follows
`docs/ORB.md`. **Protocol v1** (`message`, `fragment`) is the current one; `protocol` and `session` are the older v0 one-tap format and
are kept only until the terminal app has moved over.

| Module | What it does |
| --- | --- |
| `config` | Every board and behaviour constant in one place. Pins are `None` until the GPIO review; PROPOSED / UNCALIBRATED values are marked |
| `message` | Protocol v1 messages (handshake, heartbeat, begin payment/read, cancel, payment status, configure, light mode; hello, acks, state, tap captured, battery, error) with message ids, session generation and 16-byte attempt ids. Opcodes are provisional |
| `fragment` | Splitting messages into BLE-sized fragments and bounded reassembly (duplicates ignored, stalls dropped) |
| `controller` | The state machine for ORB.md sections 4 to 10 (the five-second reminder starts on `Input::ReaderReady`, `Action::StopAudio` cancels it): pairing (bind needs proximity and a verified proof), sessions and heartbeat liveness, one reader owner, payment success only from an authenticated status, unresolved attempts that block new ones, buttonless reset by the `SAY_GOODBYE` card (USB power, no session, no unresolved attempt), recovery polling, battery warnings deferred while busy. Inputs in, actions out: no hardware, no clock |
| `proximity`, `battery` | The setup RSSI gate with hysteresis, and battery warnings and report throttling |
| `feedback` | Light patterns and audio clips (names only) |
| `audio` | The audio scheduler: one clip at a time, startup then pairing prompt in order, results preempt reminders and warnings, no repeats, stale clips dropped, `stop` cancels a playing or queued clip, volume and mute. Placeholder lengths until real clips report their end |
| `animation` | The nonblocking LED renderer: every pattern as a pure function of time into a 28-pixel frame, brightness cap (Emergency exempt), fade from the last frame |
| `outbox` | Reliable event delivery: unacknowledged `StateChanged`/`TapCaptured`/`Error` resent unchanged until `EventAck`, bounded, gives up after `MAX_RETRIES` |
| `storage` | The `SlotStore` trait and the two-slot record format (sequence + CRC) for the binding flag, unresolved attempt ids and volume; survives power loss mid-write; `MemStore` for tests |
| `ndef` | URL and Text record extraction, and the reset card check |
| `protocol`, `session` | v0 frames and one-tap state machine (to be retired) |

The Swift side is `../merchant-terminal/Sources/NuclearTerminalKit/OrbMessages.swift`; both assert the golden vectors in
`docs/orb-protocol-vectors.md`.

Not here yet: board support. Pins, the runtime and HAL, the BLE stack, the PN7161 and LED/audio drivers, the handshake proof scheme
(the controller only asks the board "is this proof valid") and signed updates need separate decisions (ORB.md section 13, step 2 on).

## Run the tests

Install Rust with [rustup](https://rustup.rs), then:

```
cd apps/orb-firmware
cargo test
```


## Behaviour to keep

- One tap per request. A successful read returns the Orb to idle; a second tap nobody asked for is ignored.
- Every frame fits one BLE write (payload at most 62 bytes), so a tap URL longer than that is refused rather than split.
- The Orb reports its MAC address, model and firmware in `Hello`; the iPad registers it with the API (`PUT /v1/terminal/orb`).
- Firmware updates: not designed. Likely over BLE from the iPad, with the new version reported back to the API.
