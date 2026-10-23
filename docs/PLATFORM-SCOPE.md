# Nuclear platform: application flows and build scope

> **Scheme v2 (October 23, 2026).** The double-entry ledger described in this document was replaced by immutable wallet-to-wallet transactions and a reconciliation policy; wherever "ledger" appears below, read "transactions and their reconciliation". The current design is [SCHEME-V2.md](SCHEME-V2.md) and the tables are [TABLES.md](TABLES.md).

Date: October 13, 2026.
Status: Build-scope draft. Confirmed product decisions are carried forward; proposed behavior and configurable policy defaults are identified below. No new bank contract, regulatory approval, subscription, or deployment is implied.

Compact table discussion consolidated October 13, 2026: [TABLES.md](TABLES.md). This uses accounts, balances, wallets, devices, businesses, bank_accounts, fundings, transactions, tags, tag_models, passes, and ledger_entries. Funding attempts and their failures live in fundings; a fund transaction is created only on confirmed successful release. Other failed operations remain in transactions; transactions.status_code and fundings.failure_code are nullable. Transaction endpoints and tag/pass references use explicit foreign keys. The logical domain records later in this scope are capabilities, not a requirement to create one table per concept.

Ledger plan adopted October 13, 2026: ledger_entries is the internal accounting table; devices, fundings and tags bring the original plan to twelve tables (TABLES.md has the current schema). tags contains physical inventory and wallet assignments; tag_models contains sale models; passes contains Apple/Google passes. Physical-tag replay counters live in tags and survive wallet reassignment. Funding postings reference fundings directly before and after release; the successful activity transaction does not post the money again. TABLES.md is authoritative for compact table/column decisions, including funded-balance-only sends and separately approved payment credit, combined sending/payment spent_today, no pending-funding spend, provider_account_id, inline business addresses and refund/adjustment operations. No SQL implementation or migration is part of this update.

This document expands FEATURE-SPEC.md around onboarding, accounts, funding, in-store payments, online payments, family setup, and merchant settlement. It is the implementation planning entry point for those journeys. ARCHITECTURE-DECISION.md remains authoritative for infrastructure; FEATURE-SPEC.md retains the broader ecosystem and Orb hardware decisions.

## 1. Product model and boundaries

Nuclear is one bank-funded purchasing wallet with multiple authorized spending paths. Customers use its funds at participating physical and online merchants. Family members can share funds with individual spending limits. Wristbands, cards, phone passes, and online sessions grant access to funds; they do not hold independent balances.

Confirmed boundaries:

- Bank funding, including ACH, unavailable for spending until confirmed successful release. Separately approved credit may fund merchant payments only. Card purchases through a separate acquiring integration do not fund the Nuclear wallet.
- Customer funds remain within the platform; no general consumer cash-out.
- Shared family funds with owner-issued device access links, managed spender wallets/minor profiles, assigned tags, and individual controls.
- Multiple NTAG 424 tags per account; base URL `https://tag.nclr.app/RANDOM_ID`. Apple pass credentials have generated UUIDs; Google passes use separately managed credentials.
- $2,000 daily-associated-value product control. Opening value plus additions is distinct from daily spending; spending does not restore loading headroom.
- P2P remains in ecosystem scope, independently deferrable. Its transferred value keeps platform-only spending restrictions. It is not required to complete these seven initial journeys.
- Cloudflare Workers → Hyperdrive → PlanetScale PostgreSQL. Orb communicates through POS over BLE, without internet access. No periodic polling, persistent WebSockets, or Durable Objects.

Planning assumptions for the first implementation: US program and USD; single owner for each shared wallet; delegated devices authorize specific spender wallets rather than co-ownership; online one-time immediate payments; merchant payouts to an approved bank account. These are proposed defaults, not final legal/program terms.

Do not add full inventory, kitchen displays, payroll, agent checkout, multi-currency, recurring merchant billing, or external card acquiring to the critical path for this release. Those remain separately scoped ecosystem modules.

## 2. Application surfaces and navigation

| Surface | Main navigation | Role |
| --- | --- | --- |
| Customer app / responsive customer web | Home, Activity, Pay, Family, Account | Customer wallet, funding, credentials, delegated spending |
| Merchant POS | Checkout, Transactions, Orb, Staff session | Start purchases, receive result, issue permitted refunds |
| Merchant dashboard | Overview, Transactions, Payouts, Locations, Team, Integrations, Settings | Merchant setup, reporting, payout and access management |
| Nuclear hosted checkout | Merchant/order summary, wallet choice, confirmation, receipt | Authorize an online purchase |
| Internal operations | Users/wallets, Merchants, Funding, Payments, Payouts, Exceptions, Audit | Investigate and resolve financial/operational exceptions |

Confirmed account model: consumers and merchants share the **`accounts`** table. `accounts.type = 'C'` identifies a consumer account; `accounts.type = 'B'` identifies a business/merchant account. This replaces separate top-level User and Merchant entity tables in this draft. Consumer and merchant screens are different views of this shared account model.

A person signs in through authentication linked to their account/access grants. They may have access to personal, family, or business contexts. Business owners/staff are authorized through explicit account relationships/roles, rather than through shared business login credentials. Exact authentication mapping remains to be specified. Every financial screen clearly shows the active wallet/business. Selecting a family context does not move money. A business account's merchant payable/payout funds remain separate from consumer purchasing funds.

## 3. Onboarding

### Customer journey

Entry points: app/web signup; participating merchant enrollment link; unclaimed physical tag URL; owner-issued wallet magic link; online checkout.

1. Explain the offer: load from a bank, pay participating merchants, manage tags and family. Clearly disclose platform-only spending and no cash-out before loading money.
2. Create/sign into an account. Proposed primary entry: verified email using a short-lived code/link; add passkey/device authentication where supported. Final auth provider is open.
3. Collect profile and age/eligibility information needed for the program. Minor creation is routed through a guardian/owner flow. Do not assume universal SSN/selfie collection; collect additional information where the approved program or risk policy requires it.
4. Accept current wallet terms and privacy notices, recording versions and timestamp. Funding authorizations are separate from general terms.
5. Create a personal wallet for account signup. A shared-wallet magic link follows its separate device-redemption flow and does not require recipient account signup or bank linking.
6. Offer bank linking and first funding, with a visible Skip option where the role permits an unfunded account.
7. Offer tag activation and Apple/Google pass setup. Optional steps must not create hidden payment credentials or claim another member's tag.
8. Show Home with available spend, remaining setup steps, and current restrictions.

Onboarding is resumable. Never create duplicate wallets after app restart, a repeated verification link, or an online-checkout return. Verified login, bank validation, risk eligibility, and wallet activation are separate statuses.

Suggested screens: Welcome; Sign in/Verify; Profile; Terms; Join family/Create wallet; Link bank; First load; Add credential; Ready/Home.

### Merchant journey

1. Sign in and create a business application.
2. Provide legal/trading identity, business contacts, locations/site, ownership details as required, merchant category, and program acceptance.
3. Supply and verify the payout bank account through the approved provider. Require stronger confirmation for later changes.
4. Complete required business/program review. Show setup, under review, additional information needed, active, or restricted; accepting payments requires approval.
5. Create locations and terminal records; invite staff with explicit roles.
6. Pair/authorize Orb to the correct terminal and perform a test-mode checkout.
7. For online acceptance, configure credentials, verified return URLs, signed event delivery, and perform a test checkout.

Test transactions must be unmistakably separate from real money and reports. A staff invite cannot create owner/finance permissions unless granted explicitly.

## 4. Account and wallet experience

### Home

The headline is **Available to spend**, with separate funded balance and approved payment credit. Pending bank loads are shown as activity/status and never increase availability. Sends use funded balance only; approved credit may fund merchant payments. Display reservations and funding headroom where relevant. Do not present borrowed credit as customer-owned funds.

Home actions: Add money; manage auto reload; add/manage tap credentials; family; activity. Show low balance, failed funding, verification required, and restricted account states with a specific next action.

### Account screens

Profile/contact details; security/passkeys/sessions; linked banks and authorizations; wallet limits; notification preferences; family access; credentials; optional membership; receipts/statements/export; support and closure request.

Credential management: name, type, assigned member, active/paused/revoked/replaced state, and attributable activity. Pausing blocks new payment authorization immediately in the backend. Removing a phone pass does not cancel completed purchases. Replacement does not erase history or reset limits.

Activity combines funding, purchases, refunds, and optional transfers with filters. Distinguish customer-visible load/payment status from merchant settlement. Do not expose other wallets or unrestricted family-wide details without the appropriate role.

A closure request pauses new activity and starts an operations workflow for residual funds, pending loads, refunds, and legal retention. Do not promise general bank withdrawal or delete the ledger when deleting profile access.

## 5. Funding

### Manual ACH load

1. Select an approved linked bank; link/validate a new account if needed.
2. Enter amount. Show both wallet capacity and today's remaining loading headroom.
3. Display source, amount, debit authorization, timing estimate, and explain that the load becomes available only after confirmed release. A load submission is not a guarantee of clearing.
4. Confirm. Backend rechecks authority, bank status, limits, risk eligibility, and aggregate headroom, then reserves headroom atomically and creates one idempotent load.
5. Submit through the funding integration; show pending/submitted outcome or an explicit unknown-submission condition.
6. Update from authenticated provider events and verified reconciliation. Record bank transfer status separately from the decision to release funds for spending.
7. On confirmed release, credit funded value once, applying any finalized approved-credit repayment allocation, and create the successful fund transaction. Pending loads granted no spendable value.

Users see: requested/submitting; pending; usable/released; failed; returned; review required. Internally, bank settlement and availability are separate fields so an available load can later return.

Nacha requires account-number validation before first use or a change for WEB debits; this is distinct from all possible identity/ownership checks. [Nacha validation guidance](https://www.nacha.org/rules/supplementing-fraud-detection-standards-web-debits).

### Available funds, approved credit and limits

balances contains account_id, balance, balance_pending, credit_limit, credit_spent and updated_at. Fundings tracks pending loads; balance_pending is an informational awaiting-clearance summary, with no advance against ACH. Sends use balance only; merchant payments may use balance then approved account-wide credit. credit_spent is outstanding principal and does not reset daily.

Check/reserve balance, available approved credit and wallet budgets together to prevent concurrent overspending. Daily associated-value controls remain required; their former summary columns are removed, so ledger/funding queries and transactional headroom reservations must supply them. Balance/tier caps remain configurable until finalized.

The prior aggregate early-spend policy is withdrawn. See BALANCE-POLICY.md for proposed credit repayment/refund/return accounting. Bank-return exposure still needs recovery handling even after successful release; the pending-load balance policy is removed, not fundings lifecycle/reconciliation.

### Automatic reload

Owner explicitly enables it, choosing bank, threshold, amount, and any maximum frequency/value limits. Capture recurring debit consent separately. Show projected behavior before enabling; support pause, edits, and authorization revocation.

Draft behavior: trigger from the owner's agreed wallet measure, keep one automatic load outstanding, use a stable trigger/job identifier, and apply the same caps and risk checks as manual funding. Do not auto-submit an undisclosed reduced amount when the configured reload exceeds headroom; explain the blocked reload. Repeated threshold events must not create multiple loads. Resolve an unknown submission before retrying with a new operation.

Instant bank funding/RfP may be added if partner capabilities are contracted; do not model an approved request as received money or assume standing-authorized automatic RfP.

## 6. In-store payment

### Checkout journey

1. Staff enters/receives the order amount and reference. POS shows merchant/location, final currency/total, and **Ready for tap**. Taxes/tips must be included before authorization in this first release.
2. POS creates a server payment intent and attempt. Amount changes invalidate the old attempt and require a new customer authorization.
3. POS sends matching intent/attempt IDs and requested action to paired Orb over BLE; Orb presents tap animation.
4. Customer taps an active NTAG card/wristband or approved phone pass. Orb captures the credential protocol data, presents busy animation, and relays it to POS.
5. POS sends an authenticated HTTPS payment request. Backend validates terminal/merchant, credential proof, freshness/replay policy, member authority, account state, operation eligibility, available funds, and all applicable budgets.
6. Backend atomically records authorization/financial effect, debits the wallet, credits merchant payable, commits budget usage, and records durable receipt/event work. Reservations are used where processing needs them; this is one internal payment, not an external ACH per purchase.
7. API returns committed success or confirmed failure. POS sends the matching result to Orb. Success animation/chime cannot be sent on a timeout or merely on tag detection.
8. POS and customer activity show the receipt. Show merchant amount and member attribution without exposing private wallet balances to staff.

Proposed tap consent: tapping during a clearly displayed purchase is a pre-authorized credential action within owner/member rules. It must be reflected in program terms and validated protocol design. A public URL/UUID alone is not authorization; a valid cryptographic read is not permission for arbitrary amounts. Do not silently require the customer's app for every physical-tag purchase; explicit step-up thresholds, if needed, remain a policy decision.

### Exceptions and recovery

| Condition | Customer/staff behavior | Financial rule |
| --- | --- | --- |
| Insufficient funds or member limit | Clear decline; owner may fund/change limits, then retry | No purchase posting |
| Paused/lost/unassigned tag | Explain credential cannot be used | No unauthorized debit |
| BLE disconnect before result | POS retains original attempt and shows connection issue | Recover original outcome; no new charge |
| API response lost | Show “Checking payment result” / outcome unknown | Explicit status lookup/reconnection recovery using original IDs |
| Duplicate tap/request | Return original result for the same operation | At most one debit |
| New amount/new customer | Cancel/resolve prior attempt and start distinct authorization | Stale proof/results cannot carry forward |
| Offline POS | Unable to complete payment; recover when connected | No offline debit or success promise |

Recovery is triggered by user action, app resume/reconnection, or a completed request/event, never a periodic polling loop. Local cached status is not authoritative. New customer retry follows confirmed failure, not an unknown outcome.

### Refunds

Authorized staff selects original transaction, amount and reason. Support full/partial refunds bounded by the unrefunded amount, with atomic/idempotent posting. Refund to the original wallet as immediately available funded-balance/payment-credit restoration under refund allocation rules, with related_transaction_id referencing the original payment. Debit the business balance even if it becomes negative. Daily negative merchant net is collected by authorized ACH debit; customer refunds do not wait for bank collection. Refund spending-budget restoration remains separate. Daily-value treatment finalized 2026-10-20: approved refunds are never limited by and never counted toward the ordinary $2,000 cap (they may exceed it); spending gives no same-day replenishment. New ordinary loads, personal receipts and Benefits moves must fit remaining headroom. See the refund exception in ORGANIZATIONS.md and BALANCE-POLICY.md. External bank refunds are outside ordinary consumer cash-out and require separate defined handling.

## 7. Online payment

First-release integration proposal: a **Pay with Nuclear** button redirects to Nuclear-hosted checkout. Merchants create sessions through a server API; no secret merchant credentials reside in the browser. Platform plugins can follow the common API after one reference integration works.

1. Merchant server creates a session with order reference, item/total summary, currency, expiration, allowed return URLs and idempotency key.
2. Customer opens hosted checkout showing the verified participating merchant and exact total.
3. Customer signs in if needed, selects an authorized wallet/family context, and sees eligible available funds. New users can complete resumable onboarding/funding and return to the still-valid checkout.
4. Customer explicitly confirms the purchase. The signed-in user must have authority for that wallet; no physical tag URL or phone-pass UUID is accepted as online authentication.
5. Backend applies the same wallet, funding, and member policies as store checkout. Initial release uses immediate one-time payment; delayed capture, subscriptions, and incremental authorization are separate extensions.
6. Commit wallet debit, merchant payable credit, order-linked payment and receipt atomically. If the order amount changes, require renewed confirmation.
7. Show success and return to the merchant. Deliver a signed, retryable server event through the transactional outbox. Merchant verifies the event or makes an authenticated payment lookup before fulfillment. Browser redirects alone are not proof of payment.

A closed browser must not undo payment or lose merchant notification. Retries/out-of-order events cannot duplicate fulfillment. Session expiration and payment commit are serialized so an expired session cannot start an unauthorized new debit, while a previously committed payment remains valid.

Insufficient funds: offer Add money or choose another authorized wallet; never silently load the bank. Pending funding is unavailable. Approved credit, if present, follows payment eligibility rules and cannot fund P2P.

Merchant integration screens: test/live environment, scoped keys, key rotation/revocation, return URL allowlist, webhook endpoint/signing settings, delivery history, resend action, and linked transaction lookup. Payment status recovery uses explicit requests and server events, without periodic client polling.

## 8. Family setup and operation

### Owner setup

1. Open Family, choose the owner wallet, and explain that all members share its funds.
2. Add a managed spender wallet for an adult or minor; optionally issue a five-minute magic link for device access.
3. Define member spending authority: per-purchase maximum and configurable recurring budget; optional merchant/category restrictions if supported by reliable merchant data.
4. Assign an existing tag or activate a new one for the member. Phone pass provisioning must stay within the target wallet authority; owner and delegated provisioning permissions remain to finalize. Minor digital-pass access is a separate platform/age decision.
5. Show member state, used/reserved/remaining budget and credentials. Owner can pause spending, change limits, revoke device access, issue/revoke magic links, and inspect attributable transactions.

### Shared-wallet device access

Only the primary holder requests a link for the target wallets.id. API returns a signed JWT with a five-minute redemption TTL in https://app.nuclear.us/magic-link/<token>. Recipient redeems it on the target device into a wallet-scoped session, without account credentials or member_account_id. Single-use redemption and revocation use the combined devices row; no separate sessions table. The link is a bearer credential; intended-recipient/device identity is not guaranteed by the URL alone. Sessions last 90 days and app calls POST /v1/devices/session/extend on every launch to renew still-valid access for another 90 days. Optional intended-device pairing remains to finalize. See WALLET-ACCESS-POLICY.md.

Recipients are spenders, not owners or admins. Current wallet allow_pay/allow_send and limits apply; funding, issuing links and editing budgets remain primary-holder actions. Recipient access never automatically combines another account's funds with this wallet.

### Minor profile

Created/managed by an eligible owner/guardian. Store required profile information and consent with suitable privacy controls; do not force an email/login for tag-only use. Minor spend is attributed to the profile even though the shared wallet funds it. Age progression, guardian changes, and independent accounts are defined migration workflows, not automatic transfers.

### Budget behavior

All credentials for a member share their budget. Funds, budget reservations and approved credit usage are checked atomically across physical and online purchases. A budget is permission to spend, not a separately funded balance; allocating $50 does not move $50.

Changing a limit does not erase current-period usage. A change below already spent/reserved value blocks further authorization rather than reversing purchases. Lowering limits/revocation does not retroactively cancel committed payments; reservation policy handles already accepted operations explicitly.

Define period reset timezone, refund restoration, visibility for adult members, and removed-member privacy/history. Defaults for this draft: owner sees shared-wallet activity; spender sees their own activity and remaining allowance, not other members' private history. No minor P2P in the initial flows unless separately approved.

Shared-wallet device access: no wallets.member_account_id. Only the primary holder issues a wallets.id JWT link with a five-minute redemption TTL; recipient gets wallet-scoped device access. Single-use redemption, current permission checks and revocable sessions follow [WALLET-ACCESS-POLICY.md](WALLET-ACCESS-POLICY.md). Recipient account login does not grant access to the shared wallet. Earlier adult account-invitation wording is superseded for this flow.

## 9. Merchant payable, settlement and bank payout

Customer checkout completion and merchant bank payout are separate operations. A completed Nuclear purchase creates a ledger obligation to the merchant immediately; external transfer follows the payout policy.

### Merchant screen

Show earned/unpaid balance, held/reserved amount with reason, eligible payout amount, next payout estimate, payout bank, and payout history. Payout details include covered period, opening unpaid balance, gross purchases, refunds, contracted fees/adjustments, reserves, net payout, bank reference, and included transactions. Fees are displayed only if actually contracted; preserve the 0% Nuclear merchant-processing business target without inventing a signed pricing contract.

### Daily payout proposal

1. Approved scheduled job closes a payout period using a defined timezone/cutoff and stable batch ID.
2. Select eligible merchant payable entries, subtract accounted refunds/fees/holds and avoid entries already allocated to another payout.
3. Reserve payout funds atomically and create an immutable payout breakdown.
4. Verify active destination account, program eligibility, available payout liquidity, and restrictions; submit to bank using a stable provider operation identifier.
5. Handle provider response, authenticated events, and reconciliation. Move through queued, submitted, settled, failed, returned, or review required; missing response is an ambiguous outcome, not automatic failure.
6. Update merchant history and audit records. On confirmed failure, safely release eligible reserved funds or requeue under tracked policy; a return restores the appropriate payable obligation and records bank movement separately.

Confirmed: full net daily settlement, without partial settlement. Positive net pays out; negative net is collected from the authorized merchant bank, and zero triggers no movement. Submission does not establish collection or zero the debt. Failed/returned collections preserve customer refunds. The operation must preserve a cutoff snapshot and avoid allocating its balance twice. One automatic aggregated settlement per merchant per payout period, with next-business-day ACH as a planning baseline. Actual rail, eligibility, cutoff, weekends/holidays, arrival estimates and minimum thresholds depend on the bank agreement. A midnight job does not establish same-day ACH settlement. [Federal Reserve ACH processing schedule](https://www.frbservices.org/resources/resource-centers/same-day-ach-resource-center/fedach-processing-schedule/).

### Early-ACH purchases and payout liquidity

If Nuclear authorizes a merchant purchase using its early-spend allowance, the draft business policy is that Nuclear supplies the liquidity/funding risk and does not reverse that merchant purchase solely because the payer's ACH later fails. This policy needs bank/program agreement and funded reserves. Merchant fraud, disputes, refunds, and explicit contractual adjustments are separate workflows. A settlement hold must be explained, never hidden as successful external payment.

Do not promise payouts backed by funds not yet received without a working-capital/reserve plan. Reconcile bank balances and movements against customer funds, merchant payables, payout reservations, returns, and platform exposure. Internal balances do not substitute for bank liquidity.

Bank-account changes require owner/finance authority, stronger verification, notifications and any required hold. A batch snapshots its destination; changes cannot silently reroute already submitted payouts.

Cross River remains the previously discussed banking candidate. Its documented FBO/subledger model is relevant, but actual ownership, account setup, control and terms must be contracted; Nuclear's ledger remains the application authority. [Cross River FBO documentation](https://docs.crossriver.com/concepts/accounts/fbo-accounts).

## 10. Permissions and domain records

| Role | Default permitted actions |
| --- | --- |
| Wallet owner | Fund, authorize own payments, manage members/budgets/credentials, see shared activity |
| Adult member | Authorized own payments, manage own permitted credentials, see own activity/budget |
| Managed minor | Assigned-credential purchases within guardian rules |
| Merchant cashier | Checkout and transaction lookup within assigned location; refunds only if separately allowed |
| Merchant manager | Location/team oversight and permitted refunds/reporting |
| Merchant owner/finance | Business settings, payout accounts, settlements, exports and controlled access changes |
| Operations/support | Scoped investigation and audited actions; financial corrections require dedicated permission/workflow |

Minimum domain records: Account (`accounts`, type `C` or `B`); Session; AccountAccess/BusinessRole; Wallet; WalletMembership; Invitation; MinorProfile; Credential; BankLink; FundingAuthorization; FundingLoad; AutoReloadRule; RiskEligibility; LimitPolicy; DailyValueCounter; BudgetPeriod; Reservation; business-specific profile/settings linked to a type-B account; Location; Terminal; OrbDevice; OnlineCheckoutSession; PaymentIntent; PaymentAttempt; Refund; LedgerJournal/Entries; Payout/Allocations; ProviderEvent; OutboxEvent/Delivery; ReconciliationException; AuditEvent. Supporting record names are logical concepts, not finalized SQL table names.

Reference consumer wallet ownership and merchant payment/payout ownership through `accounts.id`, validating the required account type. Account type does not replace authentication, role checks, wallet membership, or separate ledger classifications. A consumer managing a business is linked to a B account; no third account type or dual type is implied. Whether managed minors are C accounts or dependent profiles remains an explicit schema decision.

Use integer USD cents and server authoritative time. Retain member/merchant/credential attribution snapshots where needed for historical accuracy. Financial records are append/audit-based; corrections use linked reversing/adjustment operations rather than rewriting completed history. Scope idempotency to the actor/merchant/wallet operation and reject reuse with mismatched parameters.

## 11. Backend work packages

| Package | Deliverable | Completion evidence |
| --- | --- | --- |
| Identity and permissions | Resumable signup/login, wallet contexts, role enforcement | Cross-wallet/merchant access blocked; recovery does not grant wrong membership |
| Ledger and policy core | Journals, balances, reservations, budgets, daily caps, idempotency | Concurrent operations preserve funds/limits; duplicate requests cannot post twice |
| Funding | Bank adapter, authorizations, manual/auto loads, availability/returns | Partially spent load releases once; failed/unknown submission recovers safely |
| Credentials | Claim/assignment/revocation, physical proof and digital-pass records | URL/UUID alone cannot debit; revocation applies across channels |
| Store checkout | POS intent/attempt API, BLE contract, result/receipt/recovery | Tap → committed payment → matching Orb result; stale result rejected |
| Online checkout | Hosted flow, session API, signed event delivery and lookup | Closed browser/duplicated events cannot lose or duplicate a completed purchase |
| Family | Owner-issued device links, minors, controls and attribution | Concurrent members cannot overspend shared funds or reset allowances |
| Merchant operations | Onboarding/team/location, refunds, reports | Authorized business context and linked adjustments |
| Payout/reconciliation | Eligibility, aggregation, bank submission, returns/exceptions | No entry paid twice; ambiguous payout cannot trigger duplicate bank transfer |
| Release operations | Audits, alerts, retention, backup restore, support tooling | Restore test and traced money movement through bank reconciliation |

Jobs/webhooks use transactional outbox and duplicate/out-of-order-safe consumers. Queue/scheduler provider and delivery retry policy remain implementation decisions within accepted architecture. Mobile push/email are supporting notifications, not sources of financial truth. Financial and authorization reads are not cached through Hyperdrive query caching.

## 12. Build sequence and sign-off decisions

Build in reviewable slices:

1. Sandbox identity + wallet + ledger + simulated funding → one customer pays one merchant and sees a receipt.
2. Real funding adapter in sandbox, exposure/caps, refunds and payout/reconciliation simulation.
3. Merchant POS + Orb simulator/physical tag path + interruption recovery.
4. Shared family wallet, invitations, minor tags, cross-channel budget enforcement.
5. Hosted online checkout and one reference merchant integration.
6. Bank sandbox payouts/returns and operations dashboard; approved digital-pass paths alongside platform/reader certification.
7. Measured reliability/security/recovery gates, partner/program sign-off, then controlled live pilot.

Policy decisions that must be explicit before live financial behavior:

| Decision | Existing position / proposed handling |
| --- | --- |
| Launch jurisdiction/currency/account structure | US/USD planning default; partner/program approval needed |
| Auth provider and account recovery | Verified email + optional passkeys proposal; provider open |
| Balance/membership caps | $1,000 prior explicit cap; later tier proposal unresolved; configurable |
| Approved payment credit | Independent of pending ACH; approval/terms and repayment attribution remain to finalize |
| Auto-reload measure/trigger/amount | Consent + one outstanding auto load; exact defaults open |
| Program day and member budget periods | Defined server timezones; exact choice open |
| Tap consent/step-up and proof protocol | Pre-authorized restricted tap proposal; secure protocol and program consent approval needed |
| Refund and daily-counter treatment | Approved refunds are never capped or counted (2026-10-20); wallet spending-budget restoration remains separate |
| Settlement schedule, liquidity and reserves | Aggregated automatic payouts; contracted rail/cutoff/liquidity required |
| Family admin/co-ownership/minor rules | Single owner, spend-only adults, managed minors draft defaults |
| Digital-pass launch availability | Remains in scope; Apple/Google approvals and reader integration required |

Configurable policy is not permission to bypass final rules. Use explicit test settings in sandbox and refuse unconfigured live financial operations. Unresolved UI defaults need not block screen and sandbox workflow development.

Release acceptance must exercise insufficient funds, expired/revoked access, cap headroom, concurrent family payments, failed/returned ACH, duplicate taps, lost checkout responses, late provider events, invalid online return/event signatures, refund after payout, payout return, changed bank destination, and backup restoration. Define measurable latency/availability/volume/recovery targets before pilot sign-off.
