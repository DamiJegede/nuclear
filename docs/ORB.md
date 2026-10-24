# Orb firmware and terminal integration plan

Updated: 2026-10-21. This is the planning reference for Orb behavior, BLE, recovery, NFC, lights, sound and power. It is not a claim that these features are implemented. Confirmed decisions below supersede earlier button-based pairing and signed reset-card proposals. Proposed defaults require implementation and hardware validation.

## 1. Confirmed product and hardware decisions

- Orb has no physical button.
- ESP32-C3-MINI-1-N4X; PN7161 NFC controller; 28 addressable WS2812B LEDs (supersedes earlier 20/25 counts); exact LED revision remains to confirm.
- Main PCB: 69 mm diameter, rigid FR-4 with double-sided assembly. Separate 40 mm FPC NFC antenna, 40 mm tail, approximately 12 mm below the tap surface. Antenna connector: 4-position SMT FPC connector and matching tail, using two positions for RF and leaving two unconnected. Antenna turns and matching remain engineering work.
- Battery: custom Grepow pack based on GRP7550040, same approximately 50 x 40.5 mm footprint, increased to 12 mm finished-pack thickness. Original 7.3 mm is also finished-pack thickness per owner clarification. Estimated capacity 2,400–2,500 mAh (approximately 9.1 Wh) is proportional, not supplier-confirmed. Built-in PCM; two-wire connection, no external battery NTC. Pack thermal protection must be confirmed by supplier rather than inferred from PCM.
- Battery termination: JST PHR-2; PCB header: JST S2B-PH-SM4-TB. Pin 1 = positive/red, pin 2 = negative/black, using JST numbered drawings. MAX17048 is the proposed I2C fuel gauge; charger selection remains open. USB-C external power and native USB programming/recovery with boot/reset test pads are specified in the engineer brief.
- Orb communicates with the terminal over BLE. The terminal communicates with the API. Orb has no internet requirement and holds no payment-tag decryption keys.
- NFC is activated for a requested operation; idle battery operation does not continuously scan.
- First run automatically enters pairing mode. Setup uses reduced BLE transmit power and sustained signal strength to encourage close proximity; normal service power/range returns after pairing.
- **Terminal connected means the bound terminal has completed the application handshake and its authenticated heartbeat is current. A BLE connection alone is not a terminal connection.**
- Reset uses a deliberately copyable NFC card containing the exact string `SAY_GOODBYE`. No signed, device-specific or one-time reset-card credential is required.
- Local reset is permitted only with external USB power, no authenticated terminal session, and no unresolved payment/approval operation. It clears local pairing, not backend ownership.
- Latest operating/power model uses full-brightness animations. Earlier 50% cap is superseded; exact animation coverage and output must be measured. Emergency lighting is a separate mode.
- `pairing_prompt` is required. `payment_reminder` includes voice after five seconds waiting for payment; this extends the earlier chimes-only audio requirement.
- GPIO assignments are NOT locked. Declare pins and board-dependent settings as top-level constants in one board configuration module so they can change without editing drivers. Do not invent GPIO numbers from this plan.

## 2. Existing implementation and gaps

`apps/orb-firmware` now contains the hardware-independent `no_std` Rust core for protocol v1 (`message`, `fragment`), controller, battery reporting/warnings, RSSI gate, NDEF URI/Text parsing, named feedback actions, and (added 2026-10-21) the audio scheduler (`audio`), the nonblocking LED renderer (`animation`), reliable event delivery (`outbox`, with the `EventAck` message) and the persistent-state interface (`storage`). The older `protocol`/`session` modules are v0 compatibility code. The matching Swift v1 messages are in `apps/merchant-terminal/Sources/NuclearTerminalKit/OrbMessages.swift`, with shared vectors in `docs/orb-protocol-vectors.md`.

Verified 2026-10-21: all 127 Rust unit tests and 18 Swift tests pass. This validates the pure logic, not running hardware. Implemented decisions include first-run pairing, proximity gating, handshake/heartbeat state, USB/reset-card eligibility, one-tap operation, unresolved-attempt blocking, correlated outcomes, named sounds/lights, battery hysteresis and message fragmentation.

Not yet built: ESP32-C3 runtime/HAL and board entry point; real BLE GATT/encryption/bonding integration; handshake proof verification/provisioning; PN7161 driver; the LED and audio *drivers* (the renderer and scheduler exist and are tested, nothing pushes their output to hardware); actual MAX17048/charger sensing; the flash implementation of `SlotStore` (the record format, two-slot alternation and torn-write tests exist against an in-memory store); the glue that feeds `outbox`/`audio`/`animation`/`storage` from the controller's actions; signed update pipeline. GPIO values are still unset.

Voice/sound trigger identifiers already exist for all requested events, including pairing_prompt and payment_reminder. Recorded audio files are explicitly deferred until later; their absence is not a blocker for the current logic work. Built 2026-10-21: `audio.rs` plays one clip at a time (startup then the pairing prompt in order), result clips (success, failure, scan) interrupt advisories (reminder, battery low), a clip already playing or queued is not repeated, a queued clip older than `AUDIO_QUEUED_MAX_AGE_MS` is dropped, `Action::StopAudio` removes a playing or queued reminder, volume and mute apply (mute empties the queue; lights are unaffected). Placeholder durations stand in until real clips report their own end (`AudioScheduler::finished`). The five-second reminder now starts on a new `Input::ReaderReady` (the driver reports the PN7161 actually polling), plays once, and is stopped by capture, cancel, timeout and disconnect; tests cover each.

ATT MTU includes overhead; derive fragment size from negotiated characteristic payload capacity. Rust/Swift v1 encoding exists, but final GATT UUIDs, authorization and compatibility behavior still need hardware integration. Reliable events (`StateChanged`, `TapCaptured`, `Error`) are kept in `outbox.rs` and resent unchanged, with the same message id, every `ACK_TIMEOUT_MS` up to `MAX_RETRIES` times until the terminal sends `EventAck` (opcode 0x0A, provisional); a newer state replaces an unconfirmed older one, taps and errors are never replaced, and a give-up is reported once. The Swift `OrbV1.EventReceiver` acknowledges every reliable event (also a duplicate) and delivers each once; `OrbV1.RetransmitQueue` resends terminal commands until the Orb's `CommandAck`. Preserve the existing Rust foundation; runtime, BLE stack and HAL selection remain to finalize.

## 3. Responsibilities

- Orb: local state, BLE connection/handshake, reader control, battery reporting, animations, audio, safe deadlines and recovery.
- Terminal: checkout creation, backend authentication/ownership authorization, payment submission and reconciliation, confirmed outcomes and settings.
- API: verify tag cryptography/counter, authorize money movement, enforce limits and idempotency, record ledger and ownership.
- Only an authenticated terminal message reporting a confirmed completed API payment can trigger payment success. Capturing a tag is not payment success.

## 4. State model

| State | NFC | Lights | Audio |
| --- | --- | --- | --- |
| Starting | Off | Brief startup sweep | startup_sound |
| Unpaired / pairing | Off except eligible recovery polling | Blue breathing | pairing_prompt; pairing result |
| Bound but disconnected | Eligible USB recovery polling only | Brief blue pulse, then off | terminal_disconnected once per episode |
| Connected idle | Off | Off | Silent |
| Awaiting payment | Requested discovery | Orange moving arc | payment_reminder after 5 s if no tap |
| Captured / processing | Off | Orange pulse | scan_notification once at capture |
| Completed | Off | Green sweep | success_notification |
| Declined | Off | Two red pulses | failure_notification (proposed addition) |
| Updating | Off | Blue progress | Silent |
| Shutting down | Off | Brief fade | shutdown_sound if power remains |

Charging and battery warnings are orthogonal to this state machine. A warning must not obscure or interrupt a payment result. NFC has one owner at a time: payment, lookup, staff approval or reset recovery.

## 5. BLE setup, handshake and reconnect

### First boot and pairing

1. No stored binding: automatically enter pairing mode, use reduced advertising TX power and play startup_sound followed by pairing_prompt (suggested phrase: “Place your terminal close to pair.”).
2. Terminal scans and ranks unpaired Orbs by signal strength. User selects/confirms the intended Orb; avoid automatically claiming whichever device happens to be strongest.
3. Collect a rolling sample window and require consistently strong RSSI for a proposed 2-second dwell. Enforce the proximity gate on Orb-side connection RSSI as well as terminal-side selection, where supported. Reset the dwell on insufficient signal; use hysteresis to avoid flapping.
4. Terminal reads stable device identity, model, firmware and protocol/capabilities; performs backend ownership authorization; completes the binding handshake.
5. Save the binding atomically only after successful authorization/handshake. Configure encrypted BLE and persistent bonding. Restore normal TX power, play pairing_successful, enter connected idle.
6. Failure leaves no partial active binding; play pairing_failed only for an explicit failed attempt, then return to pairing mode. Prompt once on entry, not continuously. Pairing-mode advertising/animation backoff for a device left unconfigured remains to tune.

RSSI is a proximity heuristic, not a reliable centimeter boundary, identity proof or security measure. Exact TX powers and thresholds must be calibrated with the assembled Orb and supported tablets. Do not apply the pairing RSSI threshold to normal operation or reconnection.

### Authorization and connection meaning

A MAC/Hello message and BLE bonding alone do not prove merchant ownership. Current backend claiming associates a reported UID with a terminal but does not yet provide firmware-verifiable binding authorization. Finalize the device provisioning and handshake proof before production (for example, a factory device credential plus API-signed binding). Do not put the terminal's backend bearer token or payment-tag keys on the Orb.

After reconnect, validate the stored terminal binding through a fresh handshake with replay protection; then accept authenticated heartbeats and operational messages. Ordinary GATT traffic or unauthenticated Ping/Pong must not extend session liveness or suppress reset eligibility. Bound-terminal authentication takes priority over an unauthenticated peer; disconnect peers that fail the handshake deadline, so occupying the BLE link cannot indefinitely block reconnection or reset scanning.

### Reconnect and disconnection

- Keep one authorized terminal binding. Power cycling preserves it; connection loss never opens general pairing automatically.
- Automatically advertise/reconnect to the bound terminal, silently. A replacement terminal requires authorized rebind or the physical reset flow.
- Track BLE link loss and authenticated application-heartbeat loss separately. Proposed heartbeat interval: 2 s; stale after 6 s. Negotiate practical link parameters on actual iPads; supervision timeout is not the same as heartbeat timeout.
- On loss: immediately stop NFC and reminder, mark any in-flight operation interrupted, play terminal_disconnected once and use a brief blue indication. Do not label an unknown payment outcome declined.
- Reconnect and reconcile before accepting another operation. Never automatically replay an old success animation/sound.

## 6. Reset NFC card and recovery scanning

### Eligibility

Reset requires all three: external USB power, no current authenticated terminal session, and no unresolved payment or approval attempt. A raw BLE connection is irrelevant. Check eligibility again immediately before executing reset, under the same state-controller serialization used for payment commands.

A copyable `SAY_GOODBYE` card intentionally provides physical-access recovery comparable to a reset button. Someone who can disconnect the terminal and access the powered Orb may reset local pairing; this is accepted. Backend ownership remains intact.

### Discovery policy (proposed scheduling defaults)

- On USB power insertion or boot with USB present, begin a 60-second recovery window if eligible. Inserting power must work without requiring a reboot.
- While externally powered and terminal-disconnected, continue periodic recovery polling after the window. Use short discovery bursts with the field off between bursts; exact timings need measurement. Hold the card at the tap surface until detection.
- When a terminal completes its authenticated handshake, stop recovery polling immediately. Payment/staff/lookup operations have exclusive reader access.
- Battery-only idle: NFC off. An ordinary terminal connection cannot authorize a reset that bypasses the disconnected-session condition.
- No continuous full-power RF field solely because USB is present. Evaluate the controller's low-power polling features as an optimization, not a prerequisite for recovery.

### Card format and action

Proposed interoperable encoding: a single NDEF Text record whose decoded text is exactly case-sensitive ASCII `SAY_GOODBYE`; parse the NDEF status/language fields correctly. No substring or URL match. Extend the existing URI-only parser accordingly. Recognize reset only inside the eligible recovery handler; the same card during a normal payment must not reset or be submitted as a payment credential.

On acceptance: stop polling, clear terminal binding and BLE bonds plus merchant-specific settings, preserve immutable device identity, firmware trust material and factory calibration, and reboot into first-run pairing with pairing_prompt. Make reset storage updates power-loss safe. Reset is local; it must not delete backend records, release ownership, erase firmware or change tag counters.

**Unresolved-attempt recovery remains an open implementation detail:** persist only attempt identifiers and phase, never raw credentials. Do not permanently strand reset after a crash: the terminal must reconcile through the API, and an owner-authorized service/reconciliation procedure must cover a missing terminal. A timeout alone is not proof that a payment failed; this exception requires a separate decision before implementation.

## 7. Payment and other scan operations

1. Terminal creates a checkout and chooses a stable attempt ID/idempotency key.
2. Terminal sends begin_payment with checkout/attempt IDs, amount/currency context and bounded timeout.
3. Orb validates session/state, acknowledges accepted readiness, starts orange animation and NFC. Start the reminder timer when the reader is actually ready.
4. Capture one supported tag URI; stop NFC immediately, cancel reminder, play scan_notification once; emit tap_captured correlated to the attempt.
5. Terminal sends the original URI to `POST /v1/terminal/payments` with checkout_id, credential `{type: "tag", url}` and the same attempt ID as Idempotency-Key.
6. Orb waits with NFC off. Terminal reports processing, confirmed completed, confirmed declined or unknown/reconciling status. Green/success only for completed; red/failure only for confirmed decline.
7. Present result, acknowledge it, then idle. A fresh declined attempt requires a fresh tap.

Proposed wait-for-tap timeout: 30 s. Reminder once after 5 s. A timeout before capture stops NFC without suggesting a debit. A timeout or cancel after submission is an unknown outcome until reconciled. Cancellation of the Orb reader does not cancel or reverse an API transaction. A new attempt cannot silently replace an unresolved one.

Separate operation purposes for payment, account lookup and staff authorization/refund approval. The current API consumes valid tag counters even on lookup/decline: do not lookup and then reuse the same proof for payment/refund. Apple/Google pass reading remains gated by platform/reader integration; do not advertise it as delivered firmware functionality.

Retransmit unacknowledged events with the same IDs during a live session; terminal deduplicates and retries the API with the same key. Buffer raw credentials only in volatile bounded memory, do not log them, and do not start a new debit just because an acknowledgement was lost. Recovery across reboot uses API result lookup rather than resubmitting missing credentials.

## 8. Protocol contract and remaining integration

Logical services: device information, battery, authenticated control and events; firmware update transport when designed.

| Terminal → Orb | Purpose |
| --- | --- |
| handshake / bind / resume | Establish or resume authorized session |
| heartbeat | Authenticated application liveness |
| begin_payment / begin_read | Start bounded scan with purpose and correlation |
| cancel | Stop matching reader operation; not financial reversal |
| payment_status / operation_result | Processing, completed, declined or reconciliation state |
| get_status / configure | Battery/state snapshot and allowed settings |
| set_light_mode | Bounded emergency-light or identify mode |
| update_* | Signed update transport; protocol pending |

| Orb → Terminal | Purpose |
| --- | --- |
| hello / capabilities | Stable identity, firmware, protocol, supported features |
| handshake_result / command_ack | Accepted/rejected with reason and message ID |
| state_changed | Current operational state |
| tap_captured | URI, purpose, attempt/event ID |
| battery_status | Charge telemetry and warnings |
| operation_timeout / error | Correlated error, not implied payment failure |
| update_progress | Upgrade state |

Every operational command/event needs a message ID; financial operations also need checkout/attempt correlation and session generation. Reject stale-session results and mismatched attempt IDs. Fragment and reassemble bounded messages, with length limits, ordering, timeout and duplicate handling. Define the exact GATT UUIDs, encoding, frame IDs, ACK/retry rules and compatibility negotiation jointly in Rust and Swift before hardware integration.

## 8a. Secure channel (Orb to terminal)

Implemented in `apps/orb-firmware/src/secure.rs`, `apps/merchant-terminal/Sources/NuclearTerminalKit/OrbSecure.swift` and `POST /v1/terminal/orb/bind` (`apps/api/src/lib/orbKeys.ts`); vectors in `docs/orb-protocol-vectors.md`, asserted by all three.

**Threat model.** A nearby attacker can see and replay BLE traffic, impersonate a terminal to an unbound Orb, impersonate an Orb to a terminal, and record a legitimate handshake. BLE bonding and RSSI are not relied on. Out of scope: a stolen terminal (its tokens are revocable), physical extraction of an Orb's flash (the key sits in secure storage or the eFuse HMAC peripheral; one Orb's key never exposes another's).

**Keys.** One primitive family: `PRF(key, label, parts...) = HMAC-SHA256(key, label || 0x00 || parts...)`. There is ONE fleet key, `K_orb` (32 bytes, secret `ORB_KEY_V1` on the API Worker), compiled into the firmware at build time (`ORB_KEY_V1=<64 hex> cargo build --release`, read by `option_env!` in `secure.rs`) and identical on every Orb; Orbs are not provisioned individually. A binding has `binding_id` (16 random bytes, issued by the API) and `K_bind = PRF(K_orb, "bind-key-v1", uid, binding_id)`, known to the Orb (stored with the binding), the API (derivable) and the one terminal that was authorized. The terminal never sees `K_orb`. Trade-off, accepted: anyone who extracts the key from one firmware image can forge bind authorizations for any Orb, so the key protects against nearby attackers and casual cloning, not against a determined reverse engineer of the firmware; the per-binding key and per-session keys still keep one terminal's data away from another's. Mitigations: protect the flash (read-out protection, flash encryption, secure boot) when the board is chosen, and rotate with a firmware release (`ORB_KEY_V2` beside V1, try the newest first).

**Messages.** `Hello` carries a fresh 16-byte `nonce_o` per connection; `HandshakeResult` carries a 32-byte `proof` (zeros when rejected). `Handshake.nonce`/`proof` carry the values below.

**Bind** (unbound Orb, proximity gate still applies):
1. The terminal reads `uid` and `nonce_o` from `Hello` and calls `POST /v1/terminal/orb/bind {uid, nonce}` with its terminal session. The API refuses an Orb held by another account (409), rate-limits (20 an hour per terminal), logs `orb.bind_authorized` (never the key) and answers `{binding_id, proof, bind_key}` with `proof = PRF(K_orb, "bind-auth-v1", uid, binding_id, nonce_o)`.
2. The terminal sends `Handshake{Bind, nonce = binding_id, proof}`. The Orb checks the proof in constant time against its own `K_orb`, `uid` and the `nonce_o` it just sent, derives `K_bind`, saves the binding, and answers `HandshakeResult{accepted, proof = PRF(K_bind, "orb-proof-v1", nonce_o, binding_id)}`.
3. The terminal checks that proof against `bind_key`, proving the Orb is genuine and holds the binding, then stores `bind_key` (Keychain, this terminal only).
An authorization is useless for another Orb (uid), another connection (nonce) or another binding id, so a recorded bind cannot be replayed. A bound Orb refuses Bind; rebinding needs the physical reset card.

**Resume** (bound Orb after any disconnect): the terminal sends `Handshake{Resume, nonce = nonce_t, proof = PRF(K_bind, "term-proof-v1", nonce_o, nonce_t)}`; the Orb answers with `PRF(K_bind, "orb-resume-v1", nonce_o, nonce_t)`. Both nonces are fresh per connection, so neither side's proof can be replayed. No API call is needed to reconnect.

**Frames.** After an accepted handshake with session generation `g`, each direction has its own key `PRF(K_bind, "session-t2o-v1" | "session-o2t-v1", nonce_o, binding_id, g)`. A sealed frame is `counter u64 BE || ChaCha20-Poly1305(ciphertext) || tag(16)`; nonce = 4 zero bytes then the counter; AAD = `01 || g`. Counters start at 1 and must strictly increase; a frame with an old counter is a replay, a failed tag never advances the counter, and a direction cannot be reflected back (separate keys). The plaintext is the existing protocol message (header + body); fragmentation applies to sealed frames. Heartbeats are sealed, so only an authenticated peer extends liveness.

**Operations.** Rotating the fleet key needs a firmware release carrying the new key and the API accepting both during the roll-out (not built; one key, version 1). Losing `ORB_KEY_V1` is recoverable only from the firmware build environment: keep a copy in the password manager. Not built: the link layer that seals and opens frames around `Controller`, board-side storage of the binding, wiring `Authorizer` into `Action::VerifyHandshake`, the terminal app's binding store.

## 9. Battery and power

Telemetry: percentage (with validity/unknown indication), millivolts, charging, external_power_present, low and critical. No battery NTC is planned; the existing optional temperature field should remain unknown unless an actual sensor is supplied. A PCM is protection, not a fuel gauge. Recommend a gauge for useful percentage reporting; voltage-only estimates need calibration and fluctuate with load. External-power presence must be detectable even when the battery is fully charged.

Report on connection, on charging/external-power changes, on >=1 percentage-point change, on warning transitions and at least every 60 s while connected. Proposed warnings: 20% once, 10% once, with hysteresis; critical refusal/shutdown uses validated hardware thresholds. Do not restart or drop a payment solely because a percentage warning crossed.

Idle: NFC standby, LEDs off, amplifier shutdown, BLE connected with validated low-power scheduling. Measure real power/black-pixel draw before declaring LED power gating mandatory. Model NFC on actual active duration: historical 5 s/min and LED 10 s/min were workload assumptions, not runtime quotas. Latest workload model: 28 LEDs at full brightness, 10 seconds total animation, 5 seconds NFC activity and 1.5 audio prompts per transaction. One transaction/minute is the normal-day scenario; three/minute is the busy scenario. These are energy-budget assumptions, not fixed firmware wait times: stop NFC promptly after capture. Voice clip duration and actual illuminated-pixel coverage remain unmeasured. At estimated 9.1 Wh pack energy, approximately 24 hours normal use is a target for typical moving animations, not an all-pixels-on or measured guarantee. Busy-day estimates discussed were approximately 6–9 hours depending on coverage/color; reset polling and real electronics loads require measurement.

No-button power behavior and genuine software shutdown/wake remain dependent on charger/power-latch design. A shutdown sound is only possible while firmware has energy/time to play it; do not promise sound on abrupt power loss.

## 10. Lights and audio

Animations run without blocking BLE, NFC deadlines or audio/state handling: `animation.rs` is a pure function of time (`Animator::render(now, &mut [Rgb; 28])` every `ANIMATION_FRAME_MS`), a new pattern replaces the old at once, repeating the pattern on show does not restart it, normal patterns are scaled by the brightness cap and Emergency ignores it (colors and curves are first guesses to tune). Latest model uses full brightness; idle dark. Validate exact revision, peak current and animation coverage before hardware release. Connection/pairing blue, awaiting/processing orange, success green, decline red. Exact color values, timings and brightness curve remain to tune. State transitions cancel obsolete animations immediately.

| Asset | Trigger |
| --- | --- |
| startup_sound | Successful cold boot |
| shutdown_sound | Controlled shutdown with power available |
| pairing_prompt | First-run/reset entry to pairing; suggested “Place your terminal close to pair.” |
| pairing_successful | New binding fully committed |
| pairing_failed | Explicit setup failure |
| terminal_disconnected | Authenticated terminal connection lost, once per episode |
| scan_notification | Requested tag successfully captured, once |
| success_notification | Confirmed completed payment |
| battery_low | Warning threshold with hysteresis |
| payment_reminder | Once after 5 s awaiting tap; suggested “Please tap to pay.” |
| failure_notification | Proposed addition for confirmed decline |

Recorded audio production is deferred until requested. Keep the existing clip identifiers and build/test scheduling using placeholders meanwhile. Eventually use local versioned audio assets; terminal sends event/status names, not streamed audio. Voice requires acoustic testing with the selected small speaker and enclosure. Speaker CMS-151103-088SP and MAX98357A remain candidates; verify assembly and hardware choice. PCM/ADPCM versus other encoding depends on flash/quality tests. Provide configurable volume/mute; visuals always remain. Result audio preempts reminder; do not overlap clips or play a queued reminder after capture. Startup/shutdown/pairing and warnings must not cause repeated nuisance sounds.

Emergency light: authenticated terminal command, separate from idle/payment behavior; bounded duration, battery protection and payment-state priority. Color/brightness and behavior on subsequent disconnection remain to finalize.

## 11. Firmware organization, constants and maintenance

Persistent state (`storage.rs`): a `SlotStore` trait of two fixed record slots; a 28-byte record (magic, version, sequence, binding flag, optional unresolved attempt ids and purpose, volume and mute, CRC-16) holds only that; saving writes the slot that does not hold the newest valid record, so power lost mid-write leaves the previous state (tested at every cut point), identical state is not rewritten, and two damaged slots load as unbound. Keep shared protocol/NDEF/state tests hardware-independent. Add separate modules for BLE/authorization, NFC driver, state control, LEDs, audio, power/battery, storage and updates. Serialize state-changing events through one controller; drivers perform actions without blocking it.

One top-level configuration module (Rust constants or equivalent in the selected runtime) contains:

- Hardware: LED_COUNT = 28; LED_DATA_PIN; NFC SPI SCK/MOSI/MISO/CS, IRQ and VEN pins; audio pins; power/charge sensing; optional gauge bus; USB reservations. Values remain unassigned until GPIO review.
- Pairing: PAIRING_TX_POWER, NORMAL_TX_POWER, PAIRING_MIN_RSSI, PAIRING_RSSI_SAMPLE_WINDOW_MS, PAIRING_PROXIMITY_HOLD_MS, HANDSHAKE_TIMEOUT_MS.
- Liveness: TERMINAL_HEARTBEAT_INTERVAL_MS, TERMINAL_HEARTBEAT_TIMEOUT_MS.
- Recovery: RESET_CARD_TEXT = "SAY_GOODBYE", USB_RECOVERY_WINDOW_MS, RECOVERY_POLL_INTERVAL_MS, RECOVERY_SCAN_BURST_MS.
- Operations: SCAN_TIMEOUT_MS, PAYMENT_REMINDER_DELAY_MS = 5000, message/reassembly limits, ACK/retry limits, result-display duration.
- Presentation/power: NORMAL_LED_BRIGHTNESS_CAP_PERCENT = 100 (aligned in config.rs 2026-10-21), battery report interval/thresholds/hysteresis, volume defaults and emergency-light limits.

Pin planning is the next separately authorized discussion. NFC antenna RF conductors are not MCU GPIO assignments. No physical button pin is required. Check ESP32-C3 bootstrap, flash, USB and module antenna constraints before assigning numbers.

Plan signed BLE-relayed firmware upgrades with rollback and USB recovery if hardware supports it. Reserve flash for update slots, assets and settings within the selected 4 MB module; signing/provisioning details are pending. Only report successful installed firmware to the API after boot validation.

## 12. API fit

- `POST /v1/terminal/orb/bind`: authorizes a bind for one Orb and one connection nonce (§8a).
- `PUT /v1/terminal/orb`: claim/pair using stable UID, model and software (ownership); the secure handshake is §8a.
- `PATCH /v1/terminal/orb`: report installed software.
- `DELETE /v1/terminal/orb`: backend unpair; not automatically a local factory reset.
- `POST /v1/terminal/checkouts`: create sale.
- `POST /v1/terminal/payments`: submit captured credential with idempotency key.
- `GET /v1/terminal/payments/:attempt`: recover recorded result; absence immediately after a request is not definitive proof it cannot still complete.
- Terminal/staff refund and lookup routes retain their existing authorization and single-use tap semantics.

Stable device UID must be independent of BLE privacy-address rotation. Backend account ownership survives local reset; transfer still requires authorized backend release. Do not give the Orb database or terminal bearer credentials.

## 13. Delivery and acceptance

1. Finalize versioned protocol and buttonless pairing/reset state machine in the existing Rust/Swift foundations; test via simulator.
2. Finalize GPIO/runtime/power choices, then integrate BLE, NFC, lights, audio and battery hardware.
3. Validate the entire checkout → tap → API result → indication flow and staff/lookup separation.
4. Exercise first boot, weak/fluctuating RSSI, unauthorized peer connections, failed handshake, returning terminal at normal range, and replacement terminal.
5. Exercise reset card with USB insertion (without reboot), USB absent, authenticated/unauthenticated connection, heartbeat loss, unresolved attempt, wrong NDEF text, and power failure during reset. Verify backend ownership is retained.
6. Exercise disconnect/reboot in every operation phase, duplicate/out-of-order frames, small MTU/fragment loss, delayed outcome, reader timeout and cancellation. No duplicate debit or false success.
7. Verify 5-second reminder is once per waiting attempt and canceled by capture; warnings do not mask outcomes; all 28 LEDs and audio remain within measured current/thermal limits.
8. Test battery reports against a reference, actual iPad reconnect/sleep behavior, BLE range, NFC antenna tuning and interrupted signed updates.

## References

- [ESP32-C3 BLE transmit-power control](https://docs.espressif.com/projects/esp-idf/en/v5.5.6/esp32c3/api-reference/bluetooth/controller_vhci.html).
- [Bluetooth SIG: RSSI is a rough proximity proxy](https://www.bluetooth.com/core-specification-6-feature-overview/).
- [PN7160/PN7161 controller documentation](https://www.nxp.com/docs/en/data-sheet/PN7160_PN7161.pdf).

These references explain capabilities; they do not establish measured Orb range, battery life, a selected Rust HAL or completed integration.

## 14. Next implementation work (recordings deferred)

1. Done 2026-10-21: constants aligned (LED_COUNT 28, full brightness); nonblocking animations; audio scheduler with placeholder clips; reminder starts on reader readiness with stop on capture/cancel/timeout/disconnect; event resend (`EventAck`); storage interface; Swift mirrors.
2. Next, still hardware independent: glue that drives `audio`, `animation`, `outbox` and `storage` from the controller's actions in one `tick`/`handle` loop with tests; a clip-finished input; storing a firmware/boot counter if needed.
3. Finalize GPIO and board runtime, then connect drivers and secure BLE/storage transport. Resolve reboot/reconciliation recovery before production.
4. Record and integrate audio later; validate intelligibility and energy with real hardware. Re-measure runtime against the confirmed custom pack capacity.
