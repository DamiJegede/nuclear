# Nuclear agent context

Nuclear is a closed-loop payment platform (NFC bands/cards, Apple/Google passes).
Architecture: Cloudflare Workers (TypeScript, Hono) -> Hyperdrive -> PlanetScale PostgreSQL 18.

The owner has authorized agents to keep this file current as the project changes. Update it whenever
a convention, approval rule, secret, migration status or repo layout changes.

## Repo layout

```
AGENTS.md  .mcp.json  package.json (npm workspaces)
docs/         specs (authoritative order below)
migrations/   shared plain-SQL migrations
apps/api/     backend Worker (src/, wrangler.jsonc, .dev.vars)
apps/merchant-portal/   placeholder (merchant web portal)
apps/admin-portal/      placeholder (internal admin portal)
```

Specs, in authoritative order: `docs/TABLES.md`, `docs/BALANCE-POLICY.md`,
`docs/WALLET-ACCESS-POLICY.md`, `docs/PLATFORM-SCOPE.md`, `docs/FEATURE-SPEC.md`.
Run from the repo root: `npm install`, `npm run typecheck`, `npm run api:dev`, `npm run api:deploy`.

## PlanetScale

| Setting | Value |
| --- | --- |
| Organization | nuclear |
| Database | nuclear-dev |
| Engine | PostgreSQL 18.6 |
| Branch | main (this is the dev database; migrations are applied directly to it) |
| Hyperdrive | config `6e47c72ff9934571ab4d21c0f2c40621`, binding `HYPERDRIVE`, caching disabled |
| Cloudflare account | `2e328fde1db62ab22f16e8f464562d3c` (pinned in wrangler.jsonc) |
| Worker | `nuclear-api` |

Always run `pscale` with `--format json`; put `--org nuclear` on resource subcommands. Load the
`planetscale-pscale-cli-automation` skill before driving the CLI. Postgres branches apply DDL
directly (no deploy requests). A `PlanetScale` MCP server is configured in `.mcp.json` (optional).

### Migration status (keep current; there is no migrations table)

| File | Status |
| --- | --- |
| `0001_init.sql` | Applied to nuclear-dev/main (12 tables, `accounts.handle`) |
| `0002_terminals_orbs.sql` | Written and tested locally; NOT applied |
| `0003_payments_refunds_staff.sql` | Written and tested locally; NOT applied |
| `0004_products.sql` | Written and tested locally (categories, products with stock/status/sold counters); NOT applied. No owner CRUD for products/categories yet |
| `0005_checkouts.sql` | Written and tested locally (checkouts, checkout_items, transactions.checkout_id/items); NOT applied |

0002 to 0005 are unapplied, so they may still be edited in place. Once a migration has been applied
anywhere, never edit it: add a new numbered file.

## Approval rules

- Read-only SQL and read-only `pscale` commands (`org/database/branch list`, `insights`, `inspect`, `select`) are allowed without asking.
- Ask the owner before: any DDL or write SQL against PlanetScale, creating/deleting branches, creating roles or credentials, Traffic Control or webhook changes, deploying the Worker, or changing secrets. `DROP` needs `--force` and explicit approval, after a read-only check that the tables are empty.
- Never commit connection strings, roles, passwords, keys or tokens. Secrets live in `apps/api/.dev.vars` (git-ignored) and Wrangler secrets. Never print a secret value.
- Local testing uses a throwaway local Postgres 18 (Homebrew `postgresql@18`) in the scratchpad, never PlanetScale.

## Secrets (Worker `nuclear-api`; mirrored in `apps/api/.dev.vars`)

| Name | Purpose |
| --- | --- |
| `JWT_SECRET` | HS256 secret for wallet magic-link JWTs and terminal session JWTs |
| `TAG_KEY_V1` | NTAG 424 PICC-data AES-128 key (32 hex) for tag URLs `/v1/<cipherHex>`; add `TAG_KEY_V2` etc. for new versions |

Optional vars: `APP_URL` (magic-link base), `DAILY_VALUE_CAP_CENTS` (default 200000),
`SANDBOX_FUNDING` ("true" in wrangler.jsonc today: remove before any live-money deployment).

## Conventions

- Money: `bigint` integer minor units (USD cents), always JSON numbers bounded far below 2^53. Timestamps: `timestamptz`.
- IDs: `uuid DEFAULT uuidv7()` for anything that can leave the database; `bigint` identity only for internal-only rows (`ledger_entries`).
- Migrations: plain SQL in `migrations/`, numbered `NNNN_name.sql`, forward-only.
- Financial and authorization reads must not use Hyperdrive query caching.
- Every ID-taking endpoint authorizes by ownership (look up by id AND account), never by id alone.
- Idempotency: sends and refunds are unique per (type, source account, key); payments per (merchant, key). Terminal attempts are stored as `t:<attempt>`, customer-confirmed payments as `c:<payer account>:<key>`.
- Locks: use `FOR NO KEY UPDATE`, never `FOR UPDATE`, on rows that other tables reference (it deadlocks with FK key-share locks). Lock order: tag, original payment, both `balances` rows (ordered by account_id), then the wallet.
- A decline after authority checks is committed as a `failed` transaction with a `status_code`; request-validation errors are not recorded.
- Ledger is append-only and balanced per posting event (deferred trigger). Buckets: `funded_balance`, `credit_receivable`, `pending_funding`, `bank_settlement`, `platform_clearing`.

## Auth model

- Account holder: email + password (scrypt), session in `devices` (hashed token, rolling 90 days). Session kinds: `owner` (devices.wallet_id NULL) and `wallet` (delegated shared-wallet device from a 5-minute magic link).
- Merchant terminals are not devices. A terminal authenticates with its own HS256 JWT (aud `nuclear:terminal`, own expiry); `terminals.session_token_hash` stores the token's SHA-256 so it is revocable and single-active. Terminal sessions have no owner or wallet powers and only reach `/v1/terminal/*`.
- Handles (`accounts.handle`, 4-12 lowercase alphanumeric, unique, nullable) can be set or changed only by the primary account's own owner session.

## Domain rules worth remembering

- Daily job: a cron trigger (04:00 and 05:00 UTC, only the run landing on 00:00 America/New_York acts) resets `wallets.spent_today` and `products.sold_today`.

- Sends: funded balance only, never credit; same-account and business recipients are rejected.
- Payments: balance first, then approved credit; credit portion is journaled on the payment. A tag tap within wallet and tag limits is authorized (no step-up). Every verified tag tap burns its proof: the counter must advance and is consumed atomically with the outcome, even when declined, unassigned or locked. That includes tap lookup (`POST /v1/terminal/lookup`, which returns `account.{account_id, wallet_id, handle, display_name, photo, staff}`), so a tap used for lookup cannot also authorize a payment or refund.
- Pass (Apple/Google) taps on terminals return 501 until reader certification; passes pay through the customer-confirmed path `POST /v1/payments` (requires `terminal_id`).
- Refunds: against a completed payment, bounded by what is unrefunded minus pending (reserved) refunds (original row locked). The merchant balance may go negative; credit drawn by that payment is restored first. One create route, `POST /v1/terminal/refunds`:
  - terminal `allow_refunds = true` and no tap: refunds now, approver null.
  - a tap by merchant staff with role `write`: refunds now, `approved_by_account_id` = that account (the proof is burned with the refund; the POS sends the tap straight here, not via lookup).
  - no tap on an approval-required terminal, or a tap by someone who is not write staff: recorded as a **pending** refund (202, `status_code: awaiting_approval`). Nothing moves, no ledger lines, the customer does not see it, and its amount stays reserved. Pending refunds never expire; they stay until approved or rejected.
  - resolve pending refunds from the terminal (`GET /v1/terminal/refunds?status=pending`, `POST /v1/terminal/refunds/:id/approve|reject` with a write-staff tap) or the merchant owner (`GET /v1/refunds`, `POST /v1/refunds/:id/approve|reject`; the owner's account is the approver). Approve/reject are idempotent.
  - a tap that cannot be resolved (garbage, unknown, unassigned, locked, replayed) is an error, not a pending request.
- Orders: every payment settles a **checkout** (`checkouts` + `checkout_items`, prices and names snapshotted). Create one with `POST /v1/terminal/checkouts {items | amount, reference?, expires_in?}`, then pay it by tap (`POST /v1/terminal/payments {checkout_id, credential}`) or in the customer's app (`POST /v1/payments {checkout_id}`; `GET /v1/checkouts/:id` is the customer's preview). The old one-step bodies (`amount`/`items` on the payment) still work and create the checkout inside the same transaction; a declined one-step payment cancels it, a declined payment of an existing checkout leaves it open. `checkout_id` cannot be combined with `amount`/`items`.
- Stock is taken at payment (never at checkout creation): in the same transaction as a *completed* payment, tracked stock is decremented and `total_sold`/`sold_today` incremented; reaching 0 flips `status` to `sold_out` (DB trigger). Cart and checkout problems (sold out, not enough, inactive, not open, expired) are returned before the tap is consumed; a stock race lost after the tap is a recorded `declined` payment with no money moved. A retry of a recorded attempt returns the recorded result and does not re-price. Lock order: tag, checkout, products (by id), balances, wallet; refunds restock products before touching balances.
- Restock on the terminal: `POST /v1/terminal/products/:id/restock {quantity, expected_stock?}` (increments; untracked products refused). Terminal catalogue list: `GET /v1/terminal/products`.
- Item refunds: refund `mode: "items"` with `items: [{checkout_item_id, quantity}]` and `restock` (default **false**: send `restock: true` to put the units back on the shelf). Amount = snapshot net price x quantity. Per-line state is on `checkout_items` (`refunded_quantity`, `refund_pending_quantity`, kept in step under the original payment's row lock: pending reserves, completing moves to refunded, rejecting releases). The refund transaction carries `checkout_id` and a small `items` JSON of the lines it covers (its own record for approval/audit); there is no refund-items table. Units go back on the shelf only when `restock` is true and the refund completes. `full`/`partial` amount refunds never touch items or stock. `GET /v1/terminal/payments/:attempt` returns the order's items with `refundable_quantity` for building an item refund.
- Orbs: one per terminal. Pairing moves the Orb off its previous terminal and unpairs the terminal's previous Orb; an Orb owned by another account cannot be paired; an unassigned Orb is claimed by the pairing account.

## Not built yet

Tag claim/assign/lock/reset endpoints, pass issuance, real bank linking and funding, settlement and
payouts, business onboarding/profile, merchant staff login, rate limiting, password reset and email
verification, credit-limit approval flow.
