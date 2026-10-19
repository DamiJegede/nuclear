# Organizations: employer-funded staff wallets

Implements the first slice of [ADOPTION-STRATEGY.md](ADOPTION-STRATEGY.md) and the ideas in [BRAIN-DUMP.md](BRAIN-DUMP.md). Migration 0030. Free for employers ($0 PEPM); the allowance is the organization's own money, never Nuclear revenue; Nuclear does not do payroll, withholding or tax reporting.

## Decisions (Dami, 2026-10-19)

- An organization is a new account type **O**. It signs up from the organization portal and is **active at once** (no approval step).
- A CSV is parsed in the browser and posted as rows; the API runs it as **one database transaction**: all of it or none of it. A batch whose total exceeds the organization's funded balance is refused whole, with nothing written.
- Employees who have **no Nuclear account yet** are credited into **escrow**: the money leaves the organization's `funded_balance` and is held in the ledger bucket `employee_escrow` (migration 0029), with the per-person amount in `employees.balance`. It posts as an **`allocate`** transaction. Employees who **already claimed** (have `employee_account_id`) get a normal **`send`** from the organization's default wallet to theirs.
- A person **claims** with the token in the email (never by email address alone, since email verification is not built): a **`claim`** transaction moves `employees.balance` out of escrow into their funded balance, the employee row is linked to their consumer account, the token is used up.
- Unclaimed credits **never expire**. A monthly reminder email (daily cron, employees last told 30 or more days ago, at most 200 per run) carries a **fresh token**; the old token stops working, so only the newest email's link claims.
- `amount` is only a CSV column. The `employees` table has no amount column.

## CSV

Header `employee_id,name,email,amount` (any order). `employee_id` is letters and digits (up to 64), immutable, and the key within the organization. `amount` is dollars, up to $100,000.00 per credit. Up to 2000 rows per file, an employee_id once per file. A known `employee_id` has its `name` and `email` updated from the file. The portal lists every problem with its line number and runs nothing until the file is clean.

## API (`/v1/org/*`, owner session of an active organization; others get 403 `organization_account_required`)

- `GET /overview`: `balance`, `employees {total, claimed, unclaimed}`, `held`, `last_batch`.
- `GET /employees?q&status=claimed|unclaimed`: up to 500, newest first.
- `POST /credit-batches {rows:[{employee_id,name,email,amount}]}` with `Idempotency-Key`: 201 (200 on a retry with the same key and rows, 409 `idempotency_mismatch` if the rows differ). Errors: 422 `insufficient_balance` (`required`, `available`), 422 `recipient_unavailable` (`employee_ids`), 422 `duplicate_employee_id`, 400 `invalid_request`. The answer carries `emails {sent, failed, not_configured}`; a held credit whose email was not sent is retried by the daily cron.
- `GET /credit-batches`, `GET /credit-batches/:id` (rows with `mode` sent|held).
- `POST /v1/employee/claims {token}`: any consumer owner session. 404 `invalid_token`, 422 `consumer_account_required`.
- Funding the organization's wallet uses the existing load route.

## Money rules

Lock order: the organization's `balances` row, then the recipients' `balances` rows (by account id), then the organization's default wallet. A batch is a fixed number of statements however many rows it has (bulk inserts from JSON), so locks are held for a few round trips. Credits from a batch are **not** subject to the recipient daily value cap; they are bounded by the organization's balance and the $100,000 per-credit limit. The organization's wallet `spent_today` counter rises by the batch total. Ledger postings: `send` debits the organization's `funded_balance` and credits the employee's; `allocate` debits the organization's `funded_balance` and credits `employee_escrow` (no account); `claim` debits `employee_escrow` and credits the employee's `funded_balance`. Stats reconciliation reports `escrow_matches_employees` (net `employee_escrow` equals the sum of `employees.balance`).

## Tables (migration 0030)

- **employees**: id, org_account_id, employee_account_id (NULL until claimed), employee_id, name, email, balance (held; 0 once claimed), claim_token_hash (SHA-256; the token itself is never stored; NULL once claimed), reminded_at (when last emailed), created_at, updated_at. Unique (org_account_id, employee_id). CHECK: a claimed employee holds no balance and no token.
- **credit_batches**: id, org_account_id, idempotency_key (unique per organization), row_count, total, sent, held, created_at.
- **credit_batch_rows**: id, batch_id, employee_ref, amount, mode (sent|held), transaction_id (unique), created_at.
- `accounts.type` gains **O**; `transactions.type` gains **allocate** (from the organization, no destination) and **claim** (to the employee, no source).

## Not built

Admin portal pages for organizations (the admin Users and Merchants lists show only consumers and businesses; an organization's transactions appear in the Transactions feed labelled as a user), organization sessions and staff logins, approval or suspension from the admin portal, scheduled or recurring distributions, reusable staff lists beyond the employees table, merchant-funded rewards, a public claim page (the emailed link points at `APP_URL/claim?token=...`; the consumer app or a claim page must call `POST /v1/employee/claims`), payroll and tax features (out of scope).
