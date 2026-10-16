# Nuclear agent context

Nuclear is a closed-loop payment platform (NFC bands/cards, Apple/Google passes).
Architecture: Cloudflare Workers (TypeScript, Hono) -> Hyperdrive -> PlanetScale PostgreSQL 18.

The owner has authorized agents to keep this file current as the project changes. Update it whenever
a convention, approval rule, secret, migration status or repo layout changes.

## Repo layout

```
AGENTS.md  .mcp.json  package.json (npm workspaces)
scripts/      operator scripts (add-model, add-bands)
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
| Worker | `nuclear-api`, deployed at https://nuclear-api.a-space.workers.dev (version `016f5818`, 2026-10-15; crons `0 4`/`0 5 * * *`). `SANDBOX_FUNDING=true`, so anyone who can reach it can mint test balance: dev only |

Always run `pscale` with `--format json`; put `--org nuclear` on resource subcommands. Load the
`planetscale-pscale-cli-automation` skill before driving the CLI. Postgres branches apply DDL
directly (no deploy requests). A `PlanetScale` MCP server is configured in `.mcp.json` (optional).

### Migration status (keep current; there is no migrations table)

| File | Status |
| --- | --- |
| `0001_init.sql` | Applied to nuclear-dev/main |
| `0002_terminals_orbs.sql` | Applied to nuclear-dev/main |
| `0003_payments_refunds_staff.sql` | Applied to nuclear-dev/main (with `--force`, owner-approved, for its `DROP INDEX transactions_idempotency_key`) |
| `0004_products.sql` | Applied to nuclear-dev/main |
| `0005_checkouts.sql` | Applied to nuclear-dev/main |
| `0006_orb_uid.sql` | Applied to nuclear-dev/main (2026-10-15) |

All six are applied and frozen: never edit an applied migration, add a new numbered file. The database
has 19 tables and no data.

## Approval rules

- Read-only SQL and read-only `pscale` commands (`org/database/branch list`, `insights`, `inspect`, `select`) are allowed without asking.
- Ask the owner before: any DDL or write SQL against PlanetScale, creating/deleting branches, creating roles or credentials, Traffic Control or webhook changes, deploying the Worker, or changing secrets. `DROP` needs `--force` and explicit approval, after a read-only check that the tables are empty.
- Never commit connection strings, roles, passwords, keys or tokens. Secrets live in `apps/api/.dev.vars` (git-ignored) and Wrangler secrets. Never print a secret value.
- Local testing uses a throwaway local Postgres 18 (Homebrew `postgresql@18`) in the scratchpad, never PlanetScale.

## Secrets (Worker `nuclear-api`; mirrored in `apps/api/.dev.vars`)

| Name | Purpose |
| --- | --- |
| `JWT_SECRET` | HS256 secret for wallet magic-link JWTs and terminal session JWTs |
| `ADMIN_API_TOKEN` | Bearer token for `/v1/admin/*` (operator only). Set on the Worker and in `apps/api/.dev.vars`. Load it into your shell for the scripts with `export ADMIN_API_TOKEN=$(grep ^ADMIN_API_TOKEN= apps/api/.dev.vars | cut -d= -f2)`; never pass it as an argument |
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
- Orbs register on claim: `PUT /v1/terminal/orb {uid, model, software}` (or the owner's `PUT /v1/terminals/:id/orb`). `uid` is the Orb's MAC address (any separators/case, normalized to 12 uppercase hex); `id` stays a generated UUID. The terminal reads uid/model/firmware over BLE; an unknown uid creates the row owned by the claimer. One Orb per terminal: pairing moves it off its previous terminal and unpairs the terminal's previous Orb; an Orb owned by another account returns 409; re-pairing records the reported firmware. `PATCH /v1/terminal/orb {software}` reports a firmware update; `POST /v1/orbs/:id/release` (owner) frees an Orb so another account can claim it. No Orb rows are pre-loaded.
- Operator endpoints (`/v1/admin/*`, bearer `ADMIN_API_TOKEN`, 404 when unset; not account sessions): `POST /v1/admin/tag-models` creates a band/card model (`type, name, price` in cents, `quantity`, `photo?`, `currency?`, `country?`, `limited?`, `status?`); `GET /v1/admin/tag-models` lists models with tag and unassigned counts; `POST /v1/admin/tag-models/:id/tags {uids}` imports a supplier's UID list as unassigned tags (14-hex NFC UIDs, separators/case normalized, up to 5000 per request; the whole batch is validated first and one bad UID adds nothing; existing UIDs are reported, never changed). Scripts that replace the old AddModel/AddBands: `ADMIN_API_TOKEN=... npm run add-model -- --name ... --type band --price 29.99 --quantity 1000` and `npm run add-bands -- --model <id> --file uids.txt` (`API_URL` overrides the target).
- Tags (bands/cards) are factory inventory (`tags` rows with a `tag_models` model, unassigned), imported from the supplier list as above. Claim: `POST /v1/tags/claim {url, wallet_id?, label?}` (owner session): the customer taps the band with their phone and sends the URL; the proof is burned; the tag must be unassigned (409 `tag_already_claimed` otherwise) and goes to one of the owner's active wallets (default if omitted). A retry of the same tap returns the claim (200). Manage by tag id: `GET /v1/tags`, `GET/PATCH /v1/tags/:id` (label, locked, transaction_limit, wallet_id within the account), `POST /v1/tags/:id/reset` (clears wallet, label, lock, limit; keeps counter). A delegated device may only lock its own wallet's tags. Responses never expose the NFC UID.

## Not built yet

Pass issuance, real bank linking and funding, settlement and
payouts, business onboarding/profile, merchant staff login, rate limiting, password reset and email
verification, credit-limit approval flow.
