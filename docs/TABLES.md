# Nuclear tables (scheme v2)

Updated October 23, 2026. This is the schema the code is built on: one initial migration `migrations/0001_init.sql` (tables, constraints, triggers, views; the archived v1 migrations are in `migrations-v1/`) and `migrations/0002_money_functions.sql` (the SQL functions the money moves run as). The design and the reasons are in [SCHEME-V2.md](SCHEME-V2.md). All money fields are bigint integer minor units (USD cents); all timestamps are timestamptz.

## Current decisions

**33 tables.** Identity and access: accounts, balances, wallets, devices, businesses, institutions, institution_hosts, routing_numbers, bank_accounts, staff, admins, admin_sessions. Money: transactions, tips, fundings, settlements, refunds, checkouts. Merchant: terminals, categories, products. Physical credentials: tags, tag_models, passes. Store: shop, orders. Organizations: employees, benefit_runs, benefit_run_rows. Platform: logs, uploads, system, snapshots.

- **`transactions` is the source of truth and is immutable.** Every transaction is from one wallet to one wallet and is written once with a final outcome, `completed` or `declined`; nothing ever updates it. A correction is a new transaction (refund, fund_return, settle_return, adjustment). There is no ledger table: balances are checked against what the transactions did (reconciliation, below).
- **Every account has a balance** (consumers, merchants, organizations, and the system account).
- **System wallets** have fixed ids (constants in `apps/api/src/lib/system.ts`): the system account `00000000-0000-7000-8000-000000000001`, Nuclear Bank `...0002` (loads, payouts, returns and collections go to or come from it) and Nuclear Shop `...0003` (the receiving side of store purchases). Their balance rows are never updated by the money functions.
- **Every organization has an escrow wallet** (wallet type `escrow`, created at sign-up): the credit held for employees who have not claimed it.
- **Daily counters roll themselves** (`wallets.spent_today` with `spent_day`, `products.sold_today` with `sold_day`, the cap numbers on `balances`): a row from an earlier program day counts as zero and the next write starts the new day. There is no daily reset job.
- **Money moves as SQL functions** (`app_send`, `app_pay_app`, `app_pay_tap`, `app_refund`, `app_refund_resolve`, `app_purchase`): one database call each that locks, checks, writes and returns.
- **Sessions are signed 90-day tokens** (no database read on the hot paths); `devices` keeps the push token, the list of a person's devices and revocation.
- Item refunds are carried on the refund transaction as JSON. Individual bank-load attempts live in fundings; a fund transaction is written only when a load is confirmed and released. Orbs are columns of terminals. Emailed links (verify, reset) are signed tokens with no table; rate limits live in a Durable Object.

[BALANCE-POLICY.md](BALANCE-POLICY.md) defines availability and credit repayment; balance_pending is informational (funds awaiting clearance, not spendable).

## accounts

| Field | Description |
| --- | --- |
| id | Primary key identifying the consumer or business account. |
| type | C for consumer; B for business; O for organization (an employer that credits employees); S for the system account ("Nuclear", the owner of the system wallets). |
| handle | Public unique account handle: 4-12 characters, letters and digits only, stored lowercase and matched case-insensitively. Nullable: not collected at signup. Only the primary/root account, from its own authenticated session, can set or change it; delegated wallet sessions, wallets and members never have or edit handles. Uniquely indexed; resolves to the account id. |
| name | Account name. |
| phone | Contact phone number. |
| email | Contact/login email where applicable. Business contact details do not authorize shared staff login. |
| password_hash | Password hash, never a plaintext password. Nullable for accounts without password login. |
| photo | R2 key of the account's profile picture (`accounts/<id>-<epoch ms>.jpg`, 256 x 256 JPEG, uploaded after the account exists), or NULL. Older rows may hold an https address. |
| tier | free, plus, or insider. |
| status | Account access/lifecycle status: active, pending (a new business awaiting approval), declined (refused; the business may upload a new document, which returns it to pending), suspended or closed. Businesses start pending; customers start active. A pending or declined business can sign in, see its status, upload documents and sign out, and nothing else. |
| email_verified_at | When the owner proved control of `email` by opening the emailed link (or by resetting the password with one); NULL = not verified. Nothing is blocked while it is NULL. |
| bio | Short text the owner writes about themselves or their business, up to **128 characters** (CHECK); NULL = none. |
| created_at | Creation timestamp. |
| updated_at | Last update timestamp. |

No money balance columns on accounts; these live in balances. Handles are normalized to lowercase before storage (`^[a-z0-9]{4,12}$`) and enforced by a unique index; a small reserved list (e.g. admin, nuclear, support) is rejected by the application. Resolving a handle returns the account id and default wallet for recipient selection.

## balances

Exactly one record per account of any type; all the account's wallets share funds and approved credit.

| Field | Description |
| --- | --- |
| account_id | Primary key and foreign key to accounts.id. |
| balance | Bigint funded net balance. Pending loads never increase this. Merchant refunds may make business balances negative. The system account's row is never updated by the money functions (its figure is derived). |
| balance_pending | Nonnegative bigint funds awaiting clearance; default 0. An account-wide summary of qualifying pending funding records, unavailable for sending or spending. |
| credit_limit | Nonnegative bigint approved account-wide payment credit limit; default 0. Independent of pending ACH loads. |
| credit_spent | Nonnegative bigint outstanding credit principal used for payments; default 0. Never resets at midnight or on another load. |
| updated_at | Last update timestamp. |
| ordinary_opening | Bigint: the account's ordinary funded value (balance minus its Benefits wallets) at the start of `opening_day`. Meaningful for consumer accounts only (the daily cap). |
| opening_day | The program day `ordinary_opening` and `added_today` are for. A row older than today rolls itself the next time it is read or locked: opening = what is held now, added = 0. |
| added_today | Nonnegative bigint of ordinary money added today: released bank loads, incoming sends, Benefits-to-ordinary moves. Never refunds, claims or employer credits into Benefits wallets; never reduced by spending, sending or reversals. The daily headroom is cap - opening - added_today - balance_pending (never below 0). |

Before subtracting active reservations, sends may use max(balance, 0); payments may use max(balance, 0) + max(credit_limit - credit_spent, 0), subject to account eligibility and all wallet/tag limits. Use balance first, then approved credit. Negative consumer balances or overdue/returned-credit restrictions block outgoing activity; merchant negative refund balances follow the daily-net settlement rule. Pending funding does not grant credit or replenish it. For an organization the money available to credit is `shared_funds(account)`: the balance less the escrow wallet (the credit held for employees). Allocation and repayment rules are in BALANCE-POLICY.md.

## wallets

| Field | Description |
| --- | --- |
| id | Primary key identifying the spending wallet. |
| account_id | Foreign key to accounts.id; owner of the shared funds. |
| display_name | Wallet/person/agent display name. Default-wallet name synchronization is proposed behavior. |
| photo | R2 key of the wallet's picture (`wallets/<id>-<epoch ms>.jpg`, 256 x 256 JPEG, uploaded after the wallet exists), used in activity, or NULL. Default-wallet photo synchronization is proposed behavior. |
| type | default, agent, person, benefits, escrow or system. A **benefits** wallet belongs to the consumer account, is bound for good to one employer (org_account_id), is created at claim/first credit (never by the consumer), holds funded money in `balance` (never NULL; a compartment inside the account total that no other wallet can spend), is otherwise unrestricted: it can pay any merchant (by choosing it or with its tag), buy from the Nuclear store, receive its employer's credits and refunds of its own purchases, and move to another wallet of the same account; the one thing it cannot do is send to an external (other-account) wallet. An **escrow** wallet belongs to an organization (one per organization, created at its sign-up, `balance` never NULL, no pay or send): the credit held for employees who have not claimed it. A **system** wallet (Nuclear Bank, Nuclear Shop) belongs to the system account, has no balance and is never spendable. |
| org_account_id | The employer a benefits wallet is bound to; NULL for every other type (CHECK in both directions). One live benefits wallet per (account_id, org_account_id). Immutable (trigger), like type and account_id. |
| daily_limit | Nullable bigint spending limit; NULL means no additional wallet daily cap. Funds and platform rules still apply. |
| spent_today | Sends, payments and purchases counted for `spent_day` (an organization's benefit run counts its whole total). Self-rolling: a row whose `spent_day` is not today reads as 0 and the next spend starts today's count. |
| spent_day | The program day (America/New_York) `spent_today` is for; default today (`program_today()`). |
| allow_pay | Whether the wallet can make merchant payments. |
| allow_send | Whether the wallet can send funded balance; credit cannot fund sends. |
| status | Wallet access/lifecycle status. |
| balance | Nullable bigint: earmarked funds. NULL (default) = the wallet draws on the account's shared funds. A number = money the owner set aside for this wallet: it can spend only up to that amount (a hard limit, never credit, no further approval) and the rest of the account cannot spend it. The amount stays inside balances.balance; sum(wallets.balance) never exceeds the account balance (every money movement locks the balances row first). Agent wallets start at 0; person wallets and the default wallet start NULL. Spends and sends decrement it, incoming sends and refunds to the wallet increase it, closing the wallet releases it. Changes to an earmark are written to `logs` (action `wallet.earmark`). |
| key_hash | Nullable unique SHA-256 of the wallet's agent API key. Agent wallets only (check constraint); one key per wallet; creating a key replaces the old one; only the hash is stored, the key (`nk_agent_` + 43 characters) is created with the wallet and shown once, in the creation response; rotating it later shows the new one once. Closing the wallet clears it. |
| key_hint | Last 4 characters of the key, to tell keys apart; set exactly when key_hash is. |
| key_last_used_at | Nullable; when the key last authenticated a request (stamped at most once a minute). |
| created_at | Creation timestamp. |
| updated_at | Last update timestamp. |

No spend_date or member_account_id field. A wallet is a spending identity/permission path; unless it carries an earmarked balance it is not separately funded. Only the primary holder can issue a five-minute signed JWT link for this wallet, redeemed into device-scoped access as described in [WALLET-ACCESS-POLICY.md](WALLET-ACCESS-POLICY.md). Session and single-use redemption state live in devices. Once financial history exists, wallet.account_id cannot change; moving a person to another owning account requires a new wallet.

## system

Key/value system state: `key` (primary key), `value` (text) and `updated_at`. Keys in use: `stats_snapshot` and `reconciliation_snapshot` (JSON of the admin Overview and of the last reconciliation, see AGENTS.md), `settled_day` (the last program day the settlement job completed) and `cron_last_run` (the scheduled time of the last daily job, a heartbeat). The counters of the day need no key: they roll themselves.

## devices

Device registration: the push token, the list of a person's devices, revocation and the rolling expiry. A session is a **signed token** (claims: sub account, sid this row's id, kind owner or wallet, wid, typ the account type, 90-day exp); the signature and expiry are all a hot request checks, so there is no database read on those paths (see AGENTS.md for which). Session kinds: owner (wallet_id NULL) and wallet (a delegated device, wallet_id set). Merchant terminals are not devices; their sessions live on terminals. account_id identifies the primary funds owner for delegated access.

| Field | Description |
| --- | --- |
| id | Primary key; the `sid` of the session token. New login-link issuance creates a fresh row. |
| account_id | Foreign key to accounts.id; owner of the account/wallet access. |
| wallet_id | Foreign key to wallets.id; target of delegated wallet access. NULL for the account holder's own login. |
| platform | ios, android or web. |
| model | Nullable text, 1-64 characters, what the device reports about itself: the iOS machine identifier (`iPhone16,2`) or Android manufacturer and `Build.MODEL`. Untrusted; sent at sign-up, sign-in, link redemption and the launch refresh, and shown to support (the admin portal maps known identifiers to printed names). Added by migration 0004 (physically last, logically after platform). |
| push_token | Nullable notification-delivery token, never an authentication credential. |
| redeemed_at | When the session was first issued (sign-up, sign-in, or redeeming a wallet link). NULL = a wallet link not opened yet; set exactly when `session_expires_at` is. |
| session_expires_at | Nullable expiry; set to issue time + 90 days and rolled to server time + 90 days by `POST /v1/auth/refresh`. NULL before redemption. |
| revoked_at | Nullable revocation timestamp; populated on logout, owner revocation, an admin sign-out or a password reset. Revoked access cannot be refreshed. |
| created_at | Registration/link-issuance timestamp. |
| last_accessed_at | Stamped at sign-in and on each refresh (not on every request). |

A revoked or expired device is refused by every route that reads this row (everything except the hot reads) and by every money function, inside its own call; the next launch's refresh answers 401. Reads of the signed token (balance, activity, wallets, tags) keep working until the token's own expiry: an accepted risk (SCHEME-V2.md, section 7). A wallet link is redeemed by a conditional update (`redeemed_at IS NULL`), which makes redemption single-use. A refresh issues a new token and does not invalidate the old one. See [WALLET-ACCESS-POLICY.md](WALLET-ACCESS-POLICY.md).

## businesses

| Field | Description |
| --- | --- |
| account_id | Primary key and foreign key to a type-B or type-O accounts.id. |
| account_type | B (a business) or O (an organization). |
| legal_name | Registered legal business name. NULL until the profile is saved (with display_name: both or neither). |
| display_name | Trading/customer-facing name. |
| tax_id | Protected tax identifier; restrict access and encrypt as appropriate. |
| bank_account_id | Foreign key to the business's selected payout bank account. |
| address | Street address line 1 and optional line 2 in one text field, separated by a newline. |
| city | City/locality. |
| state | State/region. |
| post_code | Postal code, stored as text. |
| country | Country code. |
| website | Business website URL. |
| latitude | Nullable address latitude. |
| longitude | Nullable address longitude. |
| updated_at | Last update timestamp. |
| program_mode | Organizations: `fixed` or `flexible` (default). Fixed runs a Payment Schedule; Flexible schedules nothing. |
| program_cadence | monthly, weekly or biweekly; NULL when flexible. |
| program_day_of_month | 1 to 28 for monthly. |
| program_weekday | 0 (Sunday) to 6 for weekly and biweekly. |
| program_start_date | Biweekly only: the first payment date. |
| program_next_run_date | The next payment date (America/New_York); NULL when flexible. |
| program_warned_for | The payment date a low-funds warning was already sent for. |
| program_last_attempt_at | The scheduler claims a program for half an hour so two cron runs cannot both pay it. |
| program_chosen_at | NULL until the organization has picked a mode (the portal asks on the first sign-in). |
| api_key_hash | Organizations: SHA-256 of the one live Benefits API key (`nk_org_` + 43 characters), shown once when generated; unique. NULL = no key. |
| api_key_hint | The key's last four characters. |
| api_key_created_at | When the key was generated. |
| api_key_last_used_at | Stamped at most once a minute. |

Initial scope stores one business address here. Multiple locations are an extension, not additional initial tables.

## terminals

A merchant checkout device or point of sale. Owned by a business (type B) account. Terminals are not devices: a terminal authenticates with its own JWT, and no row in devices represents it.

| Field | Description |
| --- | --- |
| id | Primary key identifying the terminal. |
| account_id | Foreign key to the owning type-B accounts.id. |
| name | Merchant-visible terminal name (1-80 characters). |
| session_token_hash | Nullable unique SHA-256 of the terminal's current session JWT. NULL means no active session. The JWT carries its own expiry, so no expiry column exists; the hash makes the session revocable and single-active. Raw tokens are never stored. |
| allow_refunds | Boolean, default true. true: the terminal may issue refunds directly. false: every refund needs tap approval from a staff member with write access. |
| created_at | Creation timestamp. |
| updated_at | Last update timestamp. |
| orb_uid | The paired Orb's own hardware UID, its MAC address, normalized to 12 uppercase hex characters; unique across terminals. NULL = no Orb. |
| orb_model | The Orb's hardware model; set exactly when orb_uid is. |
| orb_software | The Orb's firmware version; set exactly when orb_uid is. |
| orb_paired_at | When the Orb was paired; set exactly when orb_uid is. |
| active_staff_id | Nullable: the staff member on this terminal now (migration 0009). New payments default `served_by` and their tip to this person. A composite foreign key on (active_staff_id, account_id) to staff(id, account_id) keeps it to the same merchant; removing the staff member clears it. The POS sets it (`PUT /v1/terminal/active-staff`). |

Only business accounts may own terminals; a database trigger enforces the account type. A merchant owner login creates a terminal and receives its session JWT; issuing a new JWT (re-login on a replacement tablet, or extend) replaces the stored hash, which invalidates the previous token. A terminal session authorizes only terminal endpoints and carries no owner or wallet powers.

## Orbs (columns of terminals)

An Orb NFC reader belongs to the terminal it is paired with (columns `orb_uid`, `orb_model`, `orb_software`, `orb_paired_at` above); there is no orbs table. A terminal holds at most one Orb and an Orb (its MAC address) is on at most one terminal. **Pairing** (`PUT /v1/terminal/orb {uid, model, software}` or the owner's `PUT /v1/terminals/:id/orb`) writes the four columns; if the uid is already on another terminal of the same account it moves (the other terminal's columns are cleared in the same transaction) and an Orb the terminal already had is replaced; on another account's terminal it is 409. **Freeing** (`POST /v1/orbs/:id/release`, the id being the terminal's id) clears the columns, so the MAC address is free for any account to claim. `PATCH /v1/terminal/orb {software}` reports a firmware update. Only business accounts own terminals, so only businesses own Orbs.

## staff

Staff of a business. A staff member is a consumer account with their own wallet and credentials.

| Field | Description |
| --- | --- |
| id | Primary key identifying the staff record. |
| account_id | Foreign key to the employing type-B accounts.id. |
| staff_account_id | Foreign key to the staff member's type-C accounts.id. |
| role | read, or write. Write staff may approve refunds by tapping any of their credentials on the Orb; the refund request carries the tap and the server resolves the account, so one refund route serves both direct and approved refunds. |
| created_at | Creation timestamp. |
| updated_at | Last update timestamp. |

One staff record per (account_id, staff_account_id), and `(id, account_id)` is unique (a terminal's active staff member must be the same merchant's). A trigger enforces the account types. **Staff carry no bank account** (migration 0009, owner decision 2026-10-30): Nuclear records and shows tips, it does not pay staff. A staff member signs in with their own Nuclear account and sees their tips (write staff and the business see everyone's); removing the record keeps their tips, which belong to their account. The tapped credential resolves to the staff member's account through its wallet; no credential is pinned to the staff record.

## categories

Merchant product categories. Owned by a business (type B) account.

| Field | Description |
| --- | --- |
| id | Primary key identifying the category. |
| account_id | Foreign key to the owning type-B accounts.id. |
| name | Category name (1-120 characters). |
| active | Boolean, default true. Inactive categories are hidden rather than deleted. |
| created_at | Creation timestamp. |
| updated_at | Last update timestamp. |

A trigger enforces the business account type. `(id, account_id)` is unique so products can reference a category together with its owner. A category in use cannot be deleted; deactivate it instead.

## products

Merchant catalogue items. Owned by a business (type B) account.

| Field | Description |
| --- | --- |
| id | Primary key identifying the product. |
| account_id | Foreign key to the owning type-B accounts.id. |
| category_id | Nullable foreign key to categories.id; NULL means uncategorised. Enforced with a composite foreign key on (category_id, account_id) so a product can only use its own business's categories. |
| name | Product name (1-120 characters). |
| currency | Currency code, default USD. Only USD products can be sold today. |
| price | Non-negative bigint price in integer minor units. |
| photo | Nullable image reference, not image binary data. |
| stock | Nullable integer, never negative. NULL means stock is not tracked (unlimited). |
| active | Boolean, default true. false hides the product from sale and from the terminal. |
| status | available or sold_out. With tracked stock it is derived: sold_out exactly when stock is 0, available when stock is above 0 (a trigger keeps it in sync and a check enforces it). Untracked products keep a manually set status. |
| total_sold | Units sold, all time. |
| sold_today | Units sold on `sold_day`. Self-rolling like wallets.spent_today: a row from an earlier program day reads as 0. |
| sold_day | The program day `sold_today` is for; default today. |
| discount | Non-negative bigint discount in integer minor units off price, default 0, never more than price. The effective unit price is price minus discount. |
| created_at | Creation timestamp. |
| updated_at | Last update timestamp. |

A trigger enforces the business account type. Selling decrements stock in the same transaction as the payment: a sale of tracked stock fails rather than going below 0, and reaching 0 flags the product sold_out. Restocking is an increment (never a "set to" value) so a concurrent sale is not overwritten, and returns a sold-out product to available. Sold line items are a snapshot on the order's checkout, and an item refund can restock them. Percentage discounts, variants and per-location pricing are outside this initial shape.

## checkouts

An order a merchant creates and a customer pays (by tap or in the app). Owned by a business (type B) account. Workflow state, not money: the payment is a `pay` transaction. Stock is taken when the order is paid, not when it is created.

| Field | Description |
| --- | --- |
| id | Primary key identifying the checkout. It is shown to the customer (for example as a QR code), so it is an unguessable UUID. |
| account_id | Foreign key to the merchant's type-B accounts.id. |
| terminal_id | Nullable foreign key to terminals.id; NULL when not created on a terminal. |
| reference | Nullable merchant order reference (1-64 characters). |
| currency | Currency code, default USD. |
| total | Positive bigint total in integer minor units, fixed at creation from the item snapshot (or the keyed amount). |
| items | JSON array, the immutable snapshot at creation: `[{id, product_id, name, unit_price, discount, quantity}]` (id is the line's id, used by item refunds). Empty for a keyed-in amount. There is no checkout_items table. |
| status | open, paid or canceled (written once, at the end). **Expired is derived**: an open checkout whose `expires_at` has passed reads as `expired`; no job marks it. |
| expires_at | Nullable expiry; NULL means it never expires. |
| tip_amount | Bigint, default 0 (migration 0009): the part of what the payer paid that is tip. `total` stays the items, the payment's amount is `total + tip_amount`. Written once, in the same write that sets `paid` (a tip only exists on a paid checkout; a declined one-step checkout is canceled with it cleared). The `tips` rows of the payment add up to it exactly. |
| served_by | Nullable account id (migration 0009): the staff member serving the order, set when it is created (the request's staff id, else the terminal's active staff member) and never changed. The tip of this order goes to this person by default. |
| created_at, updated_at | Timestamps. |

A checkout is settled by at most one completed pay transaction (unique index on transactions.checkout_id for completed payments); declined attempts remain against it and it stays open for another try. A trigger on transactions requires a payment's or refund's checkout and terminal to belong to the merchant. **Every payment is a checkout** (changed 2026-10-30, migration 0009; owner decision): an amount-only tap or app payment writes a checkout too (no items, `total` = the amount), directly as `paid` in the same call, and as `canceled` (tip cleared) if the payment is declined, exactly as a payment with items does. A completed payment therefore always has a `checkout_id` (new rows; older ones may be empty). The nightly purge removes canceled checkouts older than 97 days and open ones that expired more than 97 days ago, once nothing references them (two small partial indexes serve it). Per-line refunded quantities are not stored: an item refund's transaction carries `meta.items`, and a pending request carries them on `refunds.items`; the quantities already refunded or reserved are the sums over those, read while the payment row is locked. A merchant's Orders page lists checkouts.

## tips

Who a tip belongs to (migration 0009). A tip is part of the payment (`transactions.amount` includes it and the payment's checkout says how much, in `checkouts.tip_amount`); this table only records the people it goes to. **Nuclear shows tips to staff, it never pays them out**: the business pays its staff.

| Field | Description |
| --- | --- |
| id | Primary key. |
| transaction_id | The completed payment (positive row) or refund (negative row) this row belongs to. Unique with the staff account: one row per person per transaction. |
| account_id | The merchant's type-B account. A trigger requires it to be the receiving side of the payment or the sending side of the refund. |
| staff_account_id | The person's account. It is the person, not the `staff` record, so removing someone from the staff keeps their tips. |
| amount | Nonzero bigint in cents: positive for a payment, negative for a refund. |
| created_at | When it was written. |

**Immutable** (a trigger refuses update, delete and truncate): a correction is a new row. A payment can split its tip between several people by **amounts** (cents), never ratios, so every reader gets the same sums; the payment function checks that the rows add up exactly to the checkout's `tip_amount`. **Refunds** take the non-tip part of the payment first (item refunds never reach the tip); only what a refund takes beyond it returns tip money, and it is taken back from the same people in proportion to what each was given (cumulative largest-remainder shares, spare cents to the larger remainder), written as negative rows (a payment's tip is the sum of its positive rows; what refunds returned is the sum of the negative rows of its refunds). Indexes: `(staff_account_id, account_id, created_at DESC, id DESC)` (one person's tips for a period) and `(account_id, created_at DESC, id DESC)` (the business's).

API: `GET /v1/tips?business&staff&from&to&cursor&limit` (the answer has the period's total, per-person totals and per-day totals, all summed from these rows, nothing stored) and `GET /v1/tips/employers` (owner sessions; a consumer names the business; read staff see only themselves, write staff and the business see everyone and may filter by `staff`); the terminal sends `tip` with `served_by` or `tips: [{staff_id, amount}]` on `POST /v1/terminal/payments` and `tip` on the customer's `POST /v1/payments` (the active staff member gets it).

## admins

People who sign in to the admin portal with an Access ID and an access token (then an authenticator code). Separate from accounts: an admin is not a customer or merchant and has no wallet or balance.

| Field | Description |
| --- | --- |
| id | Primary key identifying the admin. |
| access_id | Unique uppercase sign-in name, 3-32 characters: A-Z, 0-9, '.', '_' or '-', starting with a letter or digit. Generated by the server as 12 characters (no look-alike characters), always stored and shown uppercase; typing lowercase at sign-in is accepted. |
| name | Display name (1-80 characters). |
| access_token_hash | scrypt hash of the access token, never the token itself. The token is 32 characters, generated by the server, returned once when the admin is created or the token is reset, and cannot be retrieved later. |
| status | active or disabled. Disabling signs the person out everywhere. |
| failed_attempts | Consecutive wrong passwords since the last good sign-in. Reaching 5 locks the account and resets the count. |
| locked_until | Nullable; sign-in is refused until then (15 minutes after a lock). |
| mfa_secret | Nullable. The authenticator's shared secret (base32), AES-256-GCM encrypted with a key held outside the database (`MFA_ENCRYPTION_KEY`); never plaintext. Present but inactive until mfa_enabled_at is set. |
| mfa_enabled_at | Nullable. NULL means not enrolled: the admin can only enroll. Multi-factor is mandatory. |
| mfa_last_step | Nullable bigint: the last accepted 30-second time step, so a code can be used only once. |
| mfa_recovery | JSON array of SHA-256 hashes of the unused single-use recovery codes (ten at enrollment). A used code is removed. |
| last_login_at | Nullable last successful sign-in. |
| created_by | Nullable foreign key to admins.id: the admin who created this one, or NULL when the operator did (via the scripts). |
| created_at | Creation timestamp. |
| updated_at | Last update timestamp. |

Every sign-in failure (unknown id, wrong password, wrong code, disabled, locked) gives the same answer. With multi-factor enrolled, a correct password only yields a five-minute challenge; a session needs a valid authenticator or recovery code too, and wrong codes count toward the same lock. Any fully signed-in admin (or the operator, via scripts) can create admins; disabling, resetting and similar changes are the operator's. There is no admin role distinction yet.
| role | admin (default), accounting, sales, support, tags or merchants (check constraint). Decides which admin pages and API routes the person may use; see AGENTS.md. |

## admin_sessions

| Field | Description |
| --- | --- |
| id | Primary key identifying the session. |
| admin_id | Foreign key to admins.id. |
| token_hash | Unique SHA-256 of the random session token; the raw token is never stored. |
| expires_at | Absolute expiry, 8 hours after sign-in. |
| revoked_at | Nullable; set on sign-out, password change (other sessions), disable or reset. |
| created_at | Creation timestamp. |
| last_used_at | Nullable last use. |

## institutions

The banks people know (Chase, Wells Fargo...), one row each (migration 0006): the display name and the logo, uploaded once however many routing numbers the institution has. Seeded from `scripts/institutions-top50.json` with `scripts/seed-institutions.mjs`; admins add more on the Banks page.

| Field | Description |
| --- | --- |
| id | Primary key. |
| name | Display name, unique (1-120 characters). |
| icon | R2 key `institutions/<id>-<epoch ms>.png` (CHECK), uploaded by an admin; the API returns the full URL. The bank directory has no pictures. |
| domain | The institution's website (`chase.com`), used to find a logo. |
| aliases | `text[]` of lower-case names the bank directory uses for it ("jpmorgan chase"); a routing number whose directory name contains one as whole words is linked to this institution automatically (the longest match wins). **A name or alias belongs to one institution** (the admin API refuses a duplicate, compared as plain words: `alias_taken`), and a brand that has hosts (below) is never matched by name. Matching happens when a routing number is first seen or refreshed and the result is stored on the routing number: the institutions are read once per batch and compared in memory, never when a bank is read. |
| created_at, updated_at | Timestamps. |

## institution_hosts

Brands and the banks they run on (migration 0007). A neobank such as Mercury or Brex keeps its customers' money at a partner bank (Column, Choice Financial Group), so a routing number names the partner and cannot say which brand the customer uses. The partner is an institution of its own (the **host**: what the routing number links to and what is shown until the merchant says otherwise); a **brand** lists its hosts here. When a merchant's routing number belongs to a host with brands, the portal asks "Which bank is this?" (the brands, then the host itself) and the pick is stored on that merchant's `bank_accounts.institution_id`: nobody else on the same routing number is affected. A host cannot itself be a brand and a brand cannot be its own host (the admin API refuses both). The partner relationships are entered by admins (Banks page, "Runs on" in the institution window) or `scripts/seed-institutions.mjs` (`institutions-partners.json`, `institutions-neobanks.json`, whose partner-bank relationships come from memory: check them).

| Field | Description |
| --- | --- |
| brand_id | Foreign key to `institutions` (ON DELETE CASCADE): the brand (Mercury). Part of the primary key. |
| host_id | Foreign key to `institutions` (ON DELETE CASCADE): the partner bank (Column); indexed (`institution_hosts_host_idx`) because "does this institution have brands" is asked when a bank is read. Part of the primary key. |

## routing_numbers

One row per 9-digit routing number (migration 0005 as `banks`, renamed in 0006), shared by every bank account that uses it, so a number is looked up once and not once per account (`lib/banks.ts`). Created the first time anyone adds an account at that number, or by an admin. The facts about instant payments belong here and not on the institution: FedNow registers each routing number separately.

| Field | Description |
| --- | --- |
| id | Primary key. |
| routing_number | Unique, 9 digits (the ABA checksum is checked before an account is saved). |
| directory_name | The name the bank directory gives this number (e.g. `JPMORGAN CHASE BANK, NATIONAL ASSOCIATION`); NULL when it has no directory entry (a bank on no instant network). Used to link the number to its institution. |
| institution_id | Nullable foreign key to `institutions` (ON DELETE SET NULL). Set by name matching or by an admin, and **never replaced by a later lookup**. The name and logo a merchant sees come from the institution; until it is linked the directory's name is shown with a generic icon. |
| instant | `true` = receives instant payments (RTP `CRDT`, FedNow `CTRO`/`CTSR`), `false` = it does not, **NULL = not known** (never checked, or the lookup failed). NULL is treated as "not instant" when a payout is sent. |
| networks | `{RTP, FedNow}` subset the number takes (a FedNow-only payout is capped at $500K, RTP $1M). |
| refreshed_at | When the directory was last read **successfully**; an answer older than 30 days is read again (at bank-add, and by the nightly job for numbers in use). |
| created_at, updated_at | Timestamps. |

A failed lookup never blocks a bank: it is saved with `instant` NULL and tried again after an hour (an attempt marker per routing number in `system`, key `bank_lookup:<routing>`), so a rush of merchants adding one bank causes one lookup. A bank account reaches its institution through `bank_accounts.routing_number_id` then `routing_numbers.institution_id` (two primary-key joins; settlement only needs `routing_numbers.instant`).

## bank_accounts

| Field | Description |
| --- | --- |
| id | Primary key identifying the bank account record. |
| account_id | Foreign key to the consumer/business owner. |
| routing_number | The 9-digit routing number, stored as **plain text** (it is public: the Fed publishes the directory; migrations 0027/0028 enforce the format). Customer sandbox loads hold the placeholder `SANDBOX`. Not returned by the merchant endpoints (only `last4` of the account number is). |
| account_number | The account number, stored **encrypted** (AES-256-GCM, `v1.` prefix, bound to the account and field), kept so settlements can be originated and the payout bank can move to another provider. Only `last4` is ever shown; full reads go through one audited function. |
| last4 | Last four digits for display. |
| routing_number_id | Nullable foreign key to `routing_numbers` (migration 0005 as `bank_id`, renamed in 0006). NULL only for the `SANDBOX` placeholder. |
| institution_id | Nullable foreign key to `institutions` (ON DELETE SET NULL, migration 0007): the brand the merchant picked when the routing number's institution has brands (`institution_hosts`). It takes priority over the routing number's institution for what this account shows; NULL = no pick (the partner bank is shown and the merchant is asked). |
| provider_account_id | Nullable linked-bank-account resource identifier assigned by the banking provider. |
| status | Bank-link operational status. |
| created_at | Creation timestamp. |
| updated_at | Last update timestamp. |

No verified_at. Final storage/tokenization depends on the banking integration. Enforce bank ownership for fundings and businesses.bank_account_id with composite foreign keys and supporting unique constraints. Preserve historical bank owner identity.

## fundings

One row per bank-load attempt, created before provider submission. Pending, failed, canceled and returned funding remain here. No pending load is spendable and no load creates approved credit. Recognize qualifying pending amounts once in balance_pending; the exact provider recognition stage remains to finalize.

| Field | Description |
| --- | --- |
| id | Primary key identifying the funding attempt. |
| account_id | Foreign key to the account receiving the funds. |
| bank_account_id | Foreign key to the authorized source bank account. |
| amount | Positive gross load amount in integer minor units. |
| status | created, pending, completed, failed, canceled, or returned. Completed means confirmed successful and released under the funding policy; provider acceptance alone is insufficient. |
| failure_code | Nullable machine-readable funding failure or return reason. |
| idempotency_key | Stable retry identifier, unique within the agreed funding scope; reject reuse with different parameters. |
| provider_reference | Nullable provider identifier for this bank operation; distinct from bank_accounts.provider_account_id. |
| transaction_id | Nullable unique foreign key to the successful fund transaction. Empty until release; retained after a later return. |
| created_at | Funding attempt creation timestamp. |
| released_at | Nullable timestamp when funding was successfully released. Preserved after a later return. |
| returned_at | Nullable timestamp of a confirmed later bank return. |
| updated_at | Last funding update timestamp. |

Reserve applicable balance/program headroom before submission using outstanding funding records. Pending loads remain only funding operations, without any available balance credit. A provider-accepted submission is not sufficient to credit balance.

On confirmed successful funding release, atomically remove its recognized amount from balance_pending, update funding status and the balance/approved-credit repayment allocation, write exactly one completed `fund` transaction (from the Nuclear Bank wallet to the account's default wallet, for the gross load amount, `credit_amount` = the part that repaid credit) and link transaction_id. Proposed credit repayment priority is documented in BALANCE-POLICY.md. Creating the activity transaction must not credit the money a second time.

A funding attempt that fails before release has no fund transaction. Remove any amount previously recognized in balance_pending and release its reservations; no available funds or approved credit were granted by that pending load. Never subtract an amount that was not recognized. A later bank return preserves the original successful fund transaction and released_at; record the return on fundings and write a `fund_return` transaction. A timeout remains unresolved rather than becoming failed. Exact provider-stage mapping, cancellation eligibility and return accounting remain to be finalized.

## transactions

The source of truth for money: every movement, and every declined attempt. **Immutable**: a row is written once with its final outcome and never updated or deleted (triggers refuse both; the single exception is the retention job deleting declined rows older than 90 days). Pending things are not transactions: a pending load is a `fundings` row, a pending refund is a `refunds` row, an ACH payout in flight is a `settlements` row. Every transaction is **wallet to wallet**: both sides are real wallets (the bank and the store are the system wallets), so every side exists and everything reconciles. The account of a side is its wallet's account.

| Field | Description |
| --- | --- |
| id | Primary key. An approved refund request keeps its own id. |
| type | fund, fund_return, send, pay, refund, purchase, allocate, claim, move, settle, settle_return, collect, collect_return or adjustment (effects below). |
| status | `completed` or `declined`. The API reports a declined row as `failed`. |
| status_code | The reason when declined (insufficient_balance, spend_limit_exceeded, wallet_balance_exceeded, exceeds_refundable, ...); NULL exactly when completed (CHECK). |
| from_wallet_id, to_wallet_id | Not null, foreign keys to wallets.id, different unless the type is `move`. |
| amount | Positive bigint: the full amount the receiving side is credited. For a payment it includes the tip (the checkout says how much is tip; `transactions` has no tip columns). |
| credit_amount | Part of the amount covered by approved credit (pay), repaid credit (fund), restored credit (refund) or credit drawn again (fund_return); 0 otherwise. Never more than amount. |
| related_id | The transaction this one corrects: refund to its pay, fund_return to its fund, settle_return to its settle, collect_return to its collect, adjustment to any. |
| tag_id, pass_id | The credential of a tap payment (pay only; at most one). |
| terminal_id | The terminal of a pay or refund; a trigger requires it to belong to the merchant. |
| checkout_id | The checkout a pay settled or a refund refunds; a trigger requires it to belong to the merchant. |
| funding_id | The funding a fund or fund_return belongs to. |
| settlement_id | The settlement row of a settle, settle_return, collect or collect_return. |
| account_id | The account that acted or approved: the sender of a send, the payer of an in-app payment, the merchant of a terminal payment, the approving owner or staff member of a refund, the claimant of a claim, the account holder of a load; the system account for automated jobs and admin actions (the admin is named in meta). |
| reference | Nullable merchant order reference (1-64 characters); pay and refund only. |
| idem | One unique key per attempt, scoped by type: `send:<from account>:<key>`, `pay:<merchant>:<attempt>` (terminal attempts `t:<attempt>`, customer-confirmed `c:<payer>:<key>`), `refund:<merchant>:<key>`, `purchase:<account>:<key>`, `fund:<account>:<key>`, `move:<account>:<key>`, `settle:<merchant>:<date>` (and `settle_return`, `collect`), `benefit:<run id>:<n>`, `claim:<employee row>`. Completed and declined attempts alike, so a retry replays the recorded outcome and a retry that differs is a mismatch. |
| meta | JSON object: the items snapshot of a payment or item refund (`items`), the benefit run id, `approved: true` and `provider_reference` (`admin:<ACCESS ID>` or `operator`) on a refund an admin or approver resolved, an adjustment's reason. Nothing that is queried. |
| created_at | When it was written (for a completed row, the moment the money moved). There is no separate completed_at. |

**Effect of each type** (balances are per account, shared funds; a system wallet side updates nothing):

| Type | From wallet | To wallet |
| --- | --- | --- |
| fund | Nuclear Bank | account balance `+ (amount - credit_amount)`, `credit_spent - credit_amount` |
| fund_return | the account's wallet: balance `- (amount - credit_amount)`, `credit_spent + credit_amount` (it mirrors the fund it reverses; may go below zero or leave credit above the limit: an explicit debt that blocks outgoing activity) | Nuclear Bank |
| send | balance `- amount` | balance `+ amount` |
| pay | balance `- (amount - credit_amount)`, `credit_spent + credit_amount` | merchant balance `+ amount` |
| refund | merchant balance `- amount` (may go below zero) | balance `+ (amount - credit_amount)`, `credit_spent - credit_amount` |
| purchase | balance `- amount` | Nuclear Shop |
| allocate | the organization's default wallet (account balance unchanged) | the organization's escrow wallet: earmark `+ amount` |
| claim | the organization's escrow wallet: earmark `- amount`, organization balance `- amount` | the employee's Benefits wallet: account balance and wallet `+ amount` |
| move | a Benefits wallet of the account (net zero for the account) | another wallet of the same account |
| settle | merchant balance `- amount` | Nuclear Bank |
| settle_return | Nuclear Bank | merchant balance `+ amount` |
| collect | Nuclear Bank | merchant balance `+ amount` |
| collect_return | merchant | merchant balance `- amount` (a collection the bank returned after it arrived: the debt is back) |
| adjustment | an admin-made correction, any wallets, reason in meta | |

A declined row has no effect on anything. **Indexes** (8, each justified by a query): primary key; `UNIQUE (idem)`; `(from_wallet_id, created_at DESC, id DESC)` and `(to_wallet_id, created_at DESC, id DESC)` (a wallet's activity, limits, a person's or merchant's history); `(created_at DESC, id DESC)` (the admin feed and the nightly snapshot's day range); `UNIQUE (checkout_id) WHERE type = 'pay' AND status = 'completed'` (one completed payment per checkout); `(related_id) WHERE related_id IS NOT NULL` (refunds against a payment); `(terminal_id, created_at DESC) WHERE terminal_id IS NOT NULL`.

**Views.** `txn` is the account-level read view the activity feeds, admin lists and support pages use: the old column names (from_account_id, to_account_id, from_wallet_id, to_wallet_id, idempotency_key, timestamp, completed_at, items, provider_reference, approved_by_account_id), the system wallets shown as no account, a declined row reported as `failed`, plus each pending refund request listed as a pending refund and each rejected one as a failed refund. `account_effects` is what each completed transaction did to each account (see Reconciliation). The functions `app_txrow`, `app_payrow`, `app_refundrow` return these rows as json.

## employees

See [ORGANIZATIONS.md](ORGANIZATIONS.md). One row per person an organization credits.

| Field | Description |
| --- | --- |
| id | UUID primary key. |
| org_account_id | The organization (account type O) that credits this person. |
| employee_account_id | Nullable: the consumer account that claimed, NULL until then. |
| employee_id | The organization's own alphanumeric, immutable employee identifier; unique within the organization. |
| name | Updated from each CSV. |
| email | Updated from each CSV; where the claim and reminder emails go. |
| balance | Bigint cents held for the person while they have no account (inside the organization's escrow wallet); 0 once claimed. Reconciled: an organization's escrow wallet balance equals the sum of its unclaimed employees' balances. |
| claim_token_hash | SHA-256 of the emailed claim token (the token is never stored); NULL once claimed. Replaced by each reminder. |
| reminded_at | When the person was last emailed about held money. |
| fixed_benefit | Nullable bigint cents (1 to 10,000,000). The amount the Fixed Benefits schedule credits this employee on each payment date; NULL = none. Set by the portal's fixed-benefits file, the per-employee edit and the Benefits API (0 or null clears). |
| status | active or removed . A removed employee is hidden from the portal lists and counts and is not paid a fixed benefit, but removal never touches money: credit held for them (balance) and their claim token stay, so they can still claim it; a later CSV that mentions the employee_id makes them active again. |
| created_at | Row creation time. |
| updated_at | Last change. |

There is no amount column: the amount to credit is only a column of the uploaded CSV, recorded per credit in benefit_run_rows and the transactions.

## snapshots

One row per program day (America/New_York), written by the nightly job from that day's completed transactions; the admin Overview shows the latest row plus today's running estimate (Durable Object counters, see AGENTS.md), so it never scans history. Money is bigint cents, counts are bigint. Written once per date (`snapshot_date` is unique); a missed night is made up later. **A snapshot is final**: once the day is over its numbers never change, even if a transaction is later reversed (the correction counts on the day it happens). A trigger refuses deletes and every update except writing `reconciled` / `reconciliation` once.

| Group | Columns |
| --- | --- |
| Identity | `id`, `snapshot_date` (the day the activity belongs to), `taken_at` (when the job ran; the gauges are as of then), `created_at` |
| Money held (gauges) | `scheme_balance`, `consumer_balance`, `merchant_balance`, `organization_balance`, `merchant_debt`, `pending_loads`, `credit_outstanding`, `credit_limit`, `benefits_wallet_balance` (inside the balances), `employee_escrow` |
| People (gauges) | `users_total/active/suspended/closed`, `wallets`, `merchants_total`, `merchants_active` (approved, not suspended), `merchants_transacting` (took a payment in the 30 days to the end of the day), `terminals`, `organizations_total/active`, `employees_total/claimed/unclaimed` |
| That day | `users_new`, `merchants_new`, `organizations_new`, `employees_added`, `merchants_paid`; `<kind>_count` and `<kind>_volume` for `sends`, `taps` (pay with a tag or pass), `in_app` (customer-confirmed pay), `agents` (memo of agent-wallet sends and pays, already inside the others), `refunds`, `loads`, `purchases`, `payouts`, `collections`, `claims`; Benefits: `benefit_runs_count`, `benefit_credited`, `benefit_sent` (into Benefits wallets), `benefit_held` (for unclaimed employees), `benefit_runs_missed` |
| Lifetime, to the end of the day | `lifetime_<kind>_count` / `_volume` for the same kinds (agents included), `lifetime_benefit_credited`, `lifetime_benefit_runs_count`. Each row is the previous day's plus the day; with no previous day it is summed from all history once |
| Reconciliation | `reconciled` and `reconciliation` (jsonb of the checks), written with the row: the nightly conservation check (see Reconciliation). `balance_midnight`, `credit_midnight`, `wallets_midnight` (the totals at the end of the day, derived), `effects_delta`, `effects_credit`, `effects_wallets` (what the day's transactions did), `edge_flows` (what crossed the edge of the scheme) and the running `drift`, `drift_credit`, `drift_wallets`, `drift_conservation` |

The day's activity is a range read on `transactions_created_idx`.

## benefit_runs and benefit_run_rows

One record for every benefits run, whoever starts it: the portal's CSV, the Benefits API or, later, the scheduler. See [ORGANIZATIONS.md](ORGANIZATIONS.md).

| Field | Description |
| --- | --- |
| id | UUID primary key. |
| org_account_id | The organization that ran it. |
| source | csv, api or schedule. |
| run_date | The program day (America/New_York) the run is for. |
| status | credited, waiting_for_funds or missed. Runs started by a caller are credited or not recorded at all (the caller sees the error); only scheduled runs record waiting_for_funds and missed. |
| idempotency_key | Unique per organization; makes a retry replay the first result. Scheduled runs use `program:<date>`. |
| row_count | Employees in the run. |
| total | Bigint cents the run credits (or would credit, while waiting or missed). |
| sent | Credited straight into employees' Benefits wallets. |
| held | Held in the organization's escrow wallet for employees who have not claimed. CHECK: when credited, sent + held = total. |
| failure_code | Why a scheduled run is waiting or missed; NULL otherwise. |
| attempts | Tries so far (1 for runs started by a caller). |
| created_at, updated_at | Timestamps. |

benefit_run_rows: one row per employee credited (id, run_id, employee_ref, amount, mode `sent` or `held`, transaction_id unique, created_at).

## Merchant refunds, settlement and historical integrity

Merchant refunds are full or partial against the original completed purchase. A refund atomically debits the business balance (allowed to go negative), restores the original customer's funded balance/payment credit immediately under the refund allocation rule, and writes a `refund` transaction (merchant wallet to the payer's wallet) referencing the original pay. A refund is immediately available for payment; no pending refund bucket exists. For approved-credit payments, the allocation restores outstanding credit first and credits balance for the remainder, preventing credit-funded value from becoming sendable through refunds; see BALANCE-POLICY.md. Refunds do not restore wallet spent_today. Finalized daily-value policy (2026-10-20): approved refunds are never limited by and never counted toward the ordinary $2,000 cap; spending does not reopen addition headroom that day. This is product policy, not regulatory approval.

At each daily settlement cutoff the whole eligible net merchant balance is settled, without partial settlement: positive net is an ACH payout (the balance drops at once and a `settle` transaction goes from the merchant wallet to Nuclear Bank); negative net is an ACH debit from the merchant bank (nothing moves until the bank confirms, then a `collect` transaction is written); zero submits nothing. The `settlements` row (one per merchant per day) is the durable cutoff/net record and reserves the amount against duplicate settlement while later sales/refunds belong to the next cycle. Only the bank's confirmed outcome clears the obligation; a returned payout writes a `settle_return`; a returned collection leaves the debt standing. Nuclear must supply interim refund liquidity. Banking authorization, retry eligibility and processing schedules depend on provider/program agreements; merchant debit collection requires the business authorization agreement described in [Nacha's ACH guide](https://achdevguide.nacha.org/how-ach-works).

All transaction ownership and spender references are immutable after posting, even when tags are reassigned or devices revoked. Deletion of referenced accounts, wallets, bank accounts, physical tags, passes, fundings and transactions is restricted; access is archived or disabled rather than cascade-deleted.

## tags

Source of truth for physical tags only, including inventory and current wallet assignment. Reset clears wallet_id and label, preserving uid, counter and history.

| Field | Description |
| --- | --- |
| id | Primary key identifying the physical tag. |
| uid | Unique indexed NFC UID, normalized to uppercase. |
| model_id | Foreign key to tag_models.id. |
| wallet_id | Nullable foreign key to wallets.id; NULL means unassigned and unable to pay. |
| label | Nullable user-facing name; cleared on reset. |
| counter | Nullable last consumed verified physical-tag SDM counter; never reset on unlink or reassignment. |
| last_read_at | Nullable last backend-verified read timestamp. |
| locked | Boolean blocking payment use without removing the assignment. Default and unlock permissions remain to be finalized. |
| transaction_limit | Nullable bigint per-payment limit in minor units; NULL means no additional tag ceiling. |
| created_at | Creation timestamp. |
| updated_at | Last update timestamp. |

Claiming and managing: a tag is claimed by tapping it with a phone and sending the URL, which burns the proof; it must be unassigned (wallet_id NULL), and it is assigned to one of the claimer's active wallets. After that it is managed by its tag id: rename, lock, set transaction_limit, move to another wallet of the same account, or reset (clears wallet_id, label, locked and transaction_limit; keeps uid, counter and history). A delegated wallet device may only lock its own wallet's tags. Counter comparison and update are atomic: verify the proof first and accept only a greater incoming value; initialize NULL on the first consumed proof. The tag's current model determines band/card type. No pass UUIDs live here. A verified UID alone does not authorize payment without the proof, active wallet authority and applicable limits.

## tag_models

| Field | Description |
| --- | --- |
| id | Model primary key. |
| type | band or card. |
| name | Model name. |
| photo | R2 key of the uploaded PNG (`tags/<id>-<epoch ms>.png`, see Images), or NULL. |
| currency | Sale currency code. |
| price | Integer minor-unit sale price. |
| country | Sale country/market; precise market behavior remains to be finalized. |
| quantity | Integer total units allocated to the model. |
| sold | Integer sold count, updated atomically. |
| limited | Boolean indicating a limited edition. |
| status | pending, preorder, available, or closed. |
| created_at | Creation timestamp. |
| updated_at | Last model update timestamp; updates to sold alone do not change this timestamp. |

Preorders are final: no cancellations or returns. `sold` goes up when a store purchase completes (`POST /v1/shop/orders`), never beyond quantity; a tag is attached to the order at shipping and the customer then claims it by tapping.

## orders

One row per completed store purchase. Created only on success; a declined attempt is a declined `purchase` transaction with no order. The payment is a `purchase` transaction from the buyer's wallet to the Nuclear Shop wallet. `type` says what was bought: `tag` (a band or card, `model_id`) or `shop` (merchandise, `shop_id`).

| Field | Description |
| --- | --- |
| id | Primary key. |
| type | `tag` (default) or `shop`. |
| account_id, wallet_id | The buyer and the wallet that paid (the wallet must belong to the account). |
| model_id | tag_models.id; set for type `tag`, NULL for `shop`. |
| shop_id | shop.id; set for type `shop`, NULL for `tag`. |
| name | Snapshot of the model or item name at purchase. |
| model_type | band or card (snapshot); only for type `tag`. |
| quantity | 1-20. |
| unit_price, total | Cents, snapshotted; total = unit_price x quantity. |
| currency | Default USD. |
| shipping | JSON object: name, line1, line2?, city, region, postal_code, country (2 letters); NULL for a download order. |
| status | paid (default), shipped or cancelled. |
| transaction_id | Unique foreign key to the purchase transaction. |
| created_at, updated_at | Timestamps. |
| delivery | `ship` (default: shipping address required) or `download` (digital shop item; shipping NULL, type `shop` only). |

## shop

Our own merchandise for sale: id, name, description, photo (the R2 key of the PNG, `shop/<id>-<epoch ms>.png`; the API renders the full URL), price (cents), currency, stock (NULL = not tracked), sold, status (pending, available or closed), created_at, updated_at, kind (`physical` default, or `digital`: no stock, quantity 1 per order, needs a file before it can be available) and file (the key of the downloadable file in the private bucket `nuclear-uploads`, `downloads/<item id>-<epoch ms>.<ext>`; digital only). Items are bought with `POST /v1/shop/orders {item_id, ...}`, which creates an `orders` row of type `shop` and raises `sold` (and lowers `stock` when tracked). Managed in the admin portal's Shop page (Admin and Sales).

## logs

The audit trail, append-only (triggers refuse update, delete and truncate): id, actor_type (admin, operator, customer, agent or system), actor_id, actor_label (an admin's Access ID or a customer's email), action (for example `tag_model.created`, `admin.created`, `refund.approved`, `user.suspended`, `customer.login`), target_type, target_id, target_label, details (small JSON, never secrets), ip and created_at. Written for every admin action and for customer security events (sign-up, login and failed login, logout, handle change, device revoke, agent key rotate and revoke). Shown on the admin portal's Logs page (Admin) and as the Activity tab of a user or merchant. A log failure never blocks the action it describes.

## uploads

One row per file a person or business uploaded: id, account_id (the uploader), type (`business_document` today), path (the object key inside the private R2 bucket `nuclear-uploads`: `<account id>/<upload id>.<pdf|png|jpg>`) and created_at. The bucket is never public: admins (Admin and Merchants roles) download business documents through `GET /v1/admin/merchants/:id/documents/:uploadId`, and every download is logged. PDF, PNG or JPEG only (content type and first bytes checked), 5 MB at most, 10 documents per business. 

## Images

Image files live in the R2 bucket `nuclear-images` (binding `IMAGES`): tag pictures (`tags/`), store pictures (`shop/`), account photos (`accounts/`), wallet photos (`wallets/`) and product images (`products/`). Every other uploaded document goes to the private bucket `nuclear-uploads` (see `uploads`). A `photo` column holds only the **R2 key** (`<folder>/<id>-<epoch ms>.<png|jpg>`, enforced by a CHECK), and the API builds the full public URL (`/v1/photos/<key>`) whenever it returns one. A new upload gets a new key and the old object is deleted. Tag and shop pictures are PNG, 256 KB at most (the admin portal resizes to 256 x 256); account and wallet photos are cropped to 256 x 256 and compressed to JPEG by the API.

## passes

Apple/Google passes only; replaces the former wallet-linked credentials table. Each separately issued pass has its own UUID and may be revoked independently.

| Field | Description |
| --- | --- |
| id | Generated UUID used as the Apple/Google NFC payload identifier. |
| wallet_id | Foreign key to the authorized wallet. |
| platform | Required ios or android. |
| locked | Boolean temporarily blocking payments. |
| status | Pass lifecycle state, including revocation; exact values remain to be finalized. |
| created_at | Creation timestamp. |
| updated_at | Last update timestamp. |

No label, credential, type, model_id or counter field on passes. Platform/session replay protection is separate from physical-tag counters. External provisioning identifiers may be needed once integrations are settled. locked, status and timestamp fields follow the current proposed pass shape; removal of label is confirmed.

Physical-tag proposal: Orb reads the NTAG 424 dynamic NDEF URL and relays it through the authenticated POS with the payment intent/attempt. Backend validates URL structure, decrypts the configured PICC data, verifies the SDM MAC, and atomically rejects previously consumed proofs before resolving tags.uid and its current wallet assignment. Verify the MAC before comparing or updating tags.counter. Update counter only when the verified incoming value is greater than its current value; the first verified consumed value may initialize NULL. Enforce the comparison atomically so concurrent requests can never decrease or reuse the stored counter. For a new payment attempt, require the incoming counter to exceed the stored counter (NULL means none consumed yet); gaps caused by non-payment reads are valid. Atomically consume the counter with the durable attempt result and any financial writes, including when the verified attempt is declined. An authenticated retry of the same attempt returns its recorded result without another debit; a consumed proof cannot authorize a different attempt. Every backend-verified tap whose counter is greater than the stored value burns its proof by consuming the counter, whether it is used for a payment, a refund approval or an account lookup, and including when the tag is then found unassigned or locked. A URL that was merely opened but never submitted for verification is not consumed. Apple/Google passes have no counter column and require their own protocol/session replay controls. Exact key provisioning and pass replay-state storage remain to be finalized before deployment.

Apple pass proposal: put the pass UUID in nfc.message and use the approved Apple VAS reader flow, encryptionPublicKey and NFC pass entitlement. Google pass proposal: put its UUID in smartTapRedemptionValue and configure the Smart Tap-enabled class/redemption issuer and certified reader. Protocol verification normalizes each result to passes.id plus verified tap/session evidence; a bare UUID submitted by a client is insufficient. Platform approval for the intended closed-loop spending use and reader/backend verification responsibilities remain integration dependencies.

An authenticated merchant payment intent supplies merchant and amount; a tag URL identifies/verifies the spending credential and is never itself a debit endpoint. After verification, enforce tag, wallet, account and balance limits and commit the debit idempotently. SDM freshness does not cryptographically bind the physical tag to the amount or merchant; session/intent binding and the desired customer confirmation policy remain to be specified.

## settlements

One row per merchant per day: the payout (credit) or collection (debit) the settlement job sends to the merchant's bank (`lib/settlement.ts`). A "run" is just the group of rows for a settle date.

| Field | Description |
| --- | --- |
| id | Primary key. |
| settle_date | The program date (America/New_York) being settled. Unique with merchant_account_id: a rerun, a second cron or a second close-out cannot settle a merchant twice for a day (a close-out takes today's date, so the nightly run skips that merchant for the day). |
| merchant_account_id | The merchant. |
| bank_account_id | The payout bank used (composite foreign key with the merchant). |
| direction | `credit` (a payout to the bank) or `debit` (a collection from it). |
| source | `nightly` (the daily job) or `close_out` (the merchant ended its day). Migration 0005. |
| rail | `instant` (RTP or FedNow) or `ach` (same-day for a close-out, standard for the nightly run). A collection is always `ach`. An instant payment the bank cannot take is moved to `ach` on the same row. Migration 0005. |
| amount | Positive bigint cents. |
| status | `submitted` (sent to the bank, waiting), `settled`, `returned` (the bank returned it) or `failed` (the batch was refused). `resolved_at` is set exactly when the status is not `submitted`. |
| provider_reference | Bank or ACH batch identifier. |
| failure_code | Why a returned or failed row did not settle. |
| created_at, resolved_at, updated_at | Timestamps. |

A payout writes its `settle` transaction when it is submitted (the money has left the balance); a bank return writes a `settle_return` and ends the row `returned`. A collection writes nothing until the bank confirms, then a `collect` transaction (if the bank returns it later, a `collect_return` takes the money back and the row ends `returned`); collections in flight count against the debt so it is never collected twice. The job claims a day in `system.settled_day` only when the day is done, so a run that stopped half way is finished by the next call.

## refunds

Refund requests that wait for approval (a terminal that does not allow direct refunds, or a tap by someone who is not write staff). The money has not moved: a pending request only **reserves** its amount (and item quantities) against the original payment. Approving it writes the `refund` transaction **under this row's id** and moves the money; rejecting it just closes the request. A refund that needs no approval is written as a transaction directly and has no row here.

| Field | Description |
| --- | --- |
| id | Primary key; becomes the refund transaction's id on approval. |
| merchant_account_id | The merchant. |
| pay_transaction_id | The completed payment being refunded. |
| terminal_id | The terminal that asked. |
| amount | Positive bigint cents. |
| mode | full, partial or items. |
| items | For mode `items`: `[{checkout_item_id, quantity, restock}]`; NULL otherwise (CHECK). |
| reference | Nullable. |
| status | `pending`, `approved` or `rejected`; `resolved_at` is set exactly when it is not pending. |
| idem | Unique: `refund:<merchant>:<key>`; the same key is used by the transaction written on approval. |
| approved_by_account_id | Who approved it (the system account for an admin). |
| created_at, resolved_at | Timestamps. |

Pending requests never expire. The merchant's lists show them as pending refunds (through the `txn` view), rejected ones as failed refunds.

## Reconciliation

There is no ledger table. The ledger's job (proving the numbers add up) is done by checks of increasing depth over `transactions`; nothing is ever corrected automatically: a mismatch marks the day's snapshot unreconciled and is fixed by an admin-made `adjustment` transaction with a reason. The view `account_effects` lists what each completed transaction did to each account (`delta` to the balance, `credit_delta` to credit drawn, `wdelta` to a Benefits or escrow wallet's own balance); a balance equals the sum of its effects.

| Level | When | What |
| --- | --- | --- |
| R0 inline | every money move | immutability triggers, `UNIQUE (idem)`, CHECKs, the money functions' own rules |
| R1 conservation | nightly, with the day's snapshot, at 00:01 New York, **before** settlement and the Fixed Benefits schedule | one calendar day of transactions (a `created_at` range, never history): the change in total balances between two midnights equals the day's effects, likewise credit drawn and the Benefits and escrow wallets' balances, and the day's effects less the credit extended equal what crossed the edge of the scheme (loads in; purchases, payouts, collections and bank adjustments out). A midnight balance is derived: balances now minus the effects created since that midnight. Each night's gap is added to a running drift, so an error stays red every night until the balance is corrected or an `adjustment` records the missing transaction; the first night is the baseline (drift starts at 0). Escrow wallets are also compared with their unclaimed employees' balances |
| R2 counters | Run Check (the nightly result carries these as true) | `wallets.spent_today` equals today's completed sends, payments and purchases from the wallet; the daily-cap numbers match the transactions; earmarks stay within balances |
| R3 per account | on demand (`GET /v1/admin/users|merchants|organizations/:id/check`) and in the nightly job | one account's balance and credit against all its effects, and its Benefits and escrow wallets against theirs |

The nightly result is stored on the day's snapshot row and in `system.reconciliation_snapshot` (what the Overview shows); the admin Run Check computes the whole set as a full recompute and replaces the latter. Earmarks of ordinary wallets can only be checked as a bound (they are not transactions; their changes are in `logs`). An external check against the bank's statements waits for a real provider.

## Query implementation

Fundings rows track bank-load attempts; transactions record every movement and every declined attempt; balances is the atomically maintained current summary, updated by the same money function call that writes the transaction. Wallets identify spenders and limits, not separately funded pots.

Activity combines transactions with fundings that have no transaction_id, using a single ordered, paginated feed so completed loads appear once. Pending and failed loads remain visible from fundings. An account's history is read through its wallets' indexes (most accounts have one wallet). Join only the resulting page to wallet/account display records.

