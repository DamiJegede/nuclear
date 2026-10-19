# Nuclear: progress

A record of what has been built, what is live, and what is still open. For rules and conventions see `AGENTS.md`; for the data model see `docs/TABLES.md`.

Last updated 2026-10-19.

## What it is

A closed-loop payment platform: NFC bands and cards, Apple and Google passes, customer wallets, merchant terminals (the Orb), a store, and AI-agent wallets.
Cloudflare Workers (TypeScript, Hono) → Hyperdrive → PlanetScale PostgreSQL 18.

## Live today (all deployed)

| Piece | Where | Version |
| --- | --- | --- |
| API Worker `nuclear-api` | https://nuclear-api.a-space.workers.dev | `ca882827` |
| Admin portal `nuclear-admin` | https://nuclear-admin.a-space.workers.dev | `324e4e17` |
| Merchant portal `nuclear-merchant` | https://nuclear-merchant.a-space.workers.dev | `a06a1cfc` |
| MCP server `nuclear-mcp` (agent wallets) | https://nuclear-mcp.a-space.workers.dev/mcp | `da12a0e8` |
| Database | PlanetScale `nuclear/nuclear-dev` main, 29 tables, 26 migrations applied | |
| Storage | R2 `nuclear-images` (public pictures), R2 `nuclear-uploads` (private files) | |

Quality: 25 API test suites (about 1,200 checks, run on a throwaway local Postgres), 156 admin-portal tests, 24 merchant-portal tests, all passing. Every deploy is followed by a read-only smoke test.

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

## 6. Performance and reliability

- Fixed an N+1 on checkout lists (paid-orders list 3.6 s → 0.6 s); the merchant Overview is one request instead of ten.
- Money transactions now pipeline their statements, so balance row locks are held for about 3 round trips instead of about 14. Store purchases claim stock with one conditional update instead of locking the product up front. Responding to PlanetScale's weekly report (lock waits on `balances` and `tag_models`).
- New suites: `concurrency` (80 concurrent payments and sends) and `moneyedge` (30 send and pay edge cases).

## 7. Database

26 migrations, all applied to nuclear-dev: base schema, terminals and Orbs, payments and refunds, products, checkouts, admins and MFA, roles, throttles, system state, orders, shop, logs, uploads, photo keys, digital products, bio, and settlements. `docs/TABLES.md` documents every table and holds a "Pre-launch rebuild" table for columns whose logical position differs from where the dev migrations put them.

## 8. Tooling and data

- `scripts/`: `add-model`, `add-bands`, `add-admin`, `manage-admin`, `seed-demo` (about 1,000 customers and 25 merchants through the real API), `seed-businesses` (profiles, pending businesses with documents, test payout banks).
- Test logins: a business and six pending businesses with the demo password, listed in `AGENTS.md`.

## Open items and known gaps

- **Settlement job** not built: the `settlements` table and `settle` transaction type exist, but nothing runs the daily cutoff, so there are no payouts yet.
- **Email sending**: approval and merchant emails are not delivered until `EMAIL_FROM` is set to an address on a domain verified in Cloudflare Email Service. Until then the text is kept in the Logs.
- **Bank numbers** are stored encrypted (AES-256-GCM, key `BANK_ENCRYPTION_KEY`, done 2026-10-19). Remaining: copy the key into the password manager, and consider a KMS or HSM-held key before launch.
- **Not built**: pass issuance, real bank linking and funding, merchant staff logins, merchant two-step verification, password reset, email verification, credit-limit approval flow, per-transaction caps and recipient allow-lists for agents.
- **Passkeys** (discussed, not built): need a final domain decided first.
- **Admin portal page cache**: only the merchant portal has it so far.
- **Before launch**: rebuild into a fresh database with consolidated migrations (see the rebuild table in `docs/TABLES.md`), and resize the database from its current 1/16 vCPU PS-5.
