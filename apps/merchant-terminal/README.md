# Merchant terminal (iPadOS, Swift)

The point-of-sale app a business runs on an iPad. It creates orders, takes payments by tapping a customer's band, card or phone on the
paired **Orb** (the NFC reader, see `../orb-firmware`), handles refunds and restocking, and talks to `apps/api` only (the `/v1/terminal/*`
routes). The Orb has no internet: the iPad relays everything to the API over Wi-Fi or cellular, and talks to the Orb over Bluetooth LE.

## What is here

A Swift package, `NuclearTerminalKit`, with everything that is not UI, so it builds and tests with `swift test` on a Mac:

| File | What it does |
| --- | --- |
| `Money.swift` | Integer cents ↔ dollars text (the API only ever uses integer minor units) |
| `Models.swift` | `Codable` shapes for the terminal API: terminal, products, checkouts, payments, refunds, tap lookup |
| `APIClient.swift` | The terminal's bearer-token client: every `/v1/terminal/*` call the POS needs, idempotency keys, typed errors |
| `OrbMessages.swift` | Orb protocol v1 (`OrbV1`): messages, attempt ids, fragmentation and reassembly; same wire bytes as `../orb-firmware/src/message.rs` and `fragment.rs` (golden vectors in `docs/orb-protocol-vectors.md`) |
| `OrbProtocol.swift` | The Bluetooth frame format shared with the Orb firmware (`../orb-firmware/src/protocol.rs` is the other half) |
| `Tests/` | Request building, error decoding, money, and frame round-trip tests |

The SwiftUI app target does not exist yet. Create it in Xcode (File > New > Project > iOS App, "Merchant Terminal", iPad, SwiftUI) inside this
folder and add the local package as a dependency. Planned screens: sign-in with the terminal session token, catalog and cart, charge (waiting
for a tap), result, refunds (with the approval flow), restock, Orb pairing and firmware status, settings.

## How it works with the API

- **Sign-in**: the owner creates the terminal in the merchant portal and gets a **session token once**; the app stores it in the Keychain. A new
  session (or Sign Out) in the portal revokes it; the app then returns to the sign-in screen on a 401.
- **A sale**: `POST /v1/terminal/checkouts` (items or an amount), then the customer taps. The Orb sends the tap payload over BLE; the app posts
  `POST /v1/terminal/payments {checkout_id, credential: {type: "tag", url}}` with an attempt id as the `Idempotency-Key`. A retry with the same
  attempt id returns the recorded result, so a lost response is safe to retry. `GET /v1/terminal/payments/:attempt` recovers an outcome.
- **A tap is single use**: every verified tap burns its proof even if the payment is declined, and lookup (`POST /v1/terminal/lookup`) burns it too.
  Ask for a fresh tap after a decline.
- **Refunds**: `POST /v1/terminal/refunds`. With a write-staff tap the refund happens now; otherwise it may be queued (202) for the owner to
  approve in the portal. Pending refunds can be approved or rejected here with a write-staff tap.
- **Orb**: the app reads the Orb's MAC address, model and firmware over BLE and registers it with `PUT /v1/terminal/orb`.

## Run the package tests

```
cd apps/merchant-terminal
swift test
```

Targets: iPadOS 17 and later (the package also builds on macOS 14 so tests run without a simulator).
