# Cross River Bank API: what we learned (2026-10-25)

Source: https://docs.crossriver.com (read 2026-10-25). Nothing here was tested: we have no sandbox access yet. Items marked **UNKNOWN** are not in the public docs and must be asked of Cross River's Integration Team (Integrations.Support@crossriver.com).

## Products (https://docs.crossriver.com/apis)

Accounts (customer management, deposit accounts and subledgers), Cards, Payments (instant/RTP, card payments, international, **ACH**, wires, checks), onchain payments, lending. We need **ACH** first (settlement payouts, merchant collections, and later bank loads); wires, instant payments and the rest are not in scope for V1.

## Access

- **Static public IP allowlist**, also for the sandbox: the IP goes on the sandbox request form. After approval Cross River sends two emails: `client_id` and `partner_id`, then an encrypted one with `client_secret` and `webhook_secret`. A lost `client_secret` cannot be recovered (a new one is issued). Never commit them (`CR_ACCESS*` is git-ignored).
- **Token:** OAuth 2.0 client credentials. `POST https://idptest.crbcos.com/connect/token` (sandbox; lending uses `oauthtest.crbnj.net`), `Content-Type: application/x-www-form-urlencoded`, body `client_id`, `client_secret`, `grant_type=client_credentials`, optional `audience=https://api.crbcos.com/` and `scope`. Answer: `access_token` (a signed JWT), `scope`, `expires_in` (the sample shows 86400 = 24 h), `token_type: Bearer`. Reuse a token for its whole life and renew shortly before it expires. **The account locks after 3 wrong login attempts** (only the Integration Team unlocks it), so the server must fetch tokens from one place, never retry blindly, and never loop on a 401.
- **Sandbox base URLs** `https://sandbox.crbcos.com/<module>/`: `core/` (customers, deposit accounts), `ach/`, `wires/`, `checks/`, `rtp/` (instant), `cardmanagement/`, `international/`, `webhooks/`. **UNKNOWN:** production base URLs and auth server (given at go-live), the exact header (`Authorization: Bearer <token>` is the obvious one), rate limits, pagination, HTTP status codes.

## ACH (https://docs.crossriver.com/apis/payments/ach)

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/ach/v1/payments` | send one payment (push or pull) |
| POST | `/ach/v1/payments/{id}/cancel` | cancel (only while Pending or Hold) |
| POST | `/ach/v1/payments/{id}/reversals` | request retrieval of a payment sent in error |
| POST | `/ach/v1/payments/{id}/returns` | return an inbound payment |
| POST | `/ach/v1/client-batches` | send 2+ payments in one call (up to 5,000; request body UNKNOWN) |
| POST | `/ach/v1/client-batches/{id}/cancel` | cancel what has not yet been processed |
| GET | `/ach/v1/limits-utilization/{productId}[/{limitDate}]` | percent of the ACH limit used |
| POST | `/v1/payments/simulated-inbound-originations` | sandbox: simulate an inbound ACH (also funds a test account) |

**Create a payment** (`POST /ach/v1/payments`, header `Idempotency-key: <uuid>`): `accountNumber` (our Cross River originating account), `receiver {routingNumber (9), accountNumber (max 35), accountType Checking|Savings|GeneralLedger|Loan, name (max 22), identification (max 15)}`, `secCode` (Nacha, for example PPD, WEB, CCD), `description` (**max 10 characters**), `transactionType` **`Push`** (we send funds) or **`Pull`** (we collect funds), `amount` (integer cents), `serviceType` `Standard` (next business day) or `SameDay`, optional `clientIdentifier` (our id, "useful for idempotency"), `originator {name (16), identification (10), data (20)}` override, `addenda` (80), `extendedDetails` (conditional: `paymentType` S or R for a WEB pull, `cardTransactionType` for POS), `iatDetails` (IAT only). Response: `id`, `referenceId` (starts with A), `traceNumber`, `status` (starts `Created`), `posting`/`postingCode`, `effectiveDate`, `settlementDate`, `wasReturned`, `wasCorrected`, timestamps. **UNKNOWN:** how long an idempotency key is remembered and what a replay returns.

**Status lifecycle:** Created → Pending → (Hold) → Batched → Processing → **Completed** (final). Also Rejected (final), Canceled (final), Blocked (compliance). Rejection posting codes: ERR, RES, NSF, ANF, CLS, INA, DRM, ESC, CHR, STP. Once a payment is Completed its record never changes, **even if it is returned later**: a return is a new payment record of type Return linked to the original (`paymentType`: 0 Origination, 1 Return, 2 DishonoredReturn, 3 ContestedReturn, 4 NOC, 5 RefusedNOC). Most returns arrive within 2 business days, some later (R-codes R01-R85, for example R01 insufficient funds, R02 closed, R03 no account, R07 authorization revoked, R10 not authorized). A NOC (C01-C14) means the payment posted but some detail was wrong; `reasonData` holds the corrected value.

**Errors:** `{ errors: [{ code: int, message }] }`, for example 1000 validation, 2004 account not found, 2025 receiver account not found, 2003 cannot cancel in this status. HTTP statuses and an idempotency-conflict code are **UNKNOWN**.

**Windows (Eastern time):** same-day batches go at 10:00, 14:00 and 16:00 (transmission deadlines 10:30, 14:45, 17:45; settlement 13:00, 17:00, 18:00); standard batches at 10:00, 14:00, 16:00, 19:00 (Sun-Thu), 22:00 and 01:45. A same-day payment after the last cutoff keeps `serviceType: SameDay` but takes the next business day as its effective date. The windows can be changed in the contract. The doc itself has typos in two rows, so confirm the times with the bank.

**Prenote:** a $0.00 validation payment to check account details before sending is supported (useful when a merchant links a payout bank).

## Webhooks (https://docs.crossriver.com/apis/webhooks/cos-webhooks)

The tutorial says **do not poll for status or reconciliation; use webhooks.** Register with `POST /webhooks/v1/registrations {partnerId, eventName, type: Push|Poll|File, callbackUrl, authUsername?, authPassword?, format}`; `PUT .../ping` sends a test event (`isPing: true`). Events for ACH: `Ach.Payment.Sent` (transmitted to the Fed), `Ach.Payment.Rejected` (`postingCode`), `Ach.Return.Received` (`returnCode`), `Ach.Noc.Received` (`reasonCode`), `Ach.Batch.Canceled`. Payload: `id`, `eventName`, `status` (delivery status), `partnerId`, `createdAt`, `resources` (paths or URLs to fetch the object, which means a follow-up API call from the allowlisted IP), `isPing`, `details`.

- **Signature:** header `cos-signature: t:<timestamp>, v1:<signature>`; compute HMAC-SHA256 over `<timestamp>.<raw body>` with the `webhook_secret` and base64-encode (the sample script base64-decodes the secret first; confirm). Reject timestamps older than about 20 minutes. Each retry carries a new timestamp and signature.
- **Delivery:** at-least-once (duplicates possible), no ordering guarantee, three attempts, then the registration is **Suspended** and events queue (expire after 7 days) until it is restarted. The endpoint must return 2xx. Never delete and re-register after a failure (queued events are lost). Handlers must be idempotent (event `id`).

## Customers and accounts (core)

`POST /core/v1/cm/customers` (personal or business, with beneficial owners, identifications, addresses, phones, due diligence), `POST /core/v1/dda/accounts` (open a deposit account from a product id), `POST /core/v1/dda/subaccounts` (a subledger, "virtual account"), statements, restrictions. Whether Nuclear needs per-merchant or per-person customer records and subledgers, or only one pooled (FBO) account whose balance equals Nuclear Bank's wallet, is a **program decision for Cross River and compliance, not an API question**. Our ledger stays the source of truth either way.

## How this maps to Nuclear

| Nuclear | Cross River |
| --- | --- |
| Settlement payout (a `settle` credit row) | `POST /ach/v1/payments`, `transactionType: Push`, SEC code CCD (business account; to confirm), `serviceType: Standard`, `Idempotency-key` and `clientIdentifier` = our settlement row id |
| Collection from a merchant (debit row) | the same call with `Pull` |
| Bank load from a person (later) | `Pull`, SEC code WEB, `extendedDetails.paymentType` S |
| `settled` | `Completed` (final) |
| `returned` (`settle_return`) | `Ach.Return.Received` (arrives after Completed, in a separate record) |
| `failed` | `Rejected`, `Blocked`, or a 4xx on create |
| Our `confirm` (poll) | replaced by webhooks; a reconciliation read (`GET /ach/v1/payments/{id}`) only as a fallback |
| `description` | at most 10 characters (for example `NUCLEAR`) |

## Decisions and open questions

1. Where webhooks land: a public endpoint is needed. Either the Worker (simple; it verifies `cos-signature`, then asks the banking server to fetch the `resources` from the allowlisted IP) or the banking server itself. 
2. The access token must be fetched from the single allowlisted server and cached (24 h), with one refresh at a time and no retry loop (account lock after 3 failures).
3. Ask Cross River: production URLs and go-live steps, the Send-batch body, idempotency retention, HTTP status codes, rate limits, SEC codes allowed for our use (CCD for merchants, WEB for people), same-day eligibility and limits, and the program structure (FBO account, subledgers, customer records).

## Instant payments and the bank directory (read 2026-10-28)

Instant payments (https://docs.crossriver.com/apis/payments/instant-payments), base `https://sandbox.crbcos.com/rtp/`: `POST /v1/payments` (a single credit transfer: funding account number, amount in cents, creditor account and routing number; optional `networkPlatform` to pick the network, else the product's default), `POST /v1/payments/payment-request` (a request for payment: the other side must approve it, so it is **not a pull**), `POST /v1/payments/{id}/return-request` (recall of a sent payment, only if the receiver agrees), inbound return approve/reject, and `GET /v1/directory` (written `/rtp/v1/directory` in the tutorial; confirm in the sandbox). Networks: **CRNow** (Cross River's own, unlimited), **RTP** (The Clearing House, $1M) and **FedNow** ($500K), plus a daily send limit Cross River sets per partner. Statuses: created, pending, completed, rejected, canceled, timedout (a timeout is an unknown outcome: do not restore the balance until it is final). 24/7/365, so a close-out works on weekends and holidays. Not found in the docs I could read: the full request schema, idempotency, webhook event names, a status endpoint.

**Bank directory** (`GET /rtp/v1/directory?filter.routingNumber=<9 digits>`, also `filter.name`, `filter.participantId`, `filter.institutionRoutingNumber`): one entry per network the bank is on, with `networkPlatform` (`TCH` = RTP, `FedNow`), `receiveServices` (RTP: `CRDT` = it can receive a credit transfer; FedNow: `CTRO` receive only or `CTSR` send and receive), `name`, `institutionName`, `routingNumber`, `participantId`, `onlineStatus` (`SignedOn`). **No logo or image field.** A listed service does not guarantee that a specific account can receive (FedNow also registers each routing number separately), so the first real payout is the final test and falls back to same-day ACH. Error 2013 = not a valid RTP participant. A bank on no instant network has no entry (so no name from here).

How it maps to Nuclear: `banks.instant` = a `CRDT` on RTP or `CTRO`/`CTSR` on FedNow; `banks.networks` the networks found; `banks.name` the entry's name; the lookup runs on the banking server (the allowlisted IP) and the API calls it as `POST <BANKING_URL>/v1/banks/lookup`.
