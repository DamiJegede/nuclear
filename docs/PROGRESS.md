# Nuclear: progress

A record of what has been built, what is live, and what is still open. For rules and conventions see `../AGENTS.md`; for the data model see `TABLES.md` (this folder).

Last updated 2026-10-23.

## What it is

A closed-loop payment platform: NFC bands and cards, Apple and Google passes, customer wallets, merchant terminals (the Orb), a store, and AI-agent wallets.
Cloudflare Workers (TypeScript, Hono) → Hyperdrive → PlanetScale PostgreSQL 18.

## Scheme v2 (live since 2026-10-23)

The money core, the schema and the sessions were rebuilt on a local Postgres following [SCHEME-V2.md](SCHEME-V2.md) (its Status section lists what is done and what differs). In short: `transactions` is immutable and wallet to wallet (the ledger, `checkout_items`, `wallet_allocations`, `throttles`, `account_tokens`, `api_keys`, `benefit_programs` and `orbs` tables are gone; `refunds` is new and `settlements` is one row per merchant per day); system wallets Nuclear Bank and Nuclear Shop and a per-organization escrow wallet; send, pay, refund and purchase are SQL functions (one database call); counters roll themselves; sessions are signed 90-day tokens with `POST /v1/auth/refresh`; reconciliation runs over `account_effects`. 38 API suites pass, the portal suites pass. **Cutover done 2026-10-23**: nuclear-dev was rebuilt and the API and all three portals deployed together. Load tests: a temporary PS-80 branch (about 600 payments/s per vCPU; one merchant's balance row serializes at about 200/s; details in SCHEME-V2.md); a simulated week (6M transactions, 10k users, 10 tps, eight green nightly checks) on a local database; and a 14-day, 100k-user run on a temporary M-320 branch (results below once recorded). `seed-demo` has not been re-run on the new database.

## Live today (all deployed)

| Piece | Where | Version |
| --- | --- | --- |
| API Worker `nuclear-api` | https://nuclear-api.a-space.workers.dev | `f5b269e4` |
| Admin portal `nuclear-admin` | https://nuclear-admin.a-space.workers.dev | `636fd50b` |
| Merchant portal `nuclear-merchant` | https://nuclear-merchant.a-space.workers.dev | `6c98b572` |
| Organization portal `nuclear-organization` | https://nuclear-organization.a-space.workers.dev | `5abfec46` |
| MCP server `nuclear-mcp` (agent wallets) | https://nuclear-mcp.a-space.workers.dev/mcp | `da12a0e8` |
| Database | PlanetScale `nuclear/nuclear-dev` main, 29 tables, scheme v2 (2 migrations) | |
| Storage | R2 `nuclear-images` (public pictures), R2 `nuclear-uploads` (private files) | |

Quality: 38 API test suites (about 1,560 checks, run on a throwaway local Postgres), 167 admin-portal tests, 30 merchant-portal tests, 52 organization-portal tests, all passing. Every deploy is followed by a read-only smoke test.

## 1. Money core

- **Accounts, wallets, balances.** Customers (`C`) and businesses (`B`); every account has a balance row and a default wallet; extra person and agent wallets.
- **Append-only ledger**, balanced per posting event by a deferred trigger. Buckets: funded balance, credit receivable, pending funding, bank settlement, platform clearing.
- **Sends**: wallet to wallet, funded balance only, idempotent, with daily limits, a recipient daily cap, and declines recorded as failed transactions.
- **Payments**: balance first, then approved credit (the credit part is journaled on the payment). Paid by tag tap (`/v1/terminal/payments`) or in the customer's app (`/v1/payments`). Passes pay through the app path; terminal taps return 501 until reader certification.
- **Checkouts and orders**: every payment settles a checkout with item snapshots; stock is taken at payment, with sold-out handling.
- **Refunds**: full, partial or by items (with optional restock). Terminals can refund directly, with a write-staff tap, or queue a pending refund that the owner or an admin approves or rejects.
- **Earmarked funds**: a wallet can have its own balance as a hard spending limit; history is kept in `wallet_allocations`.
- **Tag taps**: NTAG 424 proof verification, a burned counter on every tap (even declined ones), and a lookup route.
- **Daily reset** of spent-today and sold-today at midnight New York, with a cron (04:00 and 05:00 UTC) plus a request-time catch-up for a missed run.
- **Rate limits** on login, signup, lookups, claims, shop orders and agent keys, stored in `throttles`.
- **Agents**: each agent wallet has one API key (`nk_agent_…`), and the `nuclear-mcp` Worker exposes `get_wallet`, `lookup_recipient`, `send_money`, `pay_merchant` and `list_activity` to AI agents.
- **Orbs and terminals**: terminals have their own session JWT; Orbs register on claim by MAC address, with pair, unpair and release.
- **Staff**: read or write staff on a business.
- **Sandbox funding** so test balances can be created.

## 2. Tags and the store

- Tag models (bands and cards) with photos, status, quantity and a sales ranking; supplier UID import (batches of 5,000); customer claim by tapping; tag management (label, lock, per-tap limit, move, reset).
- **Store**: customers buy tags and merchandise from their funded balance. A purchase writes a balanced ledger posting and an `orders` row (replaced the old `tag_orders`).
- **`shop` table** for merchandise: physical items (shipping address, optional stock) and digital items (a private file the buyer downloads after paying, no stock, quantity 1).
- Item pictures take any image format and are compressed to 256×256 JPEG; only tag pictures must be PNG.

## 3. Images, uploads and profiles

- **`nuclear-images`**: tags, shop, account photos, wallet photos and product images. The database stores only the R2 key (enforced by a CHECK), and the API builds the full URL (`/v1/photos/<key>`).
- **`nuclear-uploads`** (private): business documents and digital downloads, recorded in the `uploads` table.
- Account and wallet photos are uploaded after creation, cropped and compressed by the Cloudflare Images binding.
- **`accounts.bio`** (128 characters at most).

## 4. Admin portal

- **Sign-in**: server-generated Access ID and Access Token, mandatory authenticator-app two-step verification with recovery codes, lockouts, token rotation, and operator scripts.
- **Roles**: admin, accounting, sales, support, tags, merchants, each seeing its own pages and enforced per API route.
- **Pages**: Overview (scheme snapshot and reconciliation), Merchants, Users, Tags (cards, detail page, provisioning), Admins, Shop, Transactions, Logs, and Security.
- **Merchant and user support pages**: five top cards and tabs (details, terminals, staff, products, wallets, tags, devices, funding, orders). Actions: sign-out, unlock login, revoke agent key, suspend or reactivate, approve or reject refunds, sign a terminal out.
- **Transactions**: period filter, cards with counts, tinted rows (failed pink, refunds yellow, funding green), and rows that open to show the id, status, reason and sender › receiver with photos linking to their pages.
- **Audit trail**: an append-only `logs` table covering every admin action and customer security events, shown on the Logs page and each user's and merchant's Activity tab.
- **Business approval**: a new business starts pending. Admins read its document and approve or decline with a reason that is emailed.
- **Email merchants**: compose window with five templates plus Custom, for one merchant or an audience (active, pending, or both).
- **House style**: inverted hover, button capitalisation, uppercase statuses, confirm modals, masked secrets with Copy and Download, uploaded images instead of URLs.

## 5. Merchant portal (new)

- Email and password sign-in and sign-up; pending and declined businesses see only a review page with their status, any decline reason, and document upload.
- **Overview**: three large cards (profile with a circular crop window for the profile picture, Today with yesterday's figure, Catalog with today's best seller) and four small ones (Terminals, Awaiting Approval, Staff, Orders), all from one request.
- **Transactions** (with period filter and openable rows), **Orders** (open, paid, canceled, expired; cancel an open one), **Catalog** (categories and products, discounts, stock, pictures), **Terminals** (add, edit, new session token shown once and masked, pair or unpair an Orb), **Orbs**, **Staff** (add by handle), **Refunds** (approve or reject).
- **Profile**: read-only cards with an Edit button top right (business, payout bank with a payouts list, business details, documents), plus sessions.
- **Page cache**: pages remember what they loaded for five minutes, and a per-view Refresh icon reloads one view.
- New `/v1/business/*` API for transactions, overview, profile, payout bank, payouts, categories, products and checkouts.

## 5a. Organizations, Benefits wallets and Fixed Benefits (2026-10-19 to 2026-10-20)

- **Organizations** (account type `O`, migrations 0029 to 0032): an employer signs up, is active at once, keeps a profile (legal details, documents, sessions) and a funded wallet, and credits employees. Employees who have not claimed are held in escrow (`employee_escrow`, `employees.balance`) and claim with an emailed one-time token; a monthly reminder in the daily cron nudges them. Employees can be removed (hidden) when nothing is held for them.
- **Benefits wallets** (migration 0033): a wallet type bound to one employer. Claims and credits land there, never in an ordinary wallet. It pays any merchant (by choice or with its tag), buys from the store and takes refunds of its own purchases; the one thing it cannot do is send to another account. A same-account move to an ordinary wallet is bounded by the daily headroom. Refunds are never capped and never counted. Reconciliation checks each Benefits wallet against the ledger (`benefits_match_ledger`).
- **Benefit runs** (migration 0035): `benefit_runs` and `benefit_run_rows` are the one record of every credit run, whoever starts it (portal CSV, Benefits API or the scheduler); they replaced `credit_batches`.
- **Benefits API** (migration 0034 `api_keys`): `/v1/benefits-api/*` with a one-time `nk_org_` key; array endpoints to create or update, get, remove and credit employees, plus a balance read.
- **Fixed and Flexible Benefits** (migration 0036): every organization gets a `benefit_programs` row at sign-up; the portal asks it to choose a mode on its first sign-in. Fixed credits each employee's `fixed_benefit` automatically on a monthly, weekly or biweekly payment date (warning ahead, three days of retries, then missed); Flexible credits only on request. One-off CSV and API credits work in both modes.
- **Organization portal** (`nuclear-organization`, 44 tests): sign-up and sign-in, the mode and schedule windows, Overview, Employees (with a Fixed Benefit column in Fixed mode), Benefits (program card, CSV upload with Ready to Run checks, run history, a page per run with claimed and not-claimed reports), API (key and documentation) and Profile.
- **Tests:** 31 API suites pass, including `org`, `benefits`, `benefitsapi`, `programs` and `orgjourney` (an end-to-end organization journey from sign-up to reconciliation).
- **Removal never blocks on held credit** (2026-10-21, migration 0038): removing an employee only hides them; credit held for them stays theirs and claimable, and still counts as held.
- **Mass edit of employees** (2026-10-21): checkboxes and an action bar on the Employees page (Set Fixed Benefit, Clear Fixed Benefit, Remove); one all-or-nothing call, `POST /v1/org/employees/bulk`.
- **One daily value cap** (migration 0037): loads, incoming sends and Benefits-to-ordinary moves all use `cap - ordinary_opening - added_today - balance_pending`, kept on the `balances` row; organizations and businesses are exempt; refunds, claims and employer credits are never counted; `caps` suite (15 checks) and `daily_caps_match_ledger` reconciliation.
- **Open:** consumer claim, balance and move screens; real bank funding and a real ACH provider for settlement; employer verification, employee identification and program classification. See `ORGANIZATIONS.md` ("Not built") and the cap-rule note there: only Benefits moves use the opening-value measure.

## 5b. Terminal app and Orb firmware (scaffolds)

- `apps/merchant-terminal` (iPadOS, Swift): a Swift package with the terminal API client (checkouts, tap payments with attempt ids as idempotency keys, lookup, refunds, restock, Orb registration), money helpers, models and the Orb Bluetooth frame format. 18 `swift test` tests pass (including the Orb protocol v1 codec and fragmentation). The SwiftUI app target is still to be created in Xcode.
- `apps/orb-firmware` (Rust): compiles, 127 tests pass. `no_std` core following docs/ORB.md: protocol v1 messages and fragmentation, the Orb controller (pairing with proximity gate, authenticated sessions and heartbeat, payment/lookup flow, unresolved attempts, buttonless reset card, USB recovery polling, battery rules), NDEF URL and Text parsing, the audio scheduler, the nonblocking LED renderer, reliable event resend (`EventAck`) and the two-slot persistent-state interface. Swift mirror `OrbMessages.swift` and `OrbReliability.swift` (18 Swift tests, shared golden vectors, event de-duplication, command retransmit). Not built: board support (pins, HAL, BLE stack, PN7161/LED/audio drivers, the flash `SlotStore`), the handshake proof scheme, signed OTA.

## 6. Performance and reliability

- Fixed an N+1 on checkout lists (paid-orders list 3.6 s → 0.6 s); the merchant Overview is one request instead of ten.
- Money transactions now pipeline their statements, so balance row locks are held for about 3 round trips instead of about 14. Store purchases claim stock with one conditional update instead of locking the product up front. Responding to PlanetScale's weekly report (lock waits on `balances` and `tag_models`).
- New suites: `concurrency` (80 concurrent payments and sends) and `moneyedge` (30 send and pay edge cases).

## 7. Database

38 migrations, all applied to nuclear-dev: base schema, terminals and Orbs, payments and refunds, products, checkouts, admins and MFA, roles, throttles, system state, orders, shop, logs, uploads, photo keys, digital products, bio, settlements, bank number protection, organizations and employee escrow, Benefits wallets, API keys, benefit runs and benefit programs. `TABLES.md` documents every table and holds a "Pre-launch rebuild" table for columns whose logical position differs from where the dev migrations put them.

## 8. Tooling and data

- `scripts/`: `add-model`, `add-bands`, `add-admin`, `manage-admin`, `seed-demo` (about 1,000 customers and 25 merchants through the real API), `seed-businesses` (profiles, pending businesses with documents, test payout banks).
- Test logins: a business and six pending businesses with the demo password, listed in `AGENTS.md`.

## Open items and known gaps

- **Settlement job** built 2026-10-22 (`lib/settlement.ts`, daily cron): whole-net payouts and collections per active merchant with a bank, confirmation by the bank rail, reversals for returned payouts, resumable and idempotent; only a sandbox rail exists (no ACH provider chosen), and there is no admin screen for settlements yet. No new tables.
- **Email sending**: approval and merchant emails are not delivered until `EMAIL_FROM` is set to an address on a domain verified in Cloudflare Email Service. Until then the text is kept in the Logs.
- **Bank account numbers** are stored encrypted (AES-256-GCM, key `BANK_ENCRYPTION_KEY`, done 2026-10-19); routing numbers are public and stored as plain digits. Remaining: copy the key into the password manager, and consider a KMS or HSM-held key before launch.
- **Not built**: pass issuance, real bank linking and funding, merchant staff logins, merchant two-step verification, credit-limit approval flow, per-transaction caps and recipient allow-lists for agents.
- **Passkeys** (discussed, not built): need a final domain decided first.
- **Admin portal page cache**: only the merchant portal has it so far.
- **Before launch**: the v2 cutover above (the rebuild into a fresh database with the consolidated migrations), and resize the database from its current 1/16 vCPU PS-5.
