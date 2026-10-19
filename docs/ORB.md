# Orb firmware and terminal integration plan

Updated: 2026-10-19. This is the planning reference for Orb behavior, BLE, recovery, NFC, lights, sound and power. It is not a claim that these features are implemented. Confirmed decisions below supersede earlier button-based pairing and signed reset-card proposals. Proposed defaults require implementation and hardware validation.

## 1. Confirmed product and hardware decisions

- Orb has no physical button.
- ESP32-C3-MINI-1-N4X; PN7161 NFC controller; 20 addressable WS2812B LEDs (supersedes earlier 25/28 counts).
- Main PCB: 65 mm diameter. Separate 40 mm FPC NFC antenna, 65 mm tail, approximately 12 mm below the tap surface. Antenna turns and matching remain engineering work.
- Battery: Grepow GRP7550040 selected; final pack, protection location, charger, fuel gauge and temperature sensing remain to confirm. USB-C provides external power; data/recovery capability remains a hardware decision.
- Orb communicates with the terminal over BLE. The terminal communicates with the API. Orb has no internet requirement and holds no payment-tag decryption keys.
- NFC is activated for a requested operation; idle battery operation does not continuously scan.
- First run automatically enters pairing mode. Setup uses reduced BLE transmit power and sustained signal strength to encourage close proximity; normal service power/range returns after pairing.
- **Terminal connected means the bound terminal has completed the application handshake and its authenticated heartbeat is current. A BLE connection alone is not a terminal connection.**
- Reset uses a deliberately copyable NFC card containing the exact string `SAY_GOODBYE`. No signed, device-specific or one-time reset-card credential is required.
- Local reset is permitted only with external USB power, no authenticated terminal session, and no unresolved payment/approval operation. It clears local pairing, not backend ownership.
- Normal payment lighting uses a 50% maximum output setting. Emergency lighting is a separate mode.
- `pairing_prompt` is required. `payment_reminder` includes voice after five seconds waiting for payment; this extends the earlier chimes-only audio requirement.
- GPIO assignments are NOT locked. Declare pins and board-dependent settings as top-level constants in one board configuration module so they can change without editing drivers. Do not invent GPIO numbers from this plan.

## 2. Existing implementation and gaps

`apps/orb-firmware` contains a hardware-independent `no_std` Rust library: protocol encoding, NDEF URI extraction and a one-tap reader state machine. `apps/merchant-terminal` contains the Swift `NuclearTerminalKit` package, including API calls and a matching BLE protocol. Inspect their current tests and build status before implementation; README test-status statements may age.

Current frames are `Hello`, `ReadRequest`, `Cancel`, `TapRead`, `Failure`, `Ping`, `Pong`. The existing state machine returns to reader idle after capture; the full application must still retain the unresolved payment context while NFC is off.

The current 62-byte payload format has no fragmentation, correlation IDs, application authorization, battery or payment-result frames. Extend the Rust and Swift formats together under an explicit protocol version; this document does not allocate final wire opcodes or GATT UUIDs. ATT MTU includes overhead: never assume a 64-byte MTU permits a 64-byte characteristic value. Derive fragment size from the negotiated characteristic payload capacity and support smaller MTUs.

Earlier discussion suggested ESP-IDF/NimBLE. The repo now has a Rust foundation; hardware runtime, BLE stack and HAL selection remain to finalize for ESP32-C3. Preserve the shared Rust core rather than silently replacing it with C/C++.

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

## 8. Protocol contract to implement

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

## 9. Battery and power

Proposed telemetry: percentage (with validity/unknown indication), millivolts, charging, external_power_present, low, critical, and temperature only when supported by hardware. A PCM is protection, not a fuel gauge. Recommend a gauge for useful percentage reporting; voltage-only estimates need calibration and fluctuate with load. External-power presence must be detectable even when the battery is fully charged.

Report on connection, on charging/external-power changes, on >=1 percentage-point change, on warning transitions and at least every 60 s while connected. Proposed warnings: 20% once, 10% once, with hysteresis; critical refusal/shutdown uses validated hardware thresholds. Do not restart or drop a payment solely because a percentage warning crossed.

Idle: NFC standby, LEDs off, amplifier shutdown, BLE connected with validated low-power scheduling. Measure real power/black-pixel draw before declaring LED power gating mandatory. Model NFC on actual active duration: historical 5 s/min and LED 10 s/min were workload assumptions, not runtime quotas. Reset polling, voice and the new 20-LED count require updated measurements; earlier runtime estimates are not guarantees.

No-button power behavior and genuine software shutdown/wake remain dependent on charger/power-latch design. A shutdown sound is only possible while firmware has energy/time to play it; do not promise sound on abrupt power loss.

## 10. Lights and audio

Animations run without blocking BLE, NFC deadlines or audio/state handling. Normal cap 50%; idle dark. Connection/pairing blue, awaiting/processing orange, success green, decline red. Exact color values, timings and brightness curve remain to tune. State transitions cancel obsolete animations immediately.

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

Use local versioned audio assets; terminal sends event/status names, not streamed audio. Voice requires acoustic testing with the selected small speaker and enclosure. Speaker CMS-151103-088SP and MAX98357A remain candidates; verify assembly and hardware choice. PCM/ADPCM versus other encoding depends on flash/quality tests. Provide configurable volume/mute; visuals always remain. Result audio preempts reminder; do not overlap clips or play a queued reminder after capture. Startup/shutdown/pairing and warnings must not cause repeated nuisance sounds.

Emergency light: authenticated terminal command, separate from idle/payment behavior; bounded duration, battery protection and payment-state priority. Color/brightness and behavior on subsequent disconnection remain to finalize.

## 11. Firmware organization, constants and maintenance

Keep shared protocol/NDEF/state tests hardware-independent. Add separate modules for BLE/authorization, NFC driver, state control, LEDs, audio, power/battery, storage and updates. Serialize state-changing events through one controller; drivers perform actions without blocking it.

One top-level configuration module (Rust constants or equivalent in the selected runtime) contains:

- Hardware: LED_COUNT = 20; LED_DATA_PIN; NFC SPI SCK/MOSI/MISO/CS, IRQ and VEN pins; audio pins; power/charge sensing; optional gauge bus; USB reservations. Values remain unassigned until GPIO review.
- Pairing: PAIRING_TX_POWER, NORMAL_TX_POWER, PAIRING_MIN_RSSI, PAIRING_RSSI_SAMPLE_WINDOW_MS, PAIRING_PROXIMITY_HOLD_MS, HANDSHAKE_TIMEOUT_MS.
- Liveness: TERMINAL_HEARTBEAT_INTERVAL_MS, TERMINAL_HEARTBEAT_TIMEOUT_MS.
- Recovery: RESET_CARD_TEXT = "SAY_GOODBYE", USB_RECOVERY_WINDOW_MS, RECOVERY_POLL_INTERVAL_MS, RECOVERY_SCAN_BURST_MS.
- Operations: SCAN_TIMEOUT_MS, PAYMENT_REMINDER_DELAY_MS = 5000, message/reassembly limits, ACK/retry limits, result-display duration.
- Presentation/power: NORMAL_LED_BRIGHTNESS_CAP = 50%, battery report interval/thresholds/hysteresis, volume defaults and emergency-light limits.

Pin planning is the next separately authorized discussion. NFC antenna RF conductors are not MCU GPIO assignments. No physical button pin is required. Check ESP32-C3 bootstrap, flash, USB and module antenna constraints before assigning numbers.

Plan signed BLE-relayed firmware upgrades with rollback and USB recovery if hardware supports it. Reserve flash for update slots, assets and settings within the selected 4 MB module; signing/provisioning details are pending. Only report successful installed firmware to the API after boot validation.

## 12. API fit

- `PUT /v1/terminal/orb`: existing claim/pair using stable UID, model and software; not yet a secure hardware handshake.
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
7. Verify 5-second reminder is once per waiting attempt and canceled by capture; warnings do not mask outcomes; all 20 LEDs and audio remain within measured current/thermal limits.
8. Test battery reports against a reference, actual iPad reconnect/sleep behavior, BLE range, NFC antenna tuning and interrupted signed updates.

## References

- [ESP32-C3 BLE transmit-power control](https://docs.espressif.com/projects/esp-idf/en/v5.5.6/esp32c3/api-reference/bluetooth/controller_vhci.html).
- [Bluetooth SIG: RSSI is a rough proximity proxy](https://www.bluetooth.com/core-specification-6-feature-overview/).
- [PN7160/PN7161 controller documentation](https://www.nxp.com/docs/en/data-sheet/PN7160_PN7161.pdf).

These references explain capabilities; they do not establish measured Orb range, battery life, a selected Rust HAL or completed integration.
