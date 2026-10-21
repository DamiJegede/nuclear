# Nuclear initial tables

Updated October 13, 2026. Working schema consolidation; not an applied database migration. Includes the user's compact model and accepted refinements. Status values and implementation constraints remain to be finalized. All money fields use bigint integer minor units, initially USD cents; all timestamps use timestamptz.

## Current decisions

The initial plan has twelve tables: accounts, balances, wallets, devices, businesses, bank_accounts, fundings, transactions, tags, tag_models, passes, and ledger_entries. Merchant hardware and staff add three more, terminals, orbs and staff, the merchant catalogue adds two, categories and products, and orders add two more, checkouts and checkout_items, and the admin portal adds two more, admins and admin_sessions, for twenty-one in total (migrations 0001 to 0008). Later migrations add wallet_allocations, throttles, system, shop, orders, logs, uploads, settlements, employees, benefit_runs, benefit_run_rows, benefit_programs and api_keys, for 34 tables in nuclear-dev today (the counts above are historical). Item refunds are carried on the refund transaction as JSON rather than in a table. Individual bank-load attempts live in fundings. A fund transaction is created only when funding is confirmed successful and released. Profile, address, subscription-plan and price tables are outside the initial compact schema.

Confirmed refinements: accounts.handle after type (nullable, set or changed later only by the primary account's own session; 4-12 alphanumeric, unique index); password_hash; owner-issued five-minute wallet magic links and devices, with no member_account_id; businesses.account_id primary key; bank_accounts.last4 and provider_account_id without verified_at; separate account-wide balance plus approved credit; sends use funded balance only, merchant payments may also use approved credit; no pending-funding availability; spent_today counts successful sends/payments and resets at midnight Eastern; nullable tags.transaction_limit; inline business address; refund/adjustment types; transactions.status_code; explicit endpoint foreign keys; failed funding attempts remain in fundings.

The old pending/open/early-spend model and early-spend return policy are withdrawn. balance_pending is an informational summary of funding awaiting clearance, not spendable value. [BALANCE-POLICY.md](BALANCE-POLICY.md) defines current availability and proposed credit repayment/refund/return accounting. Daily program-value controls remain in scope, but their summaries are no longer balances columns; ledger/funding queries and transactional headroom enforcement must provide them. Combined devices/session fields and app-launch rolling 90-day extension are adopted. Settlement allocation and provider integration fields remain to finalize. This document is authoritative for the compact table plan; no database migration has been applied.

## accounts

| Field | Description |
| --- | --- |
| id | Primary key identifying the consumer or business account. |
| type | C for consumer; B for business; O for organization (an employer that credits employees, migration 0030). |
| handle | Public unique account handle: 4-12 characters, letters and digits only, stored lowercase and matched case-insensitively. Nullable: not collected at signup. Only the primary/root account, from its own authenticated session, can set or change it; delegated wallet sessions, wallets and members never have or edit handles. Uniquely indexed; resolves to the account id. |
| name | Account name. |
| phone | Contact phone number. |
| email | Contact/login email where applicable. Business contact details do not authorize shared staff login. |
| password_hash | Password hash, never a plaintext password. Nullable for accounts without password login. |
| photo | R2 key of the account's profile picture (`accounts/<id>-<epoch ms>.jpg`, 256 x 256 JPEG, uploaded after the account exists), or NULL. Older rows may hold an https address. |
| tier | free, plus, or insider. |
| status | Account access/lifecycle status: active, pending (a new business awaiting approval), declined (refused; the business may upload a new document, which returns it to pending), suspended or closed. Businesses start pending; customers start active. A pending or declined business can sign in, see its status, upload documents and sign out, and nothing else. |
| bio | Short text the owner writes about themselves or their business, up to **128 characters** (CHECK); NULL = none. Added by migration 0023 (limit set to 128 by 0024) (physically last in the dev database; here at its logical position). |
| created_at | Creation timestamp. |
| ordinary_opening | Migration 0037. Bigint: the account's ordinary funded value (balance minus its Benefits wallets) at the start of the program day (America/New_York). Only meaningful for consumer accounts. Rolled once a day by ensureDay. Logically after balance_pending (physically last today). |
| opening_day | Migration 0037. The program day ordinary_opening and added_today are for. A row older than today rolls itself (opening = what is held now, added = 0) the next time it is locked. |
| added_today | Migration 0037. Nonnegative bigint of ordinary money added today: released bank loads, incoming sends, Benefits-to-ordinary moves. Never refunds, claims or employer credits into Benefits wallets; never reduced by spending, sending or reversals. The daily headroom is cap - ordinary_opening - added_today - balance_pending (never below 0). |
| updated_at | Last update timestamp. |

No money balance columns on accounts; these live in balances. Handles are normalized to lowercase before storage (`^[a-z0-9]{4,12}$`) and enforced by a unique index; a small reserved list (e.g. admin, nuclear, support) is rejected by the application. Resolving a handle returns the account id and default wallet for recipient selection.

## balances

One record per account; all its wallets share funds and approved credit.

| Field | Description |
| --- | --- |
| account_id | Primary key and foreign key to accounts.id. |
| balance | Bigint funded net balance. Pending loads never increase this. Merchant refunds may make business balances negative. |
| balance_pending | Nonnegative bigint funds awaiting clearance; default 0. An account-wide summary of qualifying pending funding records, unavailable for sending or spending. |
| credit_limit | Nonnegative bigint approved account-wide payment credit limit; default 0. Independent of pending ACH loads. |
| credit_spent | Nonnegative bigint outstanding credit principal used for payments; default 0. Never resets at midnight or on another load. |
| updated_at | Last update timestamp. |

Before subtracting active reservations, sends may use max(balance, 0); payments may use max(balance, 0) + max(credit_limit - credit_spent, 0), subject to account eligibility and all wallet/tag limits. Use balance first, then approved credit. Negative consumer balances or overdue/returned-credit restrictions block outgoing activity; merchant negative refund balances follow the separate daily-net settlement rule. Pending funding does not grant credit or replenish it. Allocation and repayment rules are in BALANCE-POLICY.md. Daily-value cap checks remain required even though value_added_today/opening_value_today are removed from balances.

## wallets

| Field | Description |
| --- | --- |
| id | Primary key identifying the spending wallet. |
| account_id | Foreign key to accounts.id; owner of the shared funds. |
| display_name | Wallet/person/agent display name. Default-wallet name synchronization is proposed behavior. |
| photo | R2 key of the wallet's picture (`wallets/<id>-<epoch ms>.jpg`, 256 x 256 JPEG, uploaded after the wallet exists), used in activity, or NULL. Default-wallet photo synchronization is proposed behavior. |
| type | default, agent, person or benefits (migration 0033). A **benefits** wallet belongs to the consumer account, is bound for good to one employer (org_account_id), is created at claim/first credit (never by the consumer), holds funded money in `balance` (never NULL; a compartment inside the account total that no other wallet can spend), is otherwise unrestricted: it can pay any merchant (by choosing it or with its tag), buy from the Nuclear store, receive its employer's credits and refunds of its own purchases, and move to another wallet of the same account; the one thing it cannot do is send to an external (other-account) wallet. Its money cannot be edited through the balance endpoint and the wallet cannot be closed while it holds money. |
| org_account_id | Migration 0033. The employer a benefits wallet is bound to; NULL for every other type (CHECK in both directions). One live benefits wallet per (account_id, org_account_id). Immutable (trigger), like type and account_id. Logically after account_id (physically last today). |
| daily_limit | Nullable bigint spending limit; NULL means no additional wallet daily cap. Funds and platform rules still apply. |
| spent_today | Successful sends plus payments counted today; resets to zero at 00:00 Eastern. |
| allow_pay | Whether the wallet can make merchant payments. |
| allow_send | Whether the wallet can send funded balance; credit cannot fund sends. |
| status | Wallet access/lifecycle status. |
| balance | Nullable bigint, added by migration 0011: earmarked funds. NULL (default) = the wallet draws on the account's shared funds. A number = money the owner set aside for this wallet: it can spend only up to that amount (a hard limit, never credit, no further approval) and the rest of the account cannot spend it. The amount stays inside balances.balance, so earmarking posts nothing to the ledger; sum(wallets.balance) never exceeds the account balance (every money movement locks the balances row first). Agent wallets start at 0; person wallets and the default wallet start NULL. Spends and sends decrement it, incoming sends and refunds to the wallet increase it, closing the wallet releases it. |
| key_hash | Nullable unique SHA-256 of the wallet's agent API key (migration 0012). Agent wallets only (check constraint); one key per wallet; creating a key replaces the old one; only the hash is stored, the key (`nk_agent_` + 43 characters) is created with the wallet and shown once, in the creation response; rotating it later shows the new one once. Closing the wallet clears it. |
| key_hint | Last 4 characters of the key, to tell keys apart; set exactly when key_hash is. |
| key_last_used_at | Nullable; when the key last authenticated a request. |
| created_at | Creation timestamp. |
| updated_at | Last update timestamp. |

No spend_date or member_account_id field. A wallet is a spending identity/permission path; unless it carries an earmarked balance it is not separately funded. Only the primary holder can issue a five-minute signed JWT link for this wallet, redeemed into device-scoped access as described in [WALLET-ACCESS-POLICY.md](WALLET-ACCESS-POLICY.md). Session and single-use redemption state live in devices. Once financial history exists, wallet.account_id cannot change; moving a person to another owning account requires a new wallet.

## wallet_allocations

Audit trail of earmark changes (migration 0011): id, wallet_id and account_id (composite foreign key, so the wallet must belong to the account), amount (signed, never 0: positive = set aside, negative = returned to the shared funds), balance_after (NULL = released), device_id (the owner session that made the change, nullable) and created_at.

## system

Key/value system state (migration 0016, replacing the one-row daily_reset): `key` (primary key), `value` (text) and `updated_at`. Keys in use: `daily_reset_day` (the America/New_York date on which wallets.spent_today and products.sold_today were last reset; the first cron run or money request on a new day updates it and zeroes the counters in one transaction, so a missed cron cannot leave yesterday's counters in force) and `cron_last_run` (the scheduled time of the last daily job, a heartbeat).

## throttles

Rate-limit counters (migration 0014): key (primary key, for example `login:ada@example.com`, `ip:...`, `agent:<wallet id>`), count and window_start (the window starts at the key's first hit and a hit after it ends starts a new one). The daily job deletes rows older than a day. Not exposed through any endpoint.

## devices

Combined device registration and current session; no separate sessions table. Session kinds: owner (wallet_id NULL) and wallet (wallet_id set). Merchant terminals are not devices; their sessions live on terminals. account_id identifies the primary funds owner for delegated access, not a separate recipient account.

| Field | Description |
| --- | --- |
| id | Primary key identifying this device/access registration. New login-link issuance creates a fresh row. |
| account_id | Foreign key to accounts.id; owner of the account/wallet access. |
| wallet_id | Foreign key to wallets.id; target of delegated wallet access. NULL for the account holder's own login. |
| platform | Device platform; supported values remain to finalize, including web alongside ios/android. |
| push_token | Nullable notification-delivery token, never an authentication credential. |
| session_token_hash | Nullable unique hash of the current random session token. NULL before redemption; never reset to NULL after redemption. Raw tokens are not stored. |
| session_expires_at | Nullable expiry; set to redemption time + 90 days and extended to server time + 90 days on valid app-launch renewal. NULL before redemption. |
| revoked_at | Nullable revocation timestamp; populated on logout or owner revocation. Revoked access cannot be renewed. |
| created_at | Registration/link-issuance timestamp. |
| last_accessed_at | Last authenticated device access timestamp; also updated on successful extension. |

Enforce wallet ownership consistency with account_id via a composite foreign key. One account/wallet can have many device/access registrations. Before issuing a five-minute magic-link JWT, create the row and bind the JWT jti/device_id to devices.id. Redemption conditionally sets the initial hash/expiry only when session_token_hash IS NULL, revoked_at IS NULL, the JWT is valid/unexpired and account/wallet authorization remains valid. One atomic operation makes redemption single-use; no separate redemption table is needed for this flow. A new link uses a fresh row; never recycle a redeemed/revoked row into an unredeemed state. Account/wallet binding remains fixed for a registration.

App calls POST /v1/devices/session/extend on every launch. A valid, unexpired, unrevoked session with current account/wallet authorization receives a rolling 90-day expiry from server time. Expired, revoked or unredeemed access cannot be extended; obtain new authorized login/link access instead. Normal activity updates last_accessed_at but does not implicitly extend expiry. Concurrent updates must not shorten expiry or undo revocation. No session status column is required. See [WALLET-ACCESS-POLICY.md](WALLET-ACCESS-POLICY.md).

## businesses

| Field | Description |
| --- | --- |
| account_id | Primary key and foreign key to a type-B accounts.id. |
| legal_name | Registered legal business name. |
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

Only business accounts may own terminals; a database trigger enforces the account type. `(id, account_id)` is unique so orbs can reference a terminal together with its owner. A merchant owner login creates a terminal and receives its session JWT; issuing a new JWT (re-login on a replacement tablet, or extend) replaces the stored hash, which invalidates the previous token. A terminal session authorizes only terminal endpoints and carries no owner or wallet powers.

## orbs

An Orb NFC reader unit. Unassigned units belong to no account.

| Field | Description |
| --- | --- |
| id | Primary key identifying the Orb unit; a generated UUID, separate from uid. |
| uid | The Orb's own hardware UID, its MAC address, normalized to 12 uppercase hex characters (no separators); unique. Added by migration 0006, so it is the last column. |
| model | Hardware model. |
| software | Installed firmware/software version. |
| account_id | Nullable foreign key to the owning type-B accounts.id; NULL means unassigned. |
| terminal_id | Nullable foreign key to terminals.id; NULL means not attached to a terminal. |
| created_at | Creation timestamp. |
| updated_at | Last update timestamp. |

A terminal assignment requires an owning account, and the terminal must belong to that same account (composite foreign key on terminal_id + account_id). Only business accounts may own Orbs. Orbs register themselves the first time they are claimed: the terminal reads the Orb's uid, model and firmware over BLE and sends them with the claim, so no Orb rows are pre-loaded. A terminal holds at most one Orb (unique on terminal_id). Pairing an Orb to a terminal unpairs it from its previous terminal and unpairs any Orb the target terminal already held; an Orb owned by a different account cannot be paired, and an unassigned Orb is claimed by the pairing account.

## staff

Staff of a business. A staff member is a consumer account with their own wallet and credentials.

| Field | Description |
| --- | --- |
| id | Primary key identifying the staff record. |
| account_id | Foreign key to the employing type-B accounts.id. |
| staff_account_id | Foreign key to the staff member's type-C accounts.id. |
| bank_account_id | Nullable foreign key to bank_accounts.id: the staff member's own bank account. Enforced with a composite foreign key on (bank_account_id, staff_account_id). |
| role | read, or write. Write staff may approve refunds by tapping any of their credentials on the Orb; the refund request carries the tap and the server resolves the account, so one refund route serves both direct and approved refunds. |
| created_at | Creation timestamp. |
| updated_at | Last update timestamp. |

One staff record per (account_id, staff_account_id). A trigger enforces the account types. The tapped credential resolves to the staff member's account through its wallet; no credential is pinned to the staff record.

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
| sold_today | Units sold since 00:00 Eastern; reset every program day by the daily job. |
| discount | Non-negative bigint discount in integer minor units off price, default 0, never more than price. The effective unit price is price minus discount. |
| created_at | Creation timestamp. |
| updated_at | Last update timestamp. |

A trigger enforces the business account type. Selling decrements stock in the same transaction as the payment: a sale of tracked stock fails rather than going below 0, and reaching 0 flags the product sold_out. Restocking is an increment (never a "set to" value) so a concurrent sale is not overwritten, and returns a sold-out product to available. Sold line items are recorded on the order's checkout_items, and an item refund can restock them. Percentage discounts, variants and per-location pricing are outside this initial shape.

## checkouts

An order a merchant creates and a customer pays. Owned by a business (type B) account. Stock is taken when the order is paid, not when it is created.

| Field | Description |
| --- | --- |
| id | Primary key identifying the checkout. It is shown to the customer (for example as a QR code), so it is an unguessable UUID. |
| account_id | Foreign key to the merchant's type-B accounts.id. |
| terminal_id | Nullable foreign key to terminals.id (same account via composite foreign key); NULL when not created on a terminal. |
| reference | Nullable merchant order reference (1-64 characters). |
| currency | Currency code, default USD. |
| total | Positive bigint total in integer minor units, fixed at creation from the item snapshots (or the keyed amount). |
| status | open, paid, canceled, or expired. An open checkout past expires_at is treated as expired and marked so when a payment is attempted. |
| expires_at | Nullable expiry; NULL means it never expires. |
| created_at | Creation timestamp. |
| updated_at | Last update timestamp. |

A trigger enforces the business account type. A checkout is settled by at most one completed pay transaction (unique index on transactions.checkout_id for completed payments); failed attempts remain against it, and it stays open for another try. A one-step payment (amount or items sent with the tap) creates its checkout in the same transaction and cancels it if the payment is declined.

## checkout_items

Order lines. A checkout may have none (a keyed-in amount).

| Field | Description |
| --- | --- |
| id | Primary key identifying the line. |
| checkout_id | Foreign key to checkouts.id. |
| product_id | Nullable foreign key to products.id; NULL for an ad-hoc line. Must belong to the checkout's merchant (trigger). |
| name | Product name snapshot (1-120 characters). |
| unit_price | Price snapshot in integer minor units. |
| discount | Per-unit discount snapshot in integer minor units, never more than unit_price. |
| quantity | Positive integer quantity. |
| refunded_quantity | Units returned by completed item refunds, default 0. |
| refund_pending_quantity | Units reserved by pending item refunds, default 0. refunded_quantity plus refund_pending_quantity never exceeds quantity. |
| created_at | Creation timestamp. |

The line total is (unit_price - discount) x quantity. The refund counters are the per-line refund state: a pending refund adds to refund_pending_quantity, completing it moves the units to refunded_quantity, rejecting it releases them. They change only under the original payment's row lock. Names and prices are snapshotted so history survives catalogue edits.

## admins

People who sign in to the admin portal with an Access ID and an access token (then an authenticator code). Separate from accounts: an admin is not a customer or merchant and has no wallet or balance.

| Field | Description |
| --- | --- |
| id | Primary key identifying the admin. |
| access_id | Unique uppercase sign-in name, 3-32 characters: A-Z, 0-9, '.', '_' or '-', starting with a letter or digit. Generated by the server as 12 characters (no look-alike characters), always stored and shown uppercase; typing lowercase at sign-in is accepted. |
| name | Display name (1-80 characters). |
| access_token_hash | scrypt hash of the access token, never the token itself. The token is 32 characters, generated by the server, returned once when the admin is created or the token is reset, and cannot be retrieved later. (Renamed from password_hash in migration 0008.) |
| status | active or disabled. Disabling signs the person out everywhere. |
| failed_attempts | Consecutive wrong passwords since the last good sign-in. Reaching 5 locks the account and resets the count. |
| locked_until | Nullable; sign-in is refused until then (15 minutes after a lock). |
| mfa_secret | Nullable. The authenticator's shared secret (base32), AES-256-GCM encrypted with a key held outside the database (`MFA_ENCRYPTION_KEY`); never plaintext. Present but inactive until mfa_enabled_at is set. |
| mfa_enabled_at | Nullable. NULL means not enrolled: the admin can only enroll. Multi-factor is mandatory. |
| mfa_last_step | Nullable bigint: the last accepted 30-second time step, so a code can be used only once. |
| mfa_recovery | JSON array of SHA-256 hashes of the unused single-use recovery codes (ten at enrollment). A used code is removed. |
| last_login_at | Nullable last successful sign-in. |
| created_by | Nullable foreign key to admins.id: the admin who created this one, or NULL when the operator did (via the scripts). Added by migration 0008, so it is the last column. |
| created_at | Creation timestamp. |
| updated_at | Last update timestamp. |

Every sign-in failure (unknown id, wrong password, wrong code, disabled, locked) gives the same answer. With multi-factor enrolled, a correct password only yields a five-minute challenge; a session needs a valid authenticator or recovery code too, and wrong codes count toward the same lock. Any fully signed-in admin (or the operator, via scripts) can create admins; disabling, resetting and similar changes are the operator's. There is no admin role distinction yet.
| role | admin (default), accounting, sales, support, tags or merchants (check constraint; migration 0017; physically the last column). Decides which admin pages and API routes the person may use; see AGENTS.md. |

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

## bank_accounts

| Field | Description |
| --- | --- |
| id | Primary key identifying the bank account record. |
| account_id | Foreign key to the consumer/business owner. |
| routing_number | The 9-digit routing number, stored as **plain text** (it is public: the Fed publishes the directory; migrations 0027/0028 enforce the format). Customer sandbox loads hold the placeholder `SANDBOX`. Not returned by the merchant endpoints (only `last4` of the account number is). |
| account_number | The account number, stored **encrypted** (AES-256-GCM, `v1.` prefix, bound to the account and field; migration 0026 enforces the format), kept so settlements can be originated and the payout bank can move to another provider. Only `last4` is ever shown; full reads go through one audited function. |
| last4 | Last four digits for display. |
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

On confirmed successful funding release, atomically remove its recognized amount from balance_pending, update funding status, balance/approved-credit repayment allocation and ledger postings, create exactly one completed fund transaction for the gross load amount, and link transaction_id. Proposed credit repayment priority is documented in BALANCE-POLICY.md. Creating the activity transaction must not credit the money a second time.

A funding attempt that fails before release has no fund transaction. Remove any amount previously recognized in balance_pending and release its reservations; no available funds or approved credit were granted by that pending load. Never subtract an amount that was not recognized. A later bank return preserves the original successful fund transaction and released_at; record the return on fundings and append corrective ledger postings. A timeout remains unresolved rather than becoming failed. Exact provider-stage mapping, cancellation eligibility and return accounting remain to be finalized.

## transactions

Sends, purchases, settlements, refunds and adjustments are recorded here, including failed operations. Funding appears here only after successful release; its attempt lifecycle stays in fundings.

| Field | Description |
| --- | --- |
| id | Primary key identifying the operation. |
| type | fund, send, pay, settle, refund, adjustment, purchase, allocate, claim or move. move (migration 0033): a same-account move between two wallets of one account (Benefits to an ordinary wallet): from and to account are equal, both wallets set, net zero for the account total; the posting debits funded_balance attributed to the Benefits wallet and credits funded_balance unattributed. allocate (migration 0030): an organization holds money for an employee who has not claimed yet, from the organization's account and wallet with no to_account; the posting debits funded_balance and credits employee_escrow. claim: the employee takes it, to the employee's account and wallet with no from_account; the posting debits employee_escrow and credits funded_balance. A purchase is a store purchase of bands/cards: from the buyer's account and wallet to the platform (no to_account); the posting debits the buyer's funded_balance and credits platform_clearing (migration 0010). |
| from_account_id | Nullable foreign key to accounts.id; source owner. Required for fund/send/pay/settle/refund; NULL reserved for defined system adjustments. |
| to_account_id | Nullable foreign key to accounts.id; destination owner. Required for fund/send/pay/settle/refund; NULL reserved for defined system adjustments. |
| from_wallet_id | Nullable foreign key to wallets.id; populated for send/pay. |
| to_wallet_id | Nullable foreign key to wallets.id; populated for send/refund. |
| from_bank_account_id | Nullable foreign key to bank_accounts.id; populated for fund or a negative merchant daily-net ACH collection (type settle). |
| to_bank_account_id | Nullable foreign key to bank_accounts.id; populated for a positive merchant daily-net payout (type settle). |
| amount | Positive amount in integer minor units. |
| related_transaction_id | Nullable foreign key to transactions.id; required for refund to identify the original completed pay transaction. Corrections may also reference their original operation under defined adjustment rules. |
| settlement_id | Nullable foreign key to settlements.id; set only on `settle` transactions (a CHECK enforces it) to the run that produced them. Added by migration 0025 (physically last in the dev database). |
| terminal_id | Nullable foreign key to terminals.id for a pay or refund taken on a terminal. A trigger requires the terminal to belong to the merchant (to_account_id for pay, from_account_id for refund). |
| reference | Nullable merchant order reference (1-64 characters); pay only. |
| approved_by_account_id | Nullable foreign key to the approving staff member's accounts.id; refund only, set when a staff tap approved it. |
| checkout_id | Nullable foreign key to checkouts.id; pay and refund only. A trigger requires the order to belong to the merchant (to_account_id for a pay, from_account_id for a refund). A refund carries the checkout of the payment it refunds. At most one completed payment per checkout. |
| items | Nullable JSON array for an item refund: `[{checkout_item_id, quantity, restock}]`; refund only. It is that refund's own record of the lines it covers (needed to approve, reject or audit it); the per-line totals live on checkout_items. restock (default false) returns tracked stock when the refund completes. There is no refund-items table. |
| tag_id | Nullable foreign key to tags.id for a physical-tag payment. |
| pass_id | Nullable foreign key to passes.id for an Apple/Google pass payment. |
| status | Operation state, including pending, completed, failed, or returned; full state model to be finalized. |
| status_code | Nullable machine-readable detail explaining the operation status, including declines/failures such as insufficient_balance, spend_limit_exceeded, or bank_rejected. Success detail codes may be defined as needed. |
| idempotency_key | Stable retry identifier, unique within the agreed operation scope; must reject mismatched reuse. Scope: per merchant account for pay (terminal attempts use a t: prefix, customer-confirmed payments a c:<payer account>: prefix); per source account and type for all other operations. |
| provider_reference | Nullable bank/provider operation identifier, for external operations such as settlement. Funding provider references live in fundings. Also used, without a schema change, to record who resolved a pending refund from the admin portal: `admin:<ACCESS ID>` or `operator`. |
| timestamp | Operation creation timestamp. |
| completed_at | Nullable completion timestamp. A later return preserves the original completion history. |

A refund that is not yet approved is a pending transaction (status_code awaiting_approval): it reserves its amount against the original payment, posts no ledger entries and does not touch balances until approved, and it has no expiry. Rejecting it sets status failed with status_code rejected and releases the reservation. Failed non-funding operations do not post a completed financial effect; release any associated holds. A timeout is not a confirmed failure. A fund row starts completed, with completed_at equal to fundings.released_at; pending and failed funding attempts never create a fund row. A later bank return is tracked on fundings and does not erase or rewrite the successful funding activity.

Explicit endpoint foreign keys replace polymorphic from/to; tag_id/pass_id replace origin to allow foreign-key enforcement. No from_type/to_type fields are needed. Accounts provide ownership and activity filtering; wallet/bank references provide the particular spending or bank endpoint. Store original account and wallet attribution on the transaction, independent of subsequent tag reassignment.

| Type | Source detail | Destination detail |
| --- | --- | --- |
| fund | from_bank_account_id | to_account_id |
| send | from_wallet_id | to_wallet_id |
| pay | from_wallet_id | to_account_id (business) |
| settle (positive net payout) | from_account_id (business) | to_bank_account_id |
| settle (negative net collection) | from_bank_account_id (merchant bank) | to_account_id (business) |
| refund | from_account_id (original business) | to_wallet_id (original spender) |
| adjustment | To be defined | To be defined |

For each operation, populate the source/destination account owner IDs too; consumer self-funding normally has the same account on both sides. Enforce foreign keys plus type-specific required/forbidden endpoint constraints. Enforce wallet and bank ownership consistency with the corresponding account through composite foreign keys and supporting unique constraints. Foreign keys alone do not enforce business account type; that validation requires an additional database constraint mechanism. Credential references are mutually exclusive and allowed only for pay; online pay can have neither. Validate credential authority at execution time without requiring its current wallet assignment to remain the same forever.

Index the account activity paths with timestamp/id for pagination and index referencing columns used for joins and reverse lookups; foreign keys do not automatically create all referencing indexes. Exact indexes will be finalized with representative queries. related_transaction_id is adopted. Enforce refund reference to completed pay, original merchant and wallet, and total completed/concurrent reserved refunds no greater than the original amount. Parent payment/attempt/payout relationships and system-adjustment endpoints remain to be specified before implementation. No migration has been applied.

## employees

Migration 0030, see [ORGANIZATIONS.md](ORGANIZATIONS.md). One row per person an organization credits.

| Field | Description |
| --- | --- |
| id | UUID primary key. |
| org_account_id | The organization (account type O) that credits this person. |
| employee_account_id | Nullable: the consumer account that claimed, NULL until then. |
| employee_id | The organization's own alphanumeric, immutable employee identifier; unique within the organization. |
| name | Updated from each CSV. |
| email | Updated from each CSV; where the claim and reminder emails go. |
| balance | Bigint cents held in escrow while the person has no account; 0 once claimed. Reconciled against the employee_escrow ledger bucket. |
| claim_token_hash | SHA-256 of the emailed claim token (the token is never stored); NULL once claimed. Replaced by each reminder. |
| reminded_at | When the person was last emailed about held money. |
| fixed_benefit | Migration 0036, nullable bigint cents (1 to 10,000,000). The amount the Fixed Benefits schedule credits this employee on each payment date; NULL = none. Set by the portal's fixed-benefits file, the per-employee edit and the Benefits API (0 or null clears). Logically before created_at (physically last today). |
| status | active or removed (migration 0031). A removed employee is hidden from the portal lists and counts and is not paid a fixed benefit, but removal never touches money: credit held for them (balance) and their claim token stay, so they can still claim it (migration 0038 dropped the 0031 check that forbade this); a later CSV that mentions the employee_id makes them active again. |
| created_at | Row creation time. |
| updated_at | Last change. |

There is no amount column: the amount to credit is only a column of the uploaded CSV, recorded per credit in benefit_run_rows and the transactions.

## api_keys

Migration 0034, see [ORGANIZATIONS.md](ORGANIZATIONS.md#benefits-api). A generic table of API keys; today only organizations (account type O) use it, for the Benefits API.

| Field | Description |
| --- | --- |
| id | UUID primary key. |
| account_id | The account the key acts as (an organization today). |
| name | Label, `Default` today (one live key per account). |
| key_hash | SHA-256 of the key (`nk_org_` plus 43 characters). The key itself is never stored and is shown once, when generated. Unique. |
| key_hint | The key's last four characters, for display. |
| created_at | When the key was generated. |
| last_used_at | Stamped on each request the key makes. |
| revoked_at | Set when the key is rotated or revoked; NULL while live. A partial unique index allows only one live key per account. |

## benefit_programs

Migration 0036, see [ORGANIZATIONS.md](ORGANIZATIONS.md#benefit-programs-fixed-and-flexible-benefits). One row per organization, created at sign-up (and backfilled for existing organizations).

| Field | Description |
| --- | --- |
| org_account_id | Primary key: the organization (account type O). |
| mode | fixed or flexible (default flexible). Fixed runs a schedule; Flexible schedules nothing. |
| cadence | monthly, weekly or biweekly; NULL when flexible. |
| day_of_month | 1 to 28 for monthly (so every month has it). |
| weekday | 0 (Sunday) to 6 for weekly and biweekly. |
| start_date | Biweekly only: the first payment date; every payment is that plus 14 days times k. |
| next_run_date | The next payment date (America/New_York); NULL when flexible. |
| warned_for | The payment date a low-funds warning was already sent for. |
| last_attempt_at | The scheduler claims a program for half an hour so two cron runs cannot both pay it. |
| chosen_at | NULL until the organization has picked a mode (the portal asks on the first sign-in). |
| created_at, updated_at | Timestamps. |

## benefit_runs and benefit_run_rows

Migration 0035 (they replace `credit_batches` and `credit_batch_rows` of migration 0030; rows were copied with their ids and the old tables dropped). One record for every benefits run, whoever starts it: the portal's CSV, the Benefits API or, later, the scheduler. See [ORGANIZATIONS.md](ORGANIZATIONS.md).

| Field | Description |
| --- | --- |
| id | UUID primary key. |
| org_account_id | The organization that ran it. |
| source | csv, api or schedule. |
| run_date | The program day (America/New_York) the run is for. |
| status | credited, waiting_for_funds or missed. Runs started by a caller are credited or not recorded at all (the caller sees the error); only scheduled runs record waiting_for_funds and missed. |
| idempotency_key | Unique per organization; makes a retry replay the first result. Scheduled runs will use `program:<date>`. |
| row_count | Employees in the run. |
| total | Bigint cents the run credits (or would credit, while waiting or missed). |
| sent | Credited straight into employees' Benefits wallets. |
| held | Held in escrow for employees who have not claimed. CHECK: when credited, sent + held = total. |
| failure_code | Why a scheduled run is waiting or missed; NULL otherwise. |
| attempts | Tries so far (1 for runs started by a caller). |
| created_at, updated_at | Timestamps. |

benefit_run_rows: one row per employee credited (id, run_id, employee_ref, amount, mode `sent` or `held`, transaction_id unique, created_at).

## Merchant refunds, settlement and historical integrity

Merchant refunds are full or partial against the original completed purchase. Atomically debit the business balance (allowed to go negative), restore the original customer's funded balance/payment credit immediately under the proposed refund allocation rule, create a refund transaction referencing the original pay, and post balanced ledger entries. A refund is immediately available for payment; no pending refund bucket exists. For approved-credit payments, the proposed allocation restores outstanding credit first and credits balance for the remainder, preventing credit-funded value from becoming sendable through refunds; see BALANCE-POLICY.md. Refunds do not automatically restore wallet spent_today. Finalized daily-value policy (2026-10-20): approved refunds are never limited by and never counted toward the ordinary $2,000 cap (they may exceed it); spending does not reopen addition headroom that day. Preserve original compartment routing and carry actual funds into the next day. See BALANCE-POLICY.md and the refund exception in ORGANIZATIONS.md; this is product policy, not regulatory approval.

At each daily settlement cutoff, settle the full eligible net merchant balance, without partial settlement: positive net is an ACH payout; negative net is an authorized ACH debit from the merchant bank; zero submits no bank movement. Capture an immutable cutoff/net amount and reserve it against duplicate settlement while permitting subsequent sales/refunds to belong to the next net cycle. Only confirmed bank outcome clears the corresponding obligation; submitting a debit must not zero a negative balance. Failed/returned collections leave or reinstate merchant debt and do not revoke customer refunds. Nuclear must supply interim refund liquidity. Banking authorization, retry eligibility and processing schedules depend on provider/program agreements; merchant debit collection requires the business authorization agreement described in [Nacha’s ACH guide](https://achdevguide.nacha.org/how-ach-works). Payment/refund-to-settlement allocation and durable cutoff/reservation fields remain to be finalized; date-only reconstruction is insufficient.

All transaction ownership and spender references remain immutable after posting, even when tags are reassigned or devices revoked. Restrict deletion of referenced accounts, wallets, bank accounts, physical tags, passes, fundings and transactions; archive/disable access rather than cascade-delete financial history. Composite ownership foreign keys apply to both operation endpoints and funding/payout bank selection.

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

One row per completed store purchase (migration 0010 as `tag_orders`, renamed and generalised by 0018). Created only on success; a declined attempt is a failed purchase transaction with no order. `type` says what was bought: `tag` (a band or card, `model_id`) or `shop` (merchandise, `shop_id`).

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
| delivery | `ship` (default: shipping address required) or `download` (digital shop item; shipping NULL, type `shop` only). Added by migration 0022 at the end of the table. |

## shop

Our own merchandise for sale (migration 0018): id, name, description, photo (the R2 key of the PNG, `shop/<id>-<epoch ms>.png`; the API renders the full URL), price (cents), currency, stock (NULL = not tracked), sold, status (pending, available or closed), created_at, updated_at, and (migration 0022, at the end of the table) kind (`physical` default, or `digital`: no stock, quantity 1 per order, needs a file before it can be available) and file (the key of the downloadable file in the private bucket `nuclear-uploads`, `downloads/<item id>-<epoch ms>.<ext>`; digital only). Items are bought with `POST /v1/shop/orders {item_id, ...}`, which creates an `orders` row of type `shop` and raises `sold` (and lowers `stock` when tracked). Managed in the admin portal's Shop page (Admin and Sales).

## logs

The audit trail (migration 0018), append-only (triggers refuse update, delete and truncate): id, actor_type (admin, operator, customer, agent or system), actor_id, actor_label (an admin's Access ID or a customer's email), action (for example `tag_model.created`, `admin.created`, `refund.approved`, `user.suspended`, `customer.login`), target_type, target_id, target_label, details (small JSON, never secrets), ip and created_at. Written for every admin action and for customer security events (sign-up, login and failed login, logout, handle change, device revoke, agent key rotate and revoke). Shown on the admin portal's Logs page (Admin) and as the Activity tab of a user or merchant. A log failure never blocks the action it describes.

## uploads

One row per file a person or business uploaded (migration 0020): id, account_id (the uploader), type (`business_document` today), path (the object key inside the private R2 bucket `nuclear-uploads`: `<account id>/<upload id>.<pdf|png|jpg>`) and created_at. The bucket is never public: admins (Admin and Merchants roles) download business documents through `GET /v1/admin/merchants/:id/documents/:uploadId`, and every download is logged. PDF, PNG or JPEG only (content type and first bytes checked), 5 MB at most, 10 documents per business. The old `businesses.business_doc` column was dropped.

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

One row per settlement run, i.e. per daily cutoff (migration 0025; the settlement job that writes it is not built yet). The run is created first, which claims its `cutoff_date`, then writes one `settle` transaction per merchant with a non-zero net, then closes.

| Field | Description |
| --- | --- |
| id | Primary key. |
| cutoff_date | The program date (America/New_York) being settled. Unique: one run per date, so a rerun or a second cron cannot settle the same day twice. |
| cutoff_at | The exact instant the merchants' nets were computed at; immutable once set. |
| status | running (default), submitted (sent to the bank), completed or failed. Completed requires completed_at. |
| merchants | Number of merchants with a settle transaction in this run. |
| payout_total, collection_total | Cents paid out to merchants' banks and collected from them (both non-negative). |
| provider_reference | Bank or ACH batch identifier. |
| failure_code | Why a failed run failed. |
| created_at, completed_at, updated_at | Timestamps. |

Per-merchant history stays in `transactions` (type `settle`, `settlement_id` pointing here, idempotency key `settle:<cutoff date>` per merchant, so a merchant can never be settled twice for a date). A missed cron is caught up the way the daily reset is: the next run settles every date after the last completed `cutoff_date`.

## ledger_entries

Adopted in the schema plan: append-only monetary postings underlying the product transactions and balance summaries. This is one additional internal table, not a separate product flow.

| Field | Description |
| --- | --- |
| id | Ledger entry primary key. |
| transaction_id | Nullable foreign key to transactions.id for non-funding postings, including payment, send, settlement, refund or adjustment. |
| funding_id | Nullable foreign key to fundings.id for all funding lifecycle postings, including pending recognition, release and return, even before a successful fund transaction exists. |
| posting_key | Stable event key grouping balanced entries, e.g. payment completion, funding release, or bank return. A funding or transaction can have several events. |
| line_no | Entry number within the posting event; unique with the applicable funding_id or transaction_id and posting_key for retry safety. |
| account_id | Nullable reference to accounts.id; NULL denotes a platform/system entry. |
| wallet_id | Migration 0033, nullable. Set only on funded_balance postings that belong to a Benefits wallet's compartment (employer credit or claim into it, a payment from it, a refund back into it, a move out of it); the sum per wallet reconciles to wallets.balance (`benefits_match_ledger`). Ordinary postings leave it NULL. Logically after account_id (physically last today). |
| bucket | Accounting bucket, including customer funded balance, approved-credit receivables and defined bank/platform accounts; no customer pending-funds bucket grants spending authority. Wallet spenders share an account bucket. Buckets: funded_balance, credit_receivable, pending_funding, bank_settlement, platform_clearing and (migration 0029) employee_escrow, which holds employer-funded credits for employees who have not claimed them yet. |
| direction | debit or credit. Sign/effect follows the bucket's defined accounting classification. |
| amount | Positive bigint cents. |
| created_at | Posting timestamp. |

Exactly one of funding_id and transaction_id must be populated. Funding postings always use funding_id, including after a successful fund transaction is linked; that activity row introduces no additional posting. Enforce separate uniqueness constraints for each source and posting_key/line_no. Each posting event must balance total debits and credits in the same currency. Write entries, funding/transaction phase/status, and balance updates in one database transaction, with locks/serialization for affected funds and budgets. Correct posted history through new reversing/adjustment postings. Failed attempts have no completed-payment posting, although any earlier actual money movement must retain its own entries.

Approved payment credit is tracked separately from funded balance in the ledger and balances summary. There is no advance against pending loads. See BALANCE-POLICY.md for current availability and proposed repayment/refund/late-return allocation.

## Accounting and query implementation

Eleven tables describe the product, devices and physical inventory; ledger_entries is the twelfth internal accounting table; terminals and orbs add merchant hardware. Fundings rows track bank-load attempts, transactions record successful funding activity and other operations, ledger entries record balanced monetary effects, and balances is the atomically maintained current summary. Wallets identify spenders and limits, not separately funded pots. No database objects have been created or migrated.

Activity combines transactions with fundings that have no transaction_id, using a single ordered, paginated feed so completed loads appear once. Pending and failed loads remain visible from fundings. A completed load can show a later return by joining its linked funding record. Join only the resulting page to wallet/account display records. Live wallet photos avoid historical snapshots; snapshot behavior remains optional. Account-owner indexes and matching timestamp/id pagination should be verified with representative data before scale commitments.

## Pre-launch rebuild

The dev database (nuclear-dev) will be rebuilt from scratch into a new database before launch, so columns that were added later need not be moved with table rebuilds now. The fresh schema must create them at the logical positions this document gives, not at the physical end where the dev migrations put them:

| Table | Column | Logical position | Added by |
| --- | --- | --- | --- |
| accounts | bio | before created_at | 0023 |
| transactions | settlement_id | after related_transaction_id (end of the table today) | 0025 |
| orders | delivery | after status/transaction_id block as listed above (end of the table today) | 0022 |
| shop | kind, file | kind after status, file after kind (end of the table today) | 0022 |
| employees | status | before created_at (end of the table today) | 0031 |
| balances | ordinary_opening, opening_day, added_today | after balance_pending (end of the table today) | 0037 |
| employees | fixed_benefit | before created_at, after status (end of the table today) | 0036 |
| wallets | org_account_id | after account_id (end of the table today) | 0033 |
| ledger_entries | wallet_id | after account_id (end of the table today) | 0033 |

Also in the fresh schema: the CHECK constraints from 0021 (photo columns hold only R2 keys), `accounts.status` with pending and declined (0020), `uploads` (0020, `businesses.business_doc` never created), `logs` and `orders` (0018, no `tag_orders` or `tag_model_photos`), and `shop`/`orders` as described above. Consolidate migrations 0001-0023 into one initial migration for the new database, with the columns in document order, and keep the old files only as history.
