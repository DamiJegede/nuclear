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
apps/mcp/       MCP server Worker `nuclear-mcp` for AI agents (stateless; calls the API through a service binding; `npm run mcp:deploy`; https://nuclear-mcp.a-space.workers.dev/mcp, version `ec27fe6e`)
apps/merchant-portal/   placeholder (merchant web portal)
apps/admin-portal/      admin portal (Vite + React): system overview, tags (model cards), admins, security; navigation Overview, Merchants, Users, Tags, Admins, with the admin's name (opens Security: two-step verification and recovery codes) and Transactions on the right; each page has its own URL (/merchants, /users, /tags, /tags/<id>, /admins, /transactions, /security); the UI says "tag" where the database says model; `npm run admin:dev|test|build`; hosted at https://nuclear-admin.a-space.workers.dev (Worker `nuclear-admin`, static assets, version `c6ada0e4`; `npm run deploy -w @nuclear/admin-portal`)
```

Specs, in authoritative order: `docs/TABLES.md`, `docs/BALANCE-POLICY.md`,
`docs/WALLET-ACCESS-POLICY.md`, `docs/PLATFORM-SCOPE.md`, `docs/FEATURE-SPEC.md`.
Run from the repo root: `npm install`, `npm run typecheck`, `npm run api:dev`, `npm run api:deploy`.
Cloudflare tooling note: `wrangler pages ...` now delegates to the unified Workers platform and refuses to run from the repo root; run Wrangler from inside the app's directory, never pass `--force` (legacy Pages) unless the owner asks, and never let its auto-setup rewrite `vite.config.ts` or `package.json` (it adds an unneeded Vite plugin).

## PlanetScale

| Setting | Value |
| --- | --- |
| Organization | nuclear |
| Database | nuclear-dev |
| Engine | PostgreSQL 18.6 |
| Branch | main (this is the dev database; migrations are applied directly to it) |
| Hyperdrive | config `6e47c72ff9934571ab4d21c0f2c40621`, binding `HYPERDRIVE`, caching disabled |
| Cloudflare account | `2e328fde1db62ab22f16e8f464562d3c` (pinned in wrangler.jsonc) |
| Worker | `nuclear-api`, deployed at https://nuclear-api.a-space.workers.dev (version `65b985e9`, 2026-10-15; crons `0 4`/`0 5 * * *`). `SANDBOX_FUNDING=true`, so anyone who can reach it can mint test balance: dev only |

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
| `0007_admins.sql` | Applied to nuclear-dev/main (2026-10-15): admins (with MFA columns) and admin_sessions |
| `0008_admin_access_tokens.sql` | Applied to nuclear-dev/main (2026-10-15, with `--force`, owner-approved, for its `DROP CONSTRAINT admins_access_id_check`) |
| `0009_drop_must_change_access_token.sql` | Applied to nuclear-dev/main (2026-10-16, with `--force`, owner standing approval) |
| `0010_tag_orders.sql` | Applied to nuclear-dev/main (2026-10-16, with `--force`: drops and re-adds two `transactions` check constraints). Adds the `purchase` transaction type, `tag_orders` and `tag_model_photos` |
| `0011_wallet_balance.sql` | Applied to nuclear-dev/main (2026-10-16): `wallets.balance` (earmarked funds) and `wallet_allocations` |
| `0012_wallet_key.sql` | Applied to nuclear-dev/main (2026-10-16): `wallets.key_hash`, `key_hint`, `key_last_used_at` (one agent API key per agent wallet) |

All twelve are applied and frozen: never edit an applied migration, add a new numbered file. The database
has 24 tables and no data.

## Approval rules

- Read-only SQL and read-only `pscale` commands (`org/database/branch list`, `insights`, `inspect`, `select`) are allowed without asking.
- **Standing authorization (owner, 2026-10-15): after each update that passes its tests, deploy it to Cloudflare** (`npm run api:deploy` for the Worker, `npm run deploy -w @nuclear/admin-portal` for the portal) without asking again, and smoke-test the live result read-only. Still ask for the things below, and apply any migration the update depends on *before* deploying code that needs it.
- **Standing authorization (owner, 2026-10-16): until the project goes live, apply every migration to nuclear-dev/main yourself** (including `--force` for DROPs; this is the dev database with no real data), right after local tests pass and before deploying code that needs it. Keep the migration table above current. This lapses when the owner says Nuclear is going live.
- Ask the owner before: any other DDL or write SQL against PlanetScale outside numbered migrations, creating/deleting branches, creating roles or credentials, Traffic Control or webhook changes, or changing existing secrets (a new secret that a requested feature needs may be added, never printed, and mirrored in `.dev.vars`). `DROP` needs `--force` and explicit approval, after a read-only check that the tables are empty.
- Never commit connection strings, roles, passwords, keys or tokens. Secrets live in `apps/api/.dev.vars` (git-ignored) and Wrangler secrets. Never print a secret value.
- Local testing uses a throwaway local Postgres 18 (Homebrew `postgresql@18`) in the scratchpad, never PlanetScale.

## Secrets (Worker `nuclear-api`; mirrored in `apps/api/.dev.vars`)

| Name | Purpose |
| --- | --- |
| `JWT_SECRET` | HS256 secret for wallet magic-link JWTs and terminal session JWTs |
| `ADMIN_API_TOKEN` | Operator bearer token for scripts calling `/v1/admin/*` (the portal does not use it; people sign in with an access id and password). Set on the Worker and in `apps/api/.dev.vars`. Load it into your shell for the scripts with `export ADMIN_API_TOKEN=$(grep ^ADMIN_API_TOKEN= apps/api/.dev.vars | cut -d= -f2)`; never pass it as an argument |
| `MFA_ENCRYPTION_KEY` | AES-256 key (base64, 32 bytes) encrypting admins' authenticator secrets at rest. Losing it makes every enrolled authenticator unrecoverable (operators then reset MFA and people re-enroll); rotating it needs a re-encryption step (stored values carry a `v1.` prefix for that) |
| `TAG_KEY_V1` | NTAG 424 PICC-data AES-128 key (32 hex) for tag URLs `/v1/<cipherHex>`; add `TAG_KEY_V2` etc. for new versions |

Optional vars: `ADMIN_ORIGINS` (browser origins allowed to call `/v1/admin/*`; localhost:5173 and the hosted portal in wrangler.jsonc), `APP_URL` (magic-link base), `DAILY_VALUE_CAP_CENTS` (default 200000),
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
- Admin portal: people sign in with an **Access ID and an access token** (`POST /v1/admin/login {access_id, access_token}`, public), then a code from their authenticator. (Customers' passwords are a separate thing and keep the name "password".) The Access ID is 12 uppercase characters (A-Z, 2-9 without look-alikes, starts with a letter) and always stored/shown uppercase (lowercase input is accepted); the access token is 32 characters (mixed case, digits, `-_.+=`). **The server generates both**: `POST /v1/admin/admins {name}` (any fully signed-in admin, or the operator token) returns `{admin, credentials:{access_id, access_token}}` **once**; only a hash is kept and the token can never be shown again. The portal's Admins page shows them with a download button. `admins.created_by` records who made each admin. Access Tokens are final: there is no forced replacement after sign-in and no change-token endpoint or screen (a lost or leaked token is rotated instead): `POST /v1/admin/admins/:id/rotate-token` (any fully signed-in admin, or the operator) saves a fresh server-generated token (hashed), ends the target's sessions (the caller keeps theirs when rotating their own) and returns the credentials once; the Admins page has a "Rotate Access Token" button per row (opens a modal: confirm, then the new token) and shows the new token masked with Copy and Download. Operators can still use `--reset-token`. Sessions are 8 hours (hashed in `admin_sessions`). Failures are all one answer; 5 wrong tokens or codes lock the account for 15 minutes. Operator-only (scripts): `ADMIN_API_TOKEN=... npm run add-admin -- --name "Jane Doe" [--save file]`, and `npm run manage-admin -- --list | --access-id ID --disable | --enable | --reset-token [--save file] | --reset-mfa`; `--reset-token` generates a fresh token (shown once, or saved to a 0600 file). `GET /v1/admin/me`, `POST /v1/admin/logout`. A wrong *current* token is 401 `invalid_credentials`; only `unauthorized` means the session ended. The operator token still opens the data endpoints and can create/list admins, but cannot change an access token. **Two-step verification (TOTP) is mandatory**: after the token step an admin without it can only call `/me`, `/logout`, `/mfa/setup`, `/mfa/enable` (everything else is 403 `mfa_setup_required`). `POST /mfa/setup` returns the base32 key and `otpauth_uri` (the portal draws the QR code); `POST /mfa/enable {code}` confirms and returns ten single-use recovery codes, shown once. Once enrolled, `POST /login` returns `{mfa_required, mfa_token}` (a 5-minute challenge JWT, not a session) and `POST /login/mfa {mfa_token, code}` takes the 6-digit code or a recovery code. Codes are RFC 6238 (SHA-1, 30 s, ±1 step), each usable once; wrong codes count toward the lock, and a correct token does not reset that count while MFA is pending. `POST /mfa/recovery-codes {code}` replaces the recovery codes. Lost phone: `--reset-mfa`. No audit log of admin actions beyond `created_by`; no admin roles.
- Handles (`accounts.handle`, 4-12 lowercase alphanumeric, unique, nullable) can be set or changed only by the primary account's own owner session.

## Domain rules worth remembering

- Daily job: a cron trigger (04:00 and 05:00 UTC, only the run landing on 00:00 America/New_York acts) resets `wallets.spent_today` and `products.sold_today`.

- **Wallet balance (earmarked funds)**: `wallets.balance` NULL = the wallet spends from the account's shared funds (default and person wallets); a number = money the owner set aside, a **hard limit**: the wallet spends and sends only up to it (no credit) with no other approval, and the rest of the account cannot spend it. Spendable for an unearmarked wallet = account balance minus everything earmarked (plus approved credit for payments). Agent wallets are created at 0 (pass `balance: null` to share, or a number to fund). Owner endpoints: `PUT /v1/wallets/:id/balance {balance: number|null}` (raise needs enough shared funds, else 422 `insufficient_shared_balance` with `available`; null releases), `GET /v1/wallets/:id/allocations` (history, also for that wallet's delegated session), wallet creation accepts `balance`. Declines are `wallet_balance_exceeded`. Incoming sends and refunds to an earmarked wallet raise its balance; closing releases it. `GET /v1/balance` adds `earmarked` and its `available_to_*` are the shared funds (a delegated session on an earmarked wallet sees that wallet's balance). Earmarks post nothing to the ledger (balances stay account-level) and are logged in `wallet_allocations`; stats reconciliation reports `earmarks_within_balances`. Money movements lock balances, then the wallet, so concurrent spends cannot overdraw a wallet.
- **Agent keys and MCP**: an agent wallet (type `agent`) can have one API key: `POST /v1/wallets/:id/key` (owner only) creates or rotates it (old key dies at once) and returns `nk_agent_<43 chars>` once; `DELETE /v1/wallets/:id/key` revokes; only the SHA-256 is stored; the wallet JSON shows `key: {hint, last_used_at}`; closing the wallet clears it, suspending it stops it working. A key is a bearer token with session kind `agent`: it behaves like a delegated wallet session for its wallet only (balance, activity, handle/recipient lookup, transfers, customer-confirmed payments, own tags) and is refused (403) on wallet management, devices, logout, account, shop orders and everything owner-only. The earmarked wallet `balance` is its hard spending limit. The `nuclear-mcp` Worker (apps/mcp) speaks MCP over Streamable HTTP at `/mcp` (POST only, JSON responses, `Authorization: Bearer nk_agent_...`), holds no secrets and no database access, and forwards the key to nuclear-api through a service binding. Tools: `get_wallet`, `lookup_recipient` (handle or email), `send_money`, `pay_merchant` (terminal_id + amount, or checkout_id) and `list_activity`; sends and payments require an `idempotency_key`. Agents cannot create wallets, change limits or manage keys. Not built: an owner screen for keys, per-transaction caps, recipient allow-lists.
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
- Operator endpoints (`/v1/admin/*`, bearer `ADMIN_API_TOKEN`, 404 when unset; not account sessions; CORS only for `ADMIN_ORIGINS`): `GET /v1/admin/stats` is the whole-scheme snapshot: `scheme` (net balance held, consumer/merchant split, merchant debt, pending loads, credit drawn/limit), `reconciliation` (account balances and credit vs the ledger, ledger balanced), `users` (consumers by status, new 7/30 days), `merchants` (total, active, transacting, terminals) and `payments` (sent, tapped, in_app, merchant_payments, total, refunds, loaded, plus today since 00:00 Eastern; completed transactions only, "tapped" = pay with a tag, "in_app" = customer-confirmed pay); `POST /v1/admin/tag-models` creates a band/card model (`type, name, price` in cents, `quantity`, `photo?`, `currency?`, `country?`, `limited?`, `status?`); `GET /v1/admin/tag-models` lists models with tag and unassigned counts; `POST /v1/admin/tag-models/:id/tags {uids}` imports a supplier's UID list as unassigned tags (14-hex NFC UIDs, separators/case normalized, up to 5000 per request; the whole batch is validated first and one bad UID adds nothing; existing UIDs are reported, never changed). Scripts that replace the old AddModel/AddBands: `ADMIN_API_TOKEN=... npm run add-model -- --name ... --type band --price 29.99 --quantity 1000` and `npm run add-bands -- --model <id> --file uids.txt` (`API_URL` overrides the target).
- Tags (bands/cards) are factory inventory (`tags` rows with a `tag_models` model, unassigned), imported from the supplier list as above. Claim: `POST /v1/tags/claim {url, wallet_id?, label?}` (owner session): the customer taps the band with their phone and sends the URL; the proof is burned; the tag must be unassigned (409 `tag_already_claimed` otherwise) and goes to one of the owner's active wallets (default if omitted). A retry of the same tap returns the claim (200). Manage by tag id: `GET /v1/tags`, `GET/PATCH /v1/tags/:id` (label, locked, transaction_limit, wallet_id within the account), `POST /v1/tags/:id/reset` (clears wallet, label, lock, limit; keeps counter). A delegated device may only lock its own wallet's tags. Responses never expose the NFC UID.

- Store (customer-facing): `GET /v1/shop/models` (public; models with status `available`, stock left and a price: `id, type, name, photo, currency, price` in cents, `limited, remaining, max_per_order`), `GET /v1/shop/models/:id`, `GET /v1/shop/models/:id/photo` (public, immutable cache). Buy: `POST /v1/shop/orders {model_id, quantity 1-20, wallet_id?, shipping:{name,line1,line2?,city,region,postal_code,country}}` with `Idempotency-Key`, owner session only: pays from the funded balance (never credit), debits buyer `funded_balance` / credits `platform_clearing`, raises `tag_models.sold`, writes a `tag_orders` row (201; a retry returns 200 with the same order, a different purchase under the same key is 409 `idempotency_mismatch`). Stock problems (404 `model_not_found`, 409 `sold_out` / `not_enough_stock`) are returned without recording anything; money problems (`insufficient_balance`, `spend_limit_exceeded`, `buyer_unavailable`, `account_restricted`) are 422 and recorded as a failed `purchase` transaction. Lock order: model, balances, wallet. `GET /v1/shop/orders`, `GET /v1/shop/orders/:id` (buyer only). A tag is attached at shipping (admin fulfilment is not built). Admin: `PUT /v1/admin/tag-models/:id/photo` takes the raw image (PNG only (signature checked), 256 KB max; the portal resizes to 256 x 256 PNG).
- Admin lists: `GET /v1/admin/merchants?q=` and `GET /v1/admin/users?q=` (name/handle(/email) filter, LIKE wildcards escaped, newest first, max 200; merchants carry balance, terminals, completed payments and volume; users carry balance, wallets and agent-wallet counts), `GET /v1/admin/transactions?kind=all|sends|taps|funds|agents&limit&cursor` (newest first, cursor `<ts>|<id>`; returns a `counts` object for every kind; taps = pay with a tag or pass; agents = sends/payments from wallets of type `agent`). Stats `payments.agents` (and `today.agents`) is a memo of agent-wallet sends and payments already counted in sent/tapped/in-app, so it is not added to the total.
- Tag pages (admin portal, UI says "tag" for the database's tag_models): `/tags` lists cards (click opens `/tags/<id>`; the last card is Add Tag); the tag page shows a static copy of the card plus Sales Ranking (`rank` = 1 + models with more sold, equal sales share a rank), Activated (tags assigned to a wallet), Provision Tags (button showing PENDING = max(0, quantity - tags loaded); opens a modal that reads the supplier CSV in the browser, extracts 14-hex UIDs, dedupes, and posts them in batches of 5000 to `POST /v1/admin/tag-models/:id/tags`) and Edit (the same modal as Add a Tag, titled Edit Tag, image optional). API: `GET /v1/admin/tag-models/:id` (model + `tags, unassigned, activated, pending, rank, models_total`), `PATCH /v1/admin/tag-models/:id` (partial; 409 `quantity_below_sold`, 409 `type_locked` once tags are loaded or units sold).
- Portal house style: Copy buttons turn into "Copied" (shared `CopyButton`, no separate notice; the merchant portal must reuse it when built); Access Token / Access ID always capitalised; every button reads "Abc Def" and every status is UPPERCASE (global CSS); confirmations are modals; secrets are masked with Copy and Download; photos are uploaded, never URLs.

## Not built yet

Pass issuance, real bank linking and funding, settlement and
payouts, business onboarding/profile, merchant staff login, rate limiting, password reset and email
verification, credit-limit approval flow.
