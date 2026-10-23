# Scheme v2: tables, schema and reconciliation policy

The pre-launch rebuild (the dev database is rebuilt into a fresh schema before launch anyway, so none of this is a data migration). **Built on a local Postgres October 23, 2026** (status and the places the build differs from this plan are in "Status" below; the tables as built are in [TABLES.md](TABLES.md)); it is not deployed and nuclear-dev is untouched until the cutover. It follows the owner's decisions of 2026-10-22:

- **`transactions` is the source of truth** and is **immutable**: a row is written once with a final outcome (`completed` or `declined`) and never updated, so there are no status transitions. A correction (refund, return, reversal) is a new transaction. **Every transaction is wallet to wallet.**
- **Every account has a balance** (consumers, merchants, organizations).
- **Keep `fundings` and `passes`.** Keep important counters such as `wallets.spent_today`, and keep them easy to check.
- **Signed stateless tokens** for emailed links, and for sessions where that is safe.
- No bank-grade double-entry ledger: this is stored value.

Decisions made since (all locked): money moves are **SQL functions**; session tokens are **signed, last 90 days and are renewed by a refresh call at app launch; the `devices` table stays** (section 7); **no nullable sides**: every transaction is wallet to wallet; the system wallets are **Nuclear Bank** and **Nuclear Shop** (fixed UUIDs, wallet type `system`, no extra columns), and **every organization has its own escrow wallet** for held benefits; **orbs merge into terminals**; **`shop` and `tag_models` stay separate**; `declined` is a transaction; `refunds` and `settlements` are the workflow tables; `approved_by_account_id` becomes `account_id`; **`nuclear-dev` is dropped and rebuilt** (approved 2026-10-23).

Targets: a payment is one database round trip and about four row writes (today: about 24 statements and about 11 row writes), no hot-row ceiling for big merchants, no per-request database read for auth, and a reconciliation that is incremental and never scans history.

## Status (October 23, 2026)

| Phase | State |
| --- | --- |
| 0 Schema | Done. `migrations/0001_init.sql` (tables, triggers, the `txn` and `account_effects` views, the system account and wallets) and `migrations/0002_money_functions.sql`. |
| 1 Money core | Done. `app_send`, `app_pay_app`, `app_pay_tap` (with `app_pay_plan` and `app_pay_checkout`), `app_refund`, `app_refund_resolve` and `app_purchase`: one database call each (a send, an app payment and a refund are one statement in all). Self-rolling counters; `ensureDay`, the `programDay` middleware and the daily-reset cron are deleted. |
| 2 Funds and benefits | Done in TypeScript (low-rate paths): `releaseFunding` (`fund`), `settle`/`settle_return`/`collect` on item-level `settlements`, benefits on per-organization escrow wallets (`allocate`, `claim`, `move`), the CSV/API engine. Funding returns (`fund_return`) have a type and an effect but no code writes them yet (the sandbox rail never returns). |
| 3 Auth | Done. Signed 90-day tokens, `POST /v1/auth/refresh`, device row checked inside the money functions, agent key `last_used` stamped at most once a minute, signed email links, rate limits in a Durable Object. Terminals still compare their token hash in the terminal check (their own statement, not inside the money call). |
| 4 Reconciliation | Done: R0, R1, R2 (wallet counters, daily caps), R3 per account on demand (`/v1/admin/users\|merchants\|organizations/:id/check`), Run Check, nightly. **The nightly run is a full recompute** (the same cost class as the old ledger scans); the rolling 1/30 sample is the next step when volume needs it. Product `sold_today` is not yet checked against the day's rows. |
| 5 Orbs, docs, cutover | Orbs merged into terminals and the docs rewritten; the load test is done (below). **Not done:** the cutover (drop and rebuild nuclear-dev, deploy API and portals together, re-seed). |

### Load test (2026-10-23, temporary branch `loadtest-v2`, since deleted)

`scripts/load-money.mjs` against a PlanetScale Postgres branch with the v2 schema: **PS-80 (1 vCPU, 8 GB) with 2 replicas**, driven from a laptop in another region through PgBouncer (port 6432; the direct port refuses more than about 50 connections with `53300`), 3,000 consumers and 30 merchants, one call per money move (`app_pay_app`, 10 percent `app_send`), 20 seconds per run. Client round trip was about 100 ms, so latencies below are mostly network; the database-side numbers are the throughputs.

| Run | Connections | Throughput | p50 / p99 latency | Errors |
| --- | --- | --- | --- | --- |
| spread over 30 merchants, one taking 20 percent | 100 | 632 calls/s | 148 / 311 ms | none |
| same | 300 | 622 calls/s | 454 / 1,249 ms | none |
| same | 600 | 588 calls/s | 937 / 2,655 ms | none |
| payments only, 30 merchants, no hot one | 200 | 585 calls/s | 315 / 1,068 ms | none |
| **every payment to one merchant** | 200 | **208 calls/s** | 893 / 1,672 ms | none |

Reading: (1) no deadlocks, no unique violations, no declines across about 60,000 calls with 100 to 600 concurrent callers. (2) **One vCPU saturates at about 600 payments per second** (more connections only add queueing); that is the figure to scale with database size. (3) **A single merchant's balance row serializes at about 200 payments per second** (about 4.8 ms of lock hold per payment, almost all of it the commit's replicated write): a merchant that takes 20 percent of 1,000 tps (200 per second) is exactly at the ceiling, so the optional `shard` column on the merchant's balance (spread its writes, sum on read) should be built before a merchant is expected above about 150 per second. The in-database function keeps the lock to that commit instead of three network round trips (about 300 ms in production, which would have capped the same merchant at about 3 payments per second). Not measured: the Worker and Hyperdrive in front (add roughly 5 to 20 ms per request), a bigger cluster, and tap payments (the same function plus a tag row lock).

Differences from the plan above, all deliberate:

- `balances` keeps the names `ordinary_opening`, `opening_day`, `added_today` (the plan called them `opening`, `added_day`); the `CHECK (credit_spent <= credit_limit)` is enforced by the money functions, not as a table constraint (a restricted account is a reachable state).
- `checkouts` keeps `account_id` (the merchant) instead of `merchant_wallet_id`; the merchant's wallet side is its default wallet.
- `fund_return` runs from the account's wallet to Nuclear Bank.
- Readers use a view, `txn`, that gives a transaction its account-level columns (and lists pending and rejected refund requests), so the activity feeds, admin lists and support pages did not need rewriting; the money paths use the new tables directly.
- A signed token is used without a database read only for a consumer's owner session on a short list of routes (the balance, the activity, wallets, tags, and the send, payment and store-order calls). A **delegated wallet device**, a **business** and an **organization** always read the device row and the account (a primary-key read, no write), and so does every route not on the list.
- An organization's spendable funds are `shared_funds(account)`: balance less the escrow wallet. An organization's `balances.balance` therefore includes what it holds for employees, and the Overview's organization balance does too.
- Declined rows older than 90 days are purged nightly one week at a time (a range read on `created_at`), not by a full scan.

## 1. Table inventory (36 now, 29 target)

| Table | Verdict | Why |
| --- | --- | --- |
| `ledger_entries` | **drop** | Redundant: every transaction already names its two sides. Replaced by the reconciliation policy (section 8) |
| `checkout_items` | **drop** | Items become a JSON snapshot on the checkout and on the transaction (refunds already work this way) |
| `wallet_allocations` | **drop** | Earmark history is audit only; it goes to `logs` |
| `throttles` | **drop** | A database write per limited request. Use Cloudflare's rate-limit binding or a Durable Object |
| `account_tokens` | **drop** | Verify and reset links become signed, single-use tokens |
| `api_keys` | **drop (merge)** | One live key per organization: columns on `businesses`, like the agent key columns on `wallets` |
| `benefit_programs` | **drop (merge)** | One row per organization: columns on `businesses` |
| `settlements` | **keep, redefined** | One row per merchant per day (the per-item state that `payouts` would have held); run totals are a `group by` (section 5) |
| `refunds` | **new** | Refund requests awaiting approval (section 5) |
| `transactions` | **redesign** | Immutable, wallet to wallet, final outcomes only (section 3) |
| `balances` | keep, simplified | One row per account, including merchants and organizations (section 4) |
| `wallets` | keep, self-rolling counters | `spent_today` stays (section 4) |
| `fundings`, `passes` | **keep** | As decided |
| `orbs` | **drop (merge)** | Merged into `terminals` (section 11) |
| `devices` | keep | Push tokens, the list of a person's devices, revocation and session extension; no longer read or written on every request (section 7) |
| `checkouts` | keep, simplified | An open order a customer can pay; items are a JSON snapshot (section 5b) |
| `orders` | keep | Nuclear Shop orders (bands, cards, merchandise); the payment goes to the Nuclear Shop system wallet (section 5b) |
| `accounts`, `admins`, `admin_sessions`, `bank_accounts`, `businesses`, `terminals`, `staff`, `categories`, `products`, `tags`, `tag_models`, `shop`, `employees`, `benefit_runs`, `benefit_run_rows`, `uploads`, `logs`, `system`, `snapshots` | keep | Unchanged except where this document says otherwise |

`shop` and `tag_models` stay separate tables (decided).

## 2. What changes in behavior

- **A declined attempt is a transaction** with `status = 'declined'` and a `status_code`. Nothing moves; the row is the record, and a retry of the same request replays it through the unique idempotency key.
- **Pending things are not transactions.** A pending load is a `fundings` row, a pending refund is a `refunds` row, an ACH payout in flight is a `settlements` row. The transaction is written when the money actually moves.
- **Corrections are new transactions** of their own type (`refund`, `fund_return`, `settle_return`, `adjustment`).
- **No daily reset job.** Daily counters roll themselves (section 4); `ensureDay`, the `programDay` middleware and the cron reset are deleted.

## 3. `transactions`

Every transaction is from one wallet to one wallet, so every side exists and everything reconciles.

**System wallets are real rows in `wallets`**, owned by one system account (`accounts.type = 'S'`, "Nuclear"), created by the schema migration with **fixed UUIDs** held as constants in the code, so nothing is looked up. The wallet's `type` is `system` and its name says what it is; no other column is added.

| System wallet (name) | Fixed id | Role |
| --- | --- | --- |
| Nuclear Bank | `00000000-0000-7000-8000-000000000002` | the outside world: loads come from it, payouts and returns go to it, collections come from it |
| Nuclear Shop | `00000000-0000-7000-8000-000000000003` | the Nuclear store: the receiving side of purchases (bands, cards, merchandise) |

(The system account is `00000000-0000-7000-8000-000000000001`.) A `platform` wallet for fees can be added the day fees exist. Its `balances` row exists like every account's, but the money functions **never update a system wallet's or the system account's balance** (one hot row for every load or purchase); the nightly snapshot writes their derived values. A system wallet is never spendable, earmarkable or closable.

**Held benefits: one escrow wallet per organization** (wallet `type = 'escrow'`, owned by the organization, created at its sign-up, named "<Organization> escrow"). It is an ordinary earmarked wallet of the organization: its `balance` is the money held for unclaimed employees, taken out of the organization's spendable funds exactly as an earmark is today.

- **Credit to an employee with no account** (`allocate`): organization default wallet to its own escrow wallet. Same account, so the account balance does not change; the escrow wallet's earmark goes up.
- **Claim** (`claim`): organization escrow wallet to the employee's Benefits wallet. This is a real transaction from the business's wallet to the person's wallet, so the history is a simple join and there is no row that appears from nowhere: the chain is *organization wallet, escrow wallet (allocate), employee wallet (claim)*, and each step is a recorded movement.
- Who is owed what stays in `employees.balance` (a removed employee still holds theirs, as today). Reconciliation per organization: `escrow wallet balance = sum(employees.balance)` of that organization's unclaimed employees, and equally `sum(allocate into it) - sum(claim out of it)`.

```sql
CREATE TABLE transactions (
  id                     uuid PRIMARY KEY DEFAULT uuidv7(),
  type                   text NOT NULL CHECK (type IN
    ('fund','fund_return','send','pay','refund','purchase','allocate','claim','move','settle','settle_return','collect','adjustment')),
  status                 text NOT NULL CHECK (status IN ('completed','declined')),   -- written once, never changed
  status_code            text,                                       -- the reason when declined (insufficient_balance, spend_limit_exceeded...)
  from_wallet_id         uuid NOT NULL REFERENCES wallets (id),
  to_wallet_id           uuid NOT NULL REFERENCES wallets (id),
  amount                 bigint NOT NULL CHECK (amount > 0),         -- the full amount the receiving side is credited
  credit_amount          bigint NOT NULL DEFAULT 0 CHECK (credit_amount >= 0),   -- part covered by approved credit (pay), repaid (fund) or restored (refund)
  related_id             uuid REFERENCES transactions (id),          -- refund -> pay, fund_return -> fund, settle_return -> settle
  tag_id                 uuid REFERENCES tags (id),
  pass_id                uuid REFERENCES passes (id),
  terminal_id            uuid REFERENCES terminals (id),
  checkout_id            uuid REFERENCES checkouts (id),
  funding_id             uuid REFERENCES fundings (id),              -- fund and fund_return
  settlement_id          uuid REFERENCES settlements (id),           -- settle, settle_return, collect
  account_id             uuid NOT NULL REFERENCES accounts (id),     -- the account that acted or approved (see below)
  reference              text CHECK (length(reference) <= 64),
  idem                   text NOT NULL UNIQUE,                       -- one scoped key: 'send:<account>:<key>', 'pay:<merchant>:<key>', 'fund:<account>:<key>'...
  meta                   jsonb NOT NULL DEFAULT '{}',                -- items snapshot, benefit run id, adjustment reason: nothing that is queried
  created_at             timestamptz NOT NULL DEFAULT now(),         -- when it was written (for a completed row, the moment the money moved)
  CHECK ((status = 'declined') = (status_code IS NOT NULL)),
  CHECK (type = 'move' OR from_wallet_id <> to_wallet_id)
);
-- BEFORE UPDATE OR DELETE OR TRUNCATE: raise. (Only declined rows older than 90 days may be deleted, by the retention job.)
CREATE VIEW completed_transactions AS SELECT * FROM transactions WHERE status = 'completed';   -- every sum and reconciliation reads this
```

`account_id` is the account that performed the action or approved it: the sender for a send, the payer for an in-app payment, the merchant for a terminal payment, the approving owner or staff member for a refund, the claimant for a claim, the account holder for a load, and the system account for automated jobs and admin adjustments (the admin is named in `meta`). The account of a wallet side is its wallet's account, and a wallet never changes account, so attribution is stable. The account-level reads (a person's activity, a merchant's payments) go through `wallets.account_id`: one query per wallet merged in the application (most accounts have one wallet).

### Effect of each type on balances (the whole accounting model)

Balances are per account (shared funds); a system wallet side has no balance update. The `bank` and `shop` ids in this table are the fixed system wallets.

| Type | From wallet | To wallet |
| --- | --- | --- |
| `fund` | Nuclear Bank | `to` account balance `+ (amount - credit_amount)`, `credit_spent - credit_amount` |
| `fund_return` | | `to` account balance `- amount` (may go below zero: debt, blocks activity) |
| `send` | `from` balance `- amount` | `to` balance `+ amount` |
| `pay` | `from` balance `- (amount - credit_amount)`, `credit_spent + credit_amount` | merchant balance `+ amount` |
| `refund` | merchant balance `- amount` (may go below zero) | `to` balance `+ (amount - credit_amount)`, `credit_spent - credit_amount` |
| `purchase` | `from` balance `- amount` | Nuclear Shop (no balance row updated) |
| `allocate` | organization default wallet: account balance unchanged | the organization's escrow wallet: earmark `+ amount` |
| `claim` | the organization's escrow wallet: earmark `- amount`, organization balance `- amount` | employee Benefits wallet: its account balance `+ amount` |
| `move` | same account, between its wallets: net zero | |
| `settle` | merchant balance `- amount` | Nuclear Bank |
| `settle_return` | Nuclear Bank | merchant balance `+ amount` |
| `collect` | Nuclear Bank | merchant balance `+ amount` |
| `adjustment` | an admin-made correction, any wallets, reason in `meta` | |

A declined row has no effect on anything.

### Indexes on `transactions`: 16 now, 8 proposed

Each is justified by a query; nothing else is kept. Before any drop, run `EXPLAIN` on the real queries (this is a proposal, not a verdict).

| Index | Serves | Today's equivalent |
| --- | --- | --- |
| `pkey (id)` | lookups | same |
| `UNIQUE (idem)` | idempotency for every type, completed or declined, in one index | `idempotency_key`, `pay_idempotency_key` |
| `(from_wallet_id, created_at DESC, id DESC)` | a wallet's sends and payments, the daily-limit check, a person's activity | `from_account_idx`, `from_wallet_idx` |
| `(to_wallet_id, created_at DESC, id DESC)` | received, a merchant's payments and balance sums | `to_account_idx`, `to_wallet_idx` |
| `(created_at DESC, id DESC)` | admin main feed, the nightly snapshot's day range | `completed_at_idx` |
| `UNIQUE (checkout_id) WHERE type = 'pay' AND status = 'completed'` | one completed payment per checkout | `checkout_paid_key`, `checkout_idx` |
| `(related_id) WHERE related_id IS NOT NULL` | refunds already made against a payment | `related_idx` |
| `(terminal_id, created_at DESC) WHERE terminal_id IS NOT NULL` | a terminal's activity | `terminal_idx` |

Dropped: `from_account_idx`, `to_account_idx` (replaced by the wallet indexes), `tag_idx`, `pass_idx`, `settlement_idx`, `provider_ref_idx`. Foreign keys stay: they are lookups on the parent, not extra writes.

## 4. Balances and counters

```sql
CREATE TABLE balances (                       -- exactly one row per account of ANY type
  account_id       uuid PRIMARY KEY REFERENCES accounts (id),
  balance          bigint NOT NULL DEFAULT 0,
  credit_limit     bigint NOT NULL DEFAULT 0,  credit_spent bigint NOT NULL DEFAULT 0,
  balance_pending  bigint NOT NULL DEFAULT 0,   -- loads in flight (maintained with fundings)
  opening          bigint NOT NULL DEFAULT 0,   -- ordinary value at the start of added_day (daily cap, consumers)
  added_today      bigint NOT NULL DEFAULT 0,  added_day date,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (credit_spent <= credit_limit)
  -- consumers and organizations: balance >= 0 is enforced by the money functions (merchants may go below zero by policy)
);
```

- **Merchants and organizations have balances like everyone.** The earlier worry was a hot row: every payment to a big merchant locks its balance row. That is only a problem because the lock is held across about three network round trips today. With the money moves as one database call (section 6) the lock is held for the milliseconds of execution, which supports hundreds of payments per second per merchant. If a merchant ever outgrows that, add a `shard` column to the primary key, spread its writes and sum on read. Not needed now.
- **Counters roll themselves.** `wallets.spent_today` is kept, with `spent_day date` beside it:
  `UPDATE wallets SET spent_today = CASE WHEN spent_day = today THEN spent_today + x ELSE x END, spent_day = today`.
  A read treats a row whose `spent_day` is not today as zero. The same pattern gives `products.sold_today`/`sold_day` and the cap counters above (`opening` is taken the first time the row is touched on a new day). There is no daily job.
- **Reconciling counters is a cheap query** (section 8): today's `spent_today` equals the sum of today's completed rows for that wallet, through `(from_wallet_id, created_at)`.

## 5. Lifecycle tables (workflow state, not money)

Three tables hold state that `transactions` no longer can. A transaction is written only when money moves (or a request is declined).

```sql
fundings    -- kept: a load attempt created -> submitted -> cleared | failed | returned.
            -- On release a `fund` transaction is written; an ACH return after release writes `fund_return`.

settlements -- one row per merchant per day: (settle_date, merchant_account_id) unique, direction credit|debit, amount, bank_account_id,
            -- status submitted | settled | returned | failed, provider_ref, created_at, resolved_at. (The run-level table becomes this item-level one.)
            -- A payout (credit): the `settle` transaction is written when it is submitted (the money has left the balance); a bank return writes `settle_return`.
            -- A collection (debit): nothing moves until the bank confirms, then a `collect` transaction is written; collections in flight count against the debt.

refunds     -- refund requests awaiting approval: merchant_account_id, pay_transaction_id, amount, mode, items jsonb,
            -- status pending | approved | rejected, idem unique, approved_by, resolved_at, refund_transaction_id.
            -- A pending request reserves its amount; approval writes the `refund` transaction (a refund that needs no approval writes it at once).
```

## 5b. Checkouts and orders

Two different things are called orders:

- **A merchant's order is a checkout.** The terminal creates one (items or an amount) that the customer then pays by tap or in the app. It is workflow state (open, then paid or canceled; expired is derived from `expires_at`, so nothing needs a job), so it stays a table. v2 shape:

  ```sql
  checkouts (id uuid pk, merchant_wallet_id uuid, terminal_id uuid, reference text, total bigint,
             items jsonb,        -- [{product_id, name, unit_price, discount, quantity}], immutable: the snapshot at creation
             status text,        -- open | paid | canceled  (the one mutable field, written once at the end)
             expires_at timestamptz, created_at timestamptz)
  ```

  `checkout_items` is gone. Per-line refunded quantities are not stored on the checkout: an item refund's transaction carries `meta.items`, and the quantities already refunded are the sum over the payment's refund transactions (the `related_id` index), read while the payment row is locked (a row lock needs no write, so the payment stays immutable). The one-payment-per-checkout rule is the partial unique index on `transactions`.
- **An amount-only tap payment creates no checkout at all**: it is just a transaction. A payment with items from a terminal writes a checkout directly as `paid` (one insert). A merchant's Orders page lists checkouts; amount-only payments appear under Transactions.
- **A Nuclear store order is an `orders` row** (bands, cards, merchandise, with shipping or a download). Its payment is a `purchase` transaction from the buyer's wallet to the **Nuclear Shop** system wallet, linked by `orders.transaction_id`. `shop` and `tag_models` stay as the two catalogs.

## 6. Money moves as one database call

Today each money move is `BEGIN`, a batch of reads and locks, application logic, a batch of writes, `COMMIT`: about three round trips with row locks held the whole time (about 100 ms each in production). Proposal: **`pay`, `send`, `refund` and `purchase` become one SQL statement each** (a PL/pgSQL function or one statement with data-modifying CTEs), called with one `select`. In one round trip the database:

1. locks the two balance rows in a fixed order and the wallet row;
2. checks the idempotency key, both accounts' status and session epoch (section 7), limits, balance, daily counters and cap;
3. inserts the `transaction`, updates the balances and the wallet counters, marks the checkout paid;
4. returns the new transaction, or writes the `declined` transaction (nothing else changes) and returns it: still the same single call.

Result: **one statement and one round trip** on both the happy and the decline path, lock time in milliseconds, statements per request from about 24 to 1 to 3 (tap proof, if any), and about four row writes (transaction, payer balance, merchant balance, wallet) plus nine index entries. The logic is in SQL, which is harder to read than TypeScript, so keep it to these four functions, test them on the real local Postgres (the existing suites already do), and keep everything else (orders, benefits runs, settlement) in TypeScript.

## 7. Auth: a long-running session, renewed at launch, with no database read per request

What is wrong today: every authenticated request does `UPDATE devices ... RETURNING` to find the session and stamp `last_accessed_at`: one statement and one write, for every call. What stays: **the `devices` table** (push token, the list of a person's devices, the rolling 90 day expiry, sign-out).

**How the app works**: people do not sign in each time. The session is long-running and **renews when the app launches**, after the biometric check on the device.

- **The token is the session.** It is **signed** (`sub` account, `sid` the device id, `kind` owner or wallet, `wid` wallet, `iat`, `exp` 90 days from issue). Every request checks only the signature: **no database read and no write**.
- **Refresh** (`POST /v1/auth/refresh`, replacing today's `POST /v1/devices/session/extend`, which already runs on every launch and only rolls the expiry): called once at launch with the current token. In one round trip it
  1. checks the device row (not revoked, not expired) and the account's status, rolls `session_expires_at` to 90 days from now and stamps `last_accessed_at`;
  2. issues a **new token** (`exp` = the new expiry);
  3. returns what the app needs to draw its first screen: the **account**, the **balance summary** (balance, earmarked, credit limit and drawn, daily headroom), every **wallet** (type, status, earmark, limits, today's spending), the **tags**, and the Benefits wallets' employers. Today that is four separate calls.
- **The old token is not invalidated** by a refresh. Tokens are stateless, so nothing needs to be stored: if the new token never reaches the device, the old one keeps working until its own expiry. A device that launches at least once every 90 days stays signed in indefinitely; one that does not, hits the expiry and signs in again.
- **Forced sign-out** (an admin or support action, the person revoking a device, sign out everywhere, a password reset): the device rows are marked revoked. Money cannot move on a revoked device at once, because **every money move already reads the accounts' status in the same call and also reads the token's device row by id** (a primary-key lookup inside that call, no extra round trip) and refuses a revoked or expired one; a delegated wallet's own row is read the same way. The next refresh answers 401 and the app signs the person out. **Reads with a revoked token** (balances and history, not money) keep working until the token's own expiry, up to 90 days: **an accepted risk (owner, 2026-10-23: no revocation denylist, no KV)**. Two free mitigations: sensitive reads (profile, bank details, documents, device list, keys) also look up the device row, and the person's next app launch signs the device out. A suspended account is refused at refresh and in every money call.
- **No `auth_epoch`.** Revoking means marking device rows.
- **Emailed links** (verify email, reset password) are signed tokens with an expiry, no table. Reset is single-use because it carries a fingerprint of the current password hash, which changes when it is used.
- **Stay stateful:** admin sessions (high privilege, MFA, low volume); agent keys and organization API keys (random bearer keys; the money call compares the wallet's `key_hash`, a 60 second in-memory cache covers reads); terminals (their token's hash is compared in the money call).
- **Net**: about one statement and one write fewer on every authenticated request (the only per-launch cost is the refresh's single round trip), and `last_used` stamps on keys throttled to once a minute.

## 8. Reconciliation policy

The ledger's job (proving the numbers add up) moves to checks of increasing depth. Nothing is ever corrected automatically: a mismatch raises an alert, marks the day's snapshot `reconciled = false`, and is fixed by an admin-made `adjustment` transaction with a reason.

| Level | When | What | Cost |
| --- | --- | --- | --- |
| **R0 inline** | every money move | immutability triggers, `UNIQUE(idem)`, `CHECK`s (`credit_spent <= credit_limit`, no negative consumer or organization balance), wallet earmark bound | free |
| **R1 conservation** | nightly, incremental | Every completed row moves `amount` from one wallet to another, so the total effect is zero by construction. Check: the day's rows (from `completed_transactions`, grouped by type, table in section 3) account for exactly the change in `sum(balance) - sum(credit_spent)` since the previous snapshot, and the two system wallets (Nuclear Bank and Nuclear Shop) are the derived balances that make the whole scheme sum to zero; each organization's escrow wallet must equal its unclaimed employees' balances. The day's totals are stored on the `snapshots` row as the checkpoint | one day of rows |
| **R2 counters** | nightly | For wallets with `spent_day = D`: `spent_today = sum(D's completed rows)`; same for `products.sold_today` and the cap counters (accounts with `added_day = D`) | one day of rows |
| **R3 per-account** | rolling, 1/30 of accounts per night | Each account's `balance` equals the sum of its effects over all its transactions (through the wallet indexes). Every account is fully verified about every 30 days; Benefits wallets and every organization's escrow wallet (against `employees.balance`) are checked the same way by wallet | bounded, spread out |
| **R4 on demand** | admin Run Check | R1 and R2 now; one account's R3 from its page | one account |
| **R5 external** | when a bank provider exists | `fundings` and `settlements` against the provider's statements | provider |

Earmarks are the one number that can only be checked as a bound (total earmarked at most the account balance): their edits are logged, not transactions.

## 9. Other reductions and retention

- Amount-only payments no longer create a checkout row.
- `last_accessed_at` and key `last_used` writes are dropped or throttled (section 7).
- Rate limits leave the database (a Cloudflare binding or Durable Object).
- Declined transactions older than 90 days are purged (the one permitted delete), finished sessions after 30 days (already built). Audit `logs` unchanged for now.
- `snapshots` stays final once the day is over.

## 10. Plan

The work was a rewrite of the money core and the code around it, done on a local Postgres with the existing suites as the contract (they assert behavior through the API, so they keep their value; the ones that assert old table shapes are rewritten). **No deploy and no change to `nuclear-dev` until the last phase.** Portal-facing JSON keeps its shapes where practical: a declined transaction is still reported as `failed`, and a pending refund still appears in the lists as `pending` (read from `refunds`).

| Phase | Deliverable | Gate |
| --- | --- | --- |
| **0 Schema** | One v2 initial migration (documented columns in order); the system account, the Nuclear Bank and Nuclear Shop wallets with their constants, and the per-organization escrow wallet created at sign-up; the immutability triggers; the `completed_transactions` view; the 8 indexes | schema builds on a fresh Postgres; a test per trigger and constraint |
| **1 Money core** | SQL functions `send`, `pay`, `refund` (execute and approve) and `purchase`, each one call that locks, checks, writes and returns; TypeScript wrappers; self-rolling `spent_today`, `sold_today` and cap counters; ledger code, `ensureDay`, the `programDay` middleware and the daily-reset cron removed | payments, moneyedge, concurrency, wallets, walletbalance, caps, shop suites green; statement count per send and pay measured (target: 1 to 3) |
| **2 Funds and benefits** | `fundings` release (`fund`) and return (`fund_return`); `settlements` rows with `settle`, `settle_return` and `collect`; benefits on the per-organization escrow wallet (`allocate`, `claim`, `move`); the Benefits API and CSV engine; the daily-cap `move` rule | settlement, benefits, benefitsapi, org, orgjourney, programs suites green |
| **3 Auth** | Signed 90 day session tokens, the refresh endpoint (new token plus account, balances, wallets and tags; the old token stays valid), the `devices` row checked inside the money call, sensitive reads checking it too; signed email links; rate limits off the database; key `last_used` throttled; terminals check their token in the money call | adminauth, mfa, emailauth, ratelimit, mcp suites green; statements per authenticated request measured |
| **4 Reconciliation and stats** | R0 to R4 of section 8 as jobs and as Run Check; `snapshots` built from `completed_transactions`; the Overview and admin lists on the new tables | stats, snapshots, lists, retention, paging suites green; a deliberate mismatch is detected |
| **5 Orbs, docs, cutover** | Orbs merged into terminals (section 11); `TABLES.md`, `AGENTS.md`, `PROGRESS.md` rewritten; a load test on a database of the production plan with skewed traffic (one merchant taking 20 percent) | load test numbers recorded; then, **with the owner's approval**, reset `nuclear-dev`, deploy the API and all portals together, re-seed the demo data |

Risks: SQL functions are harder to read and debug than TypeScript (mitigation: only these four, each with focused tests on the real Postgres); the daily-reset and cap logic moves into rows that roll themselves (mitigation: the R2 check compares them with the day's transactions); cutover changes the API and every portal at once (mitigation: they ship together after a full local run).

Still open: whether the load test may use a temporary PlanetScale branch (needs owner approval). `nuclear-dev` will be dropped and rebuilt (approved), with the demo data re-seeded.

Compliance note: closed-loop stored value is not a bank, but it can still carry obligations (state money-transmitter and gift-card rules, unclaimed-property rules). This design keeps an immutable audit trail and a reconcilable total owed to customers, which is what those rules ask for, but confirm with counsel before launch.

## 11. Orbs merged into `terminals`

A terminal holds at most one Orb, and an Orb belongs to the account of the terminal it is paired with, so the `orbs` table is a one-to-one extension of `terminals`. Its columns move to the terminal:

```sql
ALTER TABLE terminals ADD
  orb_uid       text UNIQUE CHECK (orb_uid ~ '^[0-9A-F]{12}$'),   -- the Orb's MAC address, 12 uppercase hex
  orb_model     text,                                            -- hardware
  orb_software  text,                                            -- firmware version
  orb_paired_at timestamptz,
  CHECK ((orb_uid IS NULL) = (orb_model IS NULL) AND (orb_uid IS NULL) = (orb_software IS NULL));
```

- **Pair** (`PUT /v1/terminal/orb`, or the owner's `PUT /v1/terminals/:id/orb`): writes the three columns on this terminal. If the uid is already on another terminal of the same account it moves (the other terminal's columns are cleared in the same transaction); on another account's terminal it is 409; an Orb the terminal already had is replaced.
- **Free** (the owner's release): sets `orb_uid`, `orb_model`, `orb_software` and `orb_paired_at` to `NULL` on that terminal. The MAC address is then free for any account to claim, because the unique value is gone. There is no unpaired-Orb record any more.
- **Firmware update** (`PATCH /v1/terminal/orb`): sets `orb_software`.
- **Effects**: the merchant portal's Orbs page lists terminals that have an Orb (release is by terminal id); the admin terminals tab already shows the same fields; the `orbs` routes, the `require_business_account` trigger on `orbs` and the `orbs` foreign keys are removed.
