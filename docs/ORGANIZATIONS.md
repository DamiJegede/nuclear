# Organizations: employer-funded staff wallets

The portal calls the CSV page **Benefits** (it was Credits); the API and tables keep the `credit_batches` names.

Implements the first slice of [ADOPTION-STRATEGY.md](ADOPTION-STRATEGY.md) and the ideas in [BRAIN-DUMP.md](BRAIN-DUMP.md). Migration 0030. Free for employers ($0 PEPM); the allowance is the organization's own money, never Nuclear revenue; Nuclear does not do payroll, withholding or tax reporting.

## Finalized Benefits wallet program (Dami, 2026-10-20)

**Implemented 2026-10-20 (migration 0033, `lib/benefits.ts`, tests `benefits.e2e.mts`); see "Build decisions" below for what the build chose.** These decisions supersede the ordinary-wallet credit destination and blanket recipient-cap bypass described in the existing implementation below. For Benefits behavior, use this section over older shared-balance descriptions in TABLES.md and BALANCE-POLICY.md; update those documents alongside the implementation. Keep the employer API and CSV platform free, at $0 PEPM. Do not turn this into payroll processing or employer tax reporting.

### Build decisions (Dami, 2026-10-20)

- **Cap measure:** only **Benefits-to-ordinary moves** use the full measure (cap minus ordinary opening value minus ordinary additions today). Ordinary bank loads and incoming sends keep the existing incoming-today check against the cap, which now also counts Benefits-to-ordinary moves and ignores employer credits that land in Benefits wallets. The opening value is computed from the append-only ledger (funded_balance postings before 00:00 America/New_York, less those attributed to Benefits wallets), so there is no snapshot to reset.
- **Refunds** never count toward the cap and are never limited by it (clarified; see the refund section).
- **Compartment:** a Benefits wallet holds its money in `wallets.balance` (the same mechanism as an earmark, so no other wallet can spend it) and it is inside `balances.balance` (the account total). Ordinary funded value = total minus Benefits balances. `ledger_entries.wallet_id` attributes a `funded_balance` posting to a Benefits wallet; stats reconciliation reports `benefits_match_ledger`.
- **Moves:** transaction type `move` (same account on both sides, two wallets), `POST /v1/wallets/move`, with wallet allocation rows for the earmark changes.
- **UI:** API only. There is no consumer app in the repo; claim, the Benefits breakdown and Move to another wallet have no screen yet. The organization portal is unchanged (the employees and batch API answers add `benefits_wallet_id`, never a balance).
- **Domestic restrictions:** nothing extra is enforced; all current merchants are US and USD-only. A launch-readiness item.
- **Usage (clarified 2026-10-20):** a Benefits wallet is otherwise unrestricted. The **only** restriction on what it can do is that it **cannot send to an external wallet** (another account's). The owner can pay any merchant from it by choosing it, or by tapping a band or card assigned to it (a tag can be claimed to any of the owner's active wallets, so a Benefits wallet's tag pays from it); it can also buy from the Nuclear store like any wallet. The remaining guards are about where its money comes from and how it leaves the account, not about spending: only its bound employer funds it, it cannot be edited through the balance endpoint or closed while funded, and its internal move to an ordinary wallet is bounded by the daily headroom. Moves between Benefits wallets and ordinary-to-Benefits moves stay blocked (they would introduce funding from a source other than the bound employer, as specified above).

### Product and ownership

- Add wallet type **`benefits`**, displayed as **Benefits**. An employer-specific display name can be `<Organization Name> Benefits`.
- A Benefits wallet belongs to the employee's consumer `account_id` and is permanently bound to one originating organization `org_account_id`. Set that binding from the verified employee allocation/claim relationship, never from a caller-supplied sender or an arbitrary first incoming transfer.
- Create/link and expose the Benefits wallet when the employee claims/links their benefit. Existing Nuclear users also claim/link; do not automatically attach by matching email. Subsequent credits from that organization go to the linked Benefits wallet, not the consumer default wallet.
- One Benefits wallet per consumer account and originating organization. Different employers have separate Benefits wallets. Multiple employee records linked to the same account and employer must reuse that wallet rather than creating duplicate funding compartments.
- Consumers cannot create this type through generic wallet creation, change a wallet into/out of it, replace its employer, or null/release its balance to make its funds shared. Wallet type and employer association remain immutable after creation.
- The account total includes all funded Benefits balances and can exceed $2,000. This is an aggregate display/accounting total, not permission for ordinary wallets to draw on Benefits funds. Show a separate Benefits amount and the ordinary funds available for transfers; do not label the whole total as sendable.

### Permitted movements

| Movement | Rule |
| --- | --- |
| Bound employer -> its employee's Benefits wallet | Allowed through the organization benefit-distribution flow, using funded employer money only. |
| Same employer -> employee escrow -> claim | Allowed; claim credits the bound Benefits wallet. Keep existing single-use tokens, never-expiring unclaimed credits and reminders. |
| Different employer, consumer bank load, personal wallet or P2P -> Benefits | Blocked. Each employer uses its own bound Benefits wallet. |
| Benefits -> merchant purchase | Allowed, unrestricted (clarified 2026-10-20): the owner chooses the wallet or pays with its tag; also the Nuclear store. Debit this Benefits wallet's funded money only, never shared personal funds or payment credit. Domestic program restrictions are a launch item, not enforced yet. |
| Benefits -> another account/user (an external wallet) | **Blocked**, even if a generic `allow_send` flag is changed. This is the one restriction on what a Benefits wallet can do. |
| Benefits -> non-Benefits wallet under the same account | **Allowed**, subject to the account-wide ordinary $2,000 daily-associated-value headroom and destination permissions/status. This is a distinct internal move, not P2P. |
| Benefits -> another Benefits wallet | Blocked; it would introduce funding from a source other than the destination's bound employer. |
| Non-Benefits wallet -> Benefits | Blocked, including money previously moved out of Benefits. |
| Refund of a Benefits-funded purchase | Restore the original Benefits wallet and source attribution. A refund is a reversal of the original purchase, not an arbitrary third-party top-up. |

The only general outgoing wallet-transfer exception is the same-account move above. No new consumer cash-out is introduced. Existing normal-wallet permissions apply after money has successfully moved into the ordinary compartment. Account identity is determined by `account_id`, not by matching email, name, device, or employer employee ID. The owner authorizes the internal move; a delegated wallet session or agent key must not gain owner-wide reallocation authority.

### $2,000 rule and compartment accounting

- Benefits funds held in a Benefits wallet do not consume the ordinary account's $2,000 daily-associated-value allowance. Direct Benefits purchases do not consume that ordinary allowance either. This is an accepted product rule relying on separate program treatment, not a declaration of regulatory approval.
- **The $2,000 allowance is shared across the rest of the consumer account**, including default, person and agent wallets. It is not $2,000 per destination wallet, tag, device or agent. Multiple Benefits wallets do not multiply it.
- Moving funded value from Benefits to a non-Benefits wallet counts as an addition to the ordinary compartment, even though total account funds are unchanged. It competes with ordinary bank funding, incoming personal transfers and other qualifying additions for the same headroom.
- Use the existing program day, **America/New_York**, with ordinary opening funded value plus qualifying additions for the day. Spending or sending does not restore daily loading headroom. Pending loads retain their headroom reservations; do not grant that reserved capacity to a simultaneous Benefits move.
- Example: $1,500 ordinary opening value, then $1,000 spent, leaves $500 of daily addition headroom. A $500 Benefits move is allowed; $501 is refused, even though the resulting ordinary balance would be below $2,000. Two simultaneous $400 moves cannot both succeed.
- Ordinary-to-ordinary earmark changes do not introduce new value into the ordinary compartment and must not count the same Benefits move twice. A retry must not consume headroom twice. A later outgoing move or wallet closure must not reset it.
- A Benefits wallet must have a distinct, nonnegative funded balance. Its money is excluded from every other wallet's shared-spendable calculation, normal earmarking, credit repayment allocation and generic close/release path. Generic `PUT /wallets/:id/balance` must not manufacture or release Benefits funds. Block closing a nonempty Benefits wallet; do not release it into shared funds to bypass the internal-move cap.
- If `balances.balance` remains the total funded balance (including Benefits), compute ordinary funded value as that total minus the sum of Benefits balances; subtract ordinary earmarks/reservations again when computing shared availability. Do not subtract earmarks from the account total twice. Alternatively expose a derived total over separate compartments, but never add Benefits twice or let existing unearmarked wallets spend them implicitly.
- Employer credit/claim increases total funded balance and the bound Benefits balance by the same amount. A direct Benefits purchase decreases both. A Benefits-to-ordinary move decreases Benefits, increases the ordinary/destination allocation, and leaves the account total unchanged. A Benefits refund restores both original amounts. Approved credit is separate throughout.
- Implement every movement, balance update, headroom reservation/consumption and audit record atomically and idempotently. Preserve balanced append-only journal postings and reconcile the two funding compartments. Decide the concrete wallet-attributed posting representation in the forward migration; account-level net-zero transfers still require a durable internal-move record with both wallet IDs and amount.

### Refund exception to the ordinary $2,000 cap (Dami, 2026-10-20; clarified 2026-10-20)

**Refunds are never limited by the daily cap and never counted toward it.** This supersedes the first draft of this section, which counted ordinary funded refunds against addition headroom; funds could otherwise be orphaned or rejected and need complicated solutions.

- An approved refund linked to an original purchase credits the original funding compartment even when it takes ordinary funded balance above $2,000. It is never rejected, truncated, diverted into Benefits or delayed because of the cap.
- A refund does not consume addition headroom and does not create any. Remaining addition headroom (used for Benefits-to-ordinary moves) is `max(0, 200000 - ordinary_opening_value - ordinary_additions_today - active_addition_reservations)` in cents, where additions are released bank loads, incoming ordinary sends and Benefits-to-ordinary moves; refunds, spending and sending never change it that day.
- Preserve original routing: a Benefits-funded purchase refunds into its Benefits wallet; an ordinary-wallet purchase (including one made with money previously moved out of Benefits) refunds into that ordinary wallet and does not restore Benefits. Restoration of outstanding payment credit remains separate.
- At the next America/New_York program day the opening value is the actual ordinary funded value at the boundary, so an excess created by a refund is part of it and leaves that day with less (possibly zero) headroom. It is not a suspension and does not stop otherwise permitted spending.
- Continue original-purchase validation, cumulative partial-refund bounds, approval controls and idempotency; a retry cannot double-credit.
- Examples: ordinary opening $1,000, a $400 purchase and its $400 refund leave the headroom at $1,000 throughout. Opening $1,900 + a $500 load today + a $400 refund leaves $2,400 usable funds and zero headroom; the refund posted anyway.

This is finalized **product behavior**, not an assertion that FinCEN has approved a refund exception to its statutory exclusion threshold. Confirm that excess-refund handling fits the actual bank/program classification before live-money use; do not describe the product rule as an established regulatory exemption.

### Organization batches, claims and data changes

- Preserve the CSV format, 2,000-row limit, $100,000 per-row input limit, all-or-nothing batches, escrow reconciliation and existing retry behavior. The $100,000 input limit is not a statement of a legally approved benefit limit.
- Unclaimed rows remain in `employee_escrow` and `employees.balance`; a claim creates/reuses the Benefits wallet and transfers held money to it once. Already-linked rows credit that same employer-bound wallet. Resolve any existing linked employee without a Benefits wallet atomically when the next benefit is credited.
- A benefit distribution does not consume ordinary consumer headroom only because it lands in a Benefits wallet. Remove the unconditional organization-credit bypass for ordinary recipient wallets: all generic load/send paths to ordinary wallets retain the ordinary cap.
- Retain the originating employer and employee/batch references through allocation, claim, later credits, internal moves, payments and refunds. Employees' `name`/`email` changes must not change a claimed consumer owner or employer binding.
- Add a forward migration for the Benefits type, immutable employer association, unique account/employer binding, and required internal-move/journal references. Do not edit already-applied migrations. The builder should document concrete columns and transaction types in TABLES.md, including any new ledger bucket or counter representation.
- The current balance model is account-level with ordinary wallet earmarks. Do not implement this feature as only a new wallet enum and a hidden amount: all generic spendable calculations and incoming-value queries must recognize the separate Benefits compartment.
- Legacy credits may already have entered ordinary balances or been spent. Do not retroactively seize/reclassify current money or rewrite old journal entries from employer/batch totals. Document a forward-only cutover and the treatment of existing employee links; any historical balance conversion needs an explicit reconciled plan.

### API and UI build scope

- Keep `/v1/org/*`, the portal's Benefits page and the CSV API names compatible. They now route linked credits into Benefits wallets. Expose the destination wallet where relevant to claims and employee/batch details.
- `POST /v1/employee/claims` should return the linked Benefits wallet identity and funded result; replay cannot create another wallet, link another consumer, or move money again.
- Add an owner-only same-account internal-move endpoint with source wallet, destination wallet, positive integer-cent amount and idempotency key. Follow existing API conventions. Check exact account ownership, wallet types/status, source balance, ordinary headroom and destination limits before committing; reject cross-account or prohibited Benefits destinations server-side.
- Idempotency must compare the full semantic operation (source, destination, amount), not just total amount. A changed operation using the same key returns a mismatch. Return the original result on a matching retry.
- Wallet responses expose `type: benefits`, its employer identity and actual funded amount. Balance responses distinguish total funded, Benefits funded, ordinary funded, ordinary shared availability, and remaining daily addition headroom. Preserve existing owner/delegated response scoping and never expose another wallet through an agent key.
- Consumer UI shows Benefits after claim/link, includes it in the aggregate total with a visible breakdown, and offers Move to another wallet in the same account with the allowed amount/headroom. Benefits is absent from cross-account send sources and ordinary add-funds destinations.
- Retain existing merchant authorization and refund flows, admin/support visibility, account suspension and wallet restrictions. Update reconciliation, exports and activity so an internal move is not revenue, a second employer distribution, or an external cash movement.

### Required acceptance checks

1. New-user and existing-user claims create/reuse the employer-bound Benefits wallet; later batches credit it. Duplicate claims/batches do not double-credit or create extra wallets.
2. $7,000 Benefits plus $1,000 ordinary displays $8,000 total; ordinary wallets can use only their permitted share of the $1,000. A Benefits payment cannot consume ordinary funds or credit.
3. An internal move preserves account total and balanced journals, credits an earmarked destination correctly or releases into the normal shared compartment for an unearmarked destination, and consumes ordinary daily headroom once.
4. Multiple destination wallets, simultaneous transfers and pending bank loads cannot exceed the same account-wide headroom. Exercise exact-cap success, one-cent-over rejection and program-day rollover.
5. Another employer/user, normal bank load, normal balance-edit endpoint, type change, ordinary-to-Benefits move, Benefits-to-Benefits move, cross-account send, generic wallet closure, delegated session or agent key cannot bypass the restrictions.
6. Refunds return to the original funding compartment. For payments from ordinary funds previously moved out of Benefits, refund to that original ordinary wallet rather than guessing from historical provenance; do not automatically restore Benefits. Refunds are never capped or counted: exercise an over-cap ordinary refund, partial refunds, duplicate callbacks and unchanged headroom after a refund.
7. The account total reconciles with Benefits plus ordinary value; escrow still matches unclaimed employees; no principal is counted as Nuclear revenue. Retry mismatches and concurrency preserve money and authorization.

### Program classification and remaining launch work

The user has finalized **same-account Benefits moves**; do not leave that product decision marked as pending approval. The legal/program assessment of that exact arrangement is separate: a distinct wallet/database field alone does not establish eligibility for an exclusion. In particular, confirm treatment of the connected ordinary/P2P product, employer funding through an organization balance, employee identification, domestic use, applicable state rules and bank requirements before live-money use. Employer verification/employee identity collection and production bank funding are not implemented by naming a wallet Benefits. The organization funding pool also needs its own approved funding/distribution treatment; do not assume the employee exclusion automatically exempts a large general-purpose organization spending wallet.

References for that assessment: [31 CFR 1010.100(ff)(4)(iii)(D)](https://www.ecfr.gov/current/title-31/subtitle-B/chapter-X/part-1010/subpart-A/section-1010.100) and [FinCEN final-rule explanation](https://www.fincen.gov/system/files/shared/Prepaid_Final_7-22-201.pdf), especially pages 23–25 (use alongside/reloading other prepaid products) and 30–32 (employer funding, employee identification and conditions). These are supporting sources, not a legal approval of Nuclear's final design. The employment-benefits branch has no stated dollar ceiling; program, employer and risk limits still apply.

## Benefits API

Added 2026-10-20 (migration 0034, `routes/benefitsApi.ts`, `lib/orgApiKey.ts`, tests `benefitsapi.e2e.mts`). An organization's own systems create, remove and credit employees without the portal. Very simple by design: **array endpoints for employees and credits plus a balance read** (one employee or a whole batch of up to 2,000), each is **all or nothing**, amounts are **integer cents**.

- **Key:** `Authorization: Bearer nk_org_<43 chars>`. One live key per organization, in the new `api_keys` table (hash only; the token is returned once by `POST /v1/org/api-key` and never again). The organization portal's **API** page (top navigation) opens with an intro summary ("Use the Benefits API to grant benefits to your employees directly from your payroll, HR or rewards systems…"), generates, rotates (the old key dies at once) and revokes it with a one-time modal (masked, Copy, Download) and shows the key's hint, creation and last use, followed by the documentation in two columns: a left column of plain text links that jump to each card (Basics, each route, Errors), and on the right a card for Basics, one per route (create/update, get, credit, remove, balance) each with a curl example and sample answer, and Errors. Session endpoints (portal only): `GET|POST|DELETE /v1/org/api-key`. The key must belong to an active organization; a suspended organization's key is refused. 120 requests per minute per key (`rate_limited` with `retry_after`). Server to server: no CORS.
- `POST /v1/benefits-api/employees {employees:[{employee_id, name, email}]}`: creates or updates (name and email follow the request, `employee_id` is the immutable key); a removed employee becomes active again. Answer `employees:[{employee_id, result: created|updated|reactivated}]`. No money, no email.
- `POST /v1/benefits-api/employees/get {employee_ids:[...]}`: read only; an array in, an array back in the same order. Each entry is `{employee_id, found:false}` or `{employee_id, found:true, name, email, status: active|removed, claimed, held, created_at, updated_at}`; `held` is the credit (cents) still waiting to be claimed, and a claimed employee's balance is never shown. Duplicate ids are 422.
- `GET /v1/benefits-api/balance`: `{currency: "USD", balance, held_for_unclaimed, employees}` in cents: what is available to credit, what is set aside for unclaimed employees, and the active employee count.
- `POST /v1/benefits-api/credits {credits:[{employee_id, amount, name?, email?}]}` with `Idempotency-Key`: the same engine as the portal's CSV batch (one transaction, refused whole if the balance is short, escrow for unclaimed employees, Benefits wallet for claimed ones, claim emails). `name` and `email` are required only for an employee the organization has no record of (422 `employee_details_required` with `employee_ids`). Answer 201 (200 on a replay) with `batch {id, count, total, sent, held, created_at}`, `credits:[{employee_id, amount, credited_as: benefits_wallet|held_until_claimed, transaction_id}]` and `emails`. Errors as the portal: `insufficient_balance` (`required`, `available`), `recipient_unavailable`, `idempotency_mismatch`, `duplicate_employee_id`.
- `POST /v1/benefits-api/employees/remove {employee_ids:[...]}`: removes (hides) employees; 404 `employee_not_found` for unknown ids, 409 `has_held_balance` for anyone with a credit still held (they must claim first), both with `employee_ids`, and nothing is removed; removing twice is `already_removed`. Answer `employees:[{employee_id, result: removed|already_removed}]`.
- Every call is recorded in `logs` (`org.api_employees_saved`, `org.api_employees_removed`, `org.credit_batch` with `via: api`, `org.api_key_generated`, `org.api_key_revoked`). Batches made through the API appear in the portal's Benefits history like any other.

## Existing organization implementation (2026-10-19; destination rules superseded above)

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
- `DELETE /employees/:id`: removes (hides) an employee, 204; 409 `has_held_balance` while money is held for them (they must claim first); 404 if not theirs or already removed. A later CSV with the same employee_id makes them active again.
- `GET /credit-batches`, `GET /credit-batches/:id` (`batch`, `summary {claimed, unclaimed, still_held}` and rows with `mode` sent|held plus the employee's CURRENT `claimed`, `balance`, `reminded_at`, `removed`; the portal's batch page and its CSV reports are built from this).
- `POST /v1/employee/claims {token}`: any consumer owner session. 404 `invalid_token`, 422 `consumer_account_required`.
- `GET|PUT /profile`: legal name, name employees see, tax ID (write-only, last four returned), address, city, state, post code, country, website; the same body and rules as `/v1/business/profile`, stored in `businesses` (migration 0032 lets `account_type` be O). Documents: the existing `GET|POST /v1/account/documents` (PDF, PNG or JPEG, 5 MB, 10 per account), now open to organizations.
- `GET|POST|DELETE /api-key`: the organization's Benefits API key (see Benefits API; the token is returned only by the POST).
- Funding the organization's wallet uses the existing load route.

## Existing money implementation (superseded for Benefits wallets)

Lock order: the organization's `balances` row, then the recipients' `balances` rows (by account id), then the organization's default wallet. A batch is a fixed number of statements however many rows it has (bulk inserts from JSON), so locks are held for a few round trips. Credits from a batch are **not** subject to the recipient daily value cap; they are bounded by the organization's balance and the $100,000 per-credit limit. The organization's wallet `spent_today` counter rises by the batch total. Ledger postings: `send` debits the organization's `funded_balance` and credits the employee's; `allocate` debits the organization's `funded_balance` and credits `employee_escrow` (no account); `claim` debits `employee_escrow` and credits the employee's `funded_balance`. Stats reconciliation reports `escrow_matches_employees` (net `employee_escrow` equals the sum of `employees.balance`).

## Tables (migration 0030)

- **employees**: id, org_account_id, employee_account_id (NULL until claimed), employee_id, name, email, balance (held; 0 once claimed), claim_token_hash (SHA-256; the token itself is never stored; NULL once claimed), reminded_at (when last emailed), status (active|removed, migration 0031), created_at, updated_at. Unique (org_account_id, employee_id). CHECK: a claimed employee holds no balance and no token.
- **credit_batches**: id, org_account_id, idempotency_key (unique per organization), row_count, total, sent, held, created_at.
- **credit_batch_rows**: id, batch_id, employee_ref, amount, mode (sent|held), transaction_id (unique), created_at.
- `accounts.type` gains **O**; `transactions.type` gains **allocate** (from the organization, no destination) and **claim** (to the employee, no source).

## Benefits wallet implementation (2026-10-20, migration 0033)

- `wallets.type` gains `benefits`; `wallets.org_account_id` binds it to one employer (CHECK: set exactly for Benefits wallets; unique live wallet per (account, employer); a trigger makes type, owner and employer immutable); `balance` is never NULL for Benefits (CHECK). `transactions.type` gains `move`; `ledger_entries.wallet_id` is new. Nothing existing is reclassified.
- **Claim** (`POST /v1/employee/claims`) creates or reuses the employer's Benefits wallet for the account and credits it (even a $0 claim creates the wallet); the answer includes `wallet {id, display_name, type, balance}`. Replaying a used token is 404 `invalid_token`.
- **Batches** credit the linked employee's Benefits wallet (created when missing, so a legacy-linked employee gets one at the next credit; their older ordinary money stays ordinary). A suspended Benefits wallet or account refuses the whole batch with `recipient_unavailable`.
- **Rules enforced:** `sendFunds` refuses a Benefits source (`benefits_wallet_not_transferable`: it cannot send to another account) and a Benefits destination (`recipient_not_eligible`: only its employer funds it); `PUT /wallets/:id/balance` is `benefits_wallet_locked`; closing a funded Benefits wallet is `benefits_wallet_not_empty`; `POST /v1/wallets` cannot create one. Spending has no other restriction: it pays any merchant (by wallet choice or its tag) and buys from the Nuclear store, always from its own money (never credit, never ordinary funds), and the purchase is attributed to the wallet in the ledger.
- **Moves** (`POST /v1/wallets/move {from_wallet_id, to_wallet_id, amount}` with `Idempotency-Key`; owner only, never a delegated session or agent key): source must be a Benefits wallet (`source_must_be_benefits`), destination a non-Benefits wallet of the same account (`destination_not_allowed`, 404 for another account's wallet). Under the balances lock it checks status, balance and headroom; a decline (`daily_value_limit_exceeded`, `wallet_balance_exceeded`, `wallet_unavailable`, `account_restricted`) is recorded as a failed move with `daily_headroom` in the answer. The total is unchanged; an earmarked destination grows by the amount, an unearmarked one leaves the money in the shared funds. A retry replays; a changed source, destination or amount under the same key is `idempotency_mismatch`.
- `GET /v1/balance` (owner): `balance` (total funded), `benefits`, `ordinary`, `ordinary_shared_available`, `earmarked` (ordinary earmarks only) and `daily_headroom`. A session on a Benefits wallet sees that wallet's balance and `available_to_send` 0. Wallet JSON carries `organization {id, name}` for Benefits wallets.

## Not built

Consumer screens (claim page, Benefits breakdown, Move to another wallet), the Benefits wallet in the admin support pages (they show the type only), pending-load reservations and the provider-safe hold for a bank funding that settles after headroom is gone (loads are instant in the sandbox; real bank funding is not built), any domestic or program-specific purchase restriction, employer verification and employee identity collection, and the legal/program classification of the whole arrangement (see below).

Admin portal pages for organizations (the admin Users and Merchants lists show only consumers and businesses; an organization's transactions appear in the Transactions feed labelled as a user), organization sessions and staff logins, approval or suspension from the admin portal, scheduled or recurring distributions, reusable staff lists beyond the employees table, merchant-funded rewards, a public claim page (the emailed link points at `APP_URL/claim?token=...`; the consumer app or a claim page must call `POST /v1/employee/claims`), payroll and tax features (out of scope).
