# Nuclear application feature specification

Status: Working draft for product discussion.
Date: October 11, 2026.

Application build scope added October 13, 2026: [PLATFORM-SCOPE.md](PLATFORM-SCOPE.md) expands onboarding, account, funding, in-store payment, online payment, family setup, and merchant settlement into screens, permissions, operation states, recovery rules, and build packages. Use it as the planning entry point for these flows; this document retains ecosystem scope and hardware decisions.

Current compact schema is recorded in [TABLES.md](TABLES.md): twelve tables, including devices, fundings, tags, tag_models, passes and the adopted ledger_entries plan. tags contains physical inventory and wallet assignments; tag_models contains sale models; passes contains Apple/Google passes. Physical-tag replay counters live in tags and survive wallet reassignment. Separate profile, address and subscription-plan tables remain outside the initial scope. Individual bank-load attempts live in fundings; a fund transaction is created only on confirmed successful release; pending bank loads are unavailable for both sends and payments; approved credit may fund payments only. Schema planning only; no database migration has been applied. Current funds/credit policy: [BALANCE-POLICY.md](BALANCE-POLICY.md); the prior early-spend policy is withdrawn. Owner-issued device links replace wallets.member_account_id; devices stores the session hash/expiry/revocation state, with 90-day sessions extended at each app launch: [WALLET-ACCESS-POLICY.md](WALLET-ACCESS-POLICY.md).

Scope: full Nuclear ecosystem, confirmed by Dami. Nuclear combines a bank-funded wallet, P2P transfers, physical NFC credentials, Apple/Google Wallet tap passes, a shared family wallet with individual controls, participating merchant acceptance, agent access, and internal operations.

Confirmed October 13, 2026: consumers and merchants use one `accounts` table, with `type = 'C'` for consumer accounts and `type = 'B'` for business/merchant accounts. Financial relationships reference these accounts; family membership, business access roles, credentials, and distinct consumer/merchant ledger balances are modeled separately.

Confirmed in this chat: P2P; NTAG 424 wristbands/cards using `https://tag.nclr.app/RANDOM_ID`; multiple tags per account; Apple Wallet tap passes with generated UUIDs; Google Wallet NFC integration; owner-issued five-minute wallet device links (superseding earlier adult account invitations); minor profiles with assigned tags; shared family funds with individual limits; ACH loads with limits and no spending availability before confirmed release; a $2,000 daily-value control.

Confirmed P2P boundary: users spend only within the Nuclear platform's participating merchant network and cannot cash out. P2P moves restricted purchasing value; recipient rights remain equally restricted. P2P is desired but is not a deal breaker for the core application.

Prior context recovered from “Develop closed-loop payments ledger”: bank-only wallet funding, prior early ACH availability (now withdrawn), automatic reloads, Exclusive membership, free merchant software, separate merchant-paid EMV acceptance, online acceptance, agent delegation, and payroll proposals. Prior assistant recommendations are recorded as proposals unless explicit user acceptance was found. ARCHITECTURE-DECISION.md remains authoritative for backend architecture.

## 1. Product surfaces and roles

| Surface | Primary user | Proposed responsibility |
| --- | --- | --- |
| Consumer app | Customer | Authorize payments, review activity, manage account and permissions |
| Merchant/POS app | Merchant owner and staff | Take payments, manage transactions, recover interrupted attempts |
| Merchant web dashboard | Merchant owner and finance staff | Manage locations, team access, reports, reconciliation, integrations |
| Nucleus Orb | Customer at checkout; staff setting up a terminal | Present tap, busy, and payment result feedback over BLE |
| Agent access | Authorized software agents and their owners | Execute permitted financial actions within explicit limits |
| Internal admin | Nuclear support, operations, and finance | Investigate transactions, administer access, reconcile, and resolve incidents |

Whether POS and the merchant dashboard share one application is an open decision. Agent access does not necessarily require a separate end-user app.

## 2. Accepted constraints

- Clients call the Cloudflare Workers API; Hyperdrive connects it to PlanetScale PostgreSQL.
- PostgreSQL is authoritative for payments, balances, reservations, ledger entries, permissions, and operation state.
- Orb connects over BLE to the iPad/POS, has no internet connection, and makes no backend API calls.
- The selected design includes no polling, Durable Objects, or persistent WebSocket layer.
- Orb displays success only after an explicit POS success message backed by committed internal payment completion.
- Internal completion, external settlement, and refunds remain separate states.
- Payment and attempt identifiers prevent delayed BLE results from updating a newer attempt.
- Transport retries preserve the same scoped idempotency key. A customer retry after confirmed failure creates a new linked attempt.
- Financial changes use integer monetary units, double-entry accounting, atomic ledger/balance/reservation updates, and a transactional outbox.
- Jobs and callbacks tolerate duplicates and out-of-order delivery. Banking reconciliation and tested backup restoration are required.
- Agent credentials are scoped, limited, expiring, and revocable. Terminals receive no database credentials.

## 3. Proposed first-release customer journeys

### A. Merchant takes an Orb payment

1. Authorized staff enters or receives an amount, supported currency, and order/reference information.
2. POS creates a payment intent and active attempt with a clear merchant, location, and terminal association.
3. POS sends Orb a payment request over BLE. Orb presents the tap animation.
4. On tap, Orb presents the busy animation and sends the tap/payment data to POS.
5. POS processes the request through the authenticated backend API.
6. POS receives a confirmed result and sends the matching success or failure status to Orb.
7. Staff sees the transaction outcome and can provide a receipt.

Acceptance: transport retries produce at most one financial effect; a stale response cannot change a newer attempt; the displayed result matches the committed backend result.

The customer taps an assigned NTAG 424 wristband/card or supported Apple/Google Wallet pass. Backend validation resolves the credential, authorized spender, shared wallet, available funds, and applicable limits. Whether additional customer confirmation is required remains a policy decision.

### B. Staff recovers an interrupted payment

1. If a response is lost, POS shows that the outcome is unknown and retains the original intent, attempt, and idempotency identifiers.
2. On an explicit recovery action or reconnection event, POS requests the authoritative outcome through HTTPS.
3. It displays the recovered result and relays it to Orb when connected.
4. It permits a fresh customer attempt only when the previous attempt is conclusively failed or otherwise safely resolved.

Acceptance: an unknown outcome never appears as a confirmed failure or success; recovery cannot charge twice; recovery does not rely on periodic polling.

Open: timeout thresholds, reservation expiration, customer departure, and escalation when an outcome remains unresolved.

### C. Customer reviews a payment

1. Customer signs into an account and opens transaction activity.
2. The detail view shows merchant, amount, currency, date, reference, internal result, and any applicable settlement or refund information.
3. Customer can retrieve a receipt and initiate an appropriate support request.

Acceptance: only authorized account data is visible; the app distinguishes a completed payment from subsequent settlement and refund activity.

The wallet account and its credentials are linked. Whether the customer needs an installed app, versus web onboarding and a physical credential, remains open.

### D. Merchant requests a refund

1. Authorized staff selects a completed payment and sees the refundable amount.
2. Staff enters a full or partial refund, if the selected payment rail supports it, with a reason.
3. The system records the request and exposes its actual processing outcome.
4. The refund appears as a linked financial operation in customer and merchant history.

Acceptance: repeated submissions cannot refund twice; aggregate refunds cannot exceed the permitted amount; a requested refund is not presented as completed.

Confirmed for Nuclear internal payments: refunds restore customer funded balance/payment credit immediately under refund allocation rules, merchant balance may become negative, and full daily negative net is collected by authorized merchant-bank ACH debit. related_transaction_id links each refund to its original pay. External rail support and refund window remain open; permission thresholds, approval requirements, fees, and treatment of unsettled payments.

### E. Owner authorizes an agent payment

1. Owner grants an agent explicit access to supported actions with amount, scope, and expiration limits.
2. Agent submits an authenticated request with a stable idempotency key.
3. Backend validates current credentials and permissions at execution time and atomically enforces financial limits.
4. Owner can inspect the resulting operation and revoke future access.

Acceptance: an expired or revoked credential cannot authorize a new action; concurrent requests cannot exceed applicable limits; activity identifies the agent and authorizing owner.

Open: which agent actions ship at launch, whether human approval is required for any action, and whether revocation cancels already accepted operations.

## 4. Feature inventory

The priorities below are proposed: Foundation is required by accepted architecture; Launch is a proposed first release; Later is optional expansion; Decision means scope cannot be set yet.

| ID | Area | Capability and observable behavior | Priority |
| --- | --- | --- | --- |
| ID-01 | Identity | Sign in, sign out, recover access, and view/revoke sessions | Launch |
| ID-02 | Identity | Separate customer, merchant, staff, agent, and internal permissions | Launch |
| ID-03 | Identity | Additional verification for sensitive actions; exact mechanism to be chosen | Decision |
| ID-04 | Onboarding | Collect identity/business information required by the selected integrations and expose onboarding status | Decision |
| CU-01 | Consumer | Account/profile settings and notification preferences | Launch |
| CU-02 | Consumer | Transaction list, search/filter, detail, and receipts | Launch |
| CU-03 | Consumer | NFC credential payments and clear confirmation of merchant, amount, and currency | Required; confirmation policy open |
| CU-04 | Consumer | Bank-linked ACH loads; funded balance and load status; no pending-load spending | Required |
| CU-07 | Consumer | Send and receive P2P with recipient confirmation, limits, receipts, and linked activity | Required; eligibility policy open |
| CU-08 | Consumer | Add, name, assign, pause, revoke, and replace multiple physical NFC tags | Required |
| CU-09 | Consumer | Issue and add Apple Wallet tap pass with its own UUID; manage replacement/revocation | Required; NFC platform dependency |
| CU-10 | Consumer | Issue and add Google Wallet tap pass; manage replacement/revocation | Required; NFC platform dependency |
| FA-01 | Family | Shared funds; primary holder issues wallet-scoped device magic links with five-minute redemption TTL | Required |
| FA-02 | Family | Add minors as managed profiles and assign physical tags | Required |
| FA-03 | Family | Set individual spending limits; show used/remaining allowance; pause spending | Required |
| FA-04 | Family | Attribute activity to the actual member and credential | Required |
| FU-01 | Funding | Link/validate bank account and record ACH debit authorization | Required |
| FU-02 | Funding | Manual load with balance-cap and daily-value checks; unavailable until confirmed release | Required |
| FU-03 | Funding | Automatic reload with consent, trigger, amount, and duplicate suppression | Prior-discussion scope; launch timing open |
| FU-04 | Funding | Track pending availability, release, failures, returns, exposure, and reconciliation per load | Required |
| SU-01 | Membership | Free/Exclusive entitlements, billing, cancellation, and spend-down above downgraded cap | Prior proposal; commercial policy open |
| CU-05 | Consumer | Manage agent grants and inspect agent activity | Decision |
| CU-06 | Consumer | Support entry point attached to a transaction | Launch |
| ME-01 | Merchant | Merchant account, locations, terminals, and staff setup | Launch |
| ME-02 | Merchant | Enter an amount or accept a payment request from integrated merchant software | Launch |
| ME-03 | Merchant | Start, cancel where safe, retry, and recover a payment attempt | Launch |
| ME-04 | Merchant | Transaction list, search, details, receipts, and refund status | Launch |
| ME-05 | Merchant | Role-based access for taking payments, refunds, reports, and settings | Launch |
| ME-06 | Merchant | Settlement/payout visibility and reconciliation exports appropriate to the rail | Decision |
| ME-07 | Merchant | Reporting by time, location, terminal, and staff | Launch |
| ME-08 | Merchant | Existing POS integration with order/reference preservation | Decision |
| ME-09 | Merchant | Catalog, cart, inventory, tax calculation, tips, discounts, and order management | Later |
| OR-01 | Orb | Pair and authorize Orb to a terminal; show connection and readiness status in POS | Launch |
| OR-02 | Orb | Tap → busy → success/failure animation cycle | Foundation |
| OR-03 | Orb | Correlate commands/results with payment and attempt IDs | Foundation |
| OR-04 | Orb | Handle disconnect, reconnect, duplicate commands, and delayed results safely | Launch |
| OR-05 | Orb | Diagnostics, device replacement, and unlink/relink controls | Launch |
| OR-06 | Orb | Firmware management and compatibility checks | Decision |
| AG-01 | Agents | Scoped, limited, expiring, revocable credentials | Foundation |
| AG-02 | Agents | Permission grants, grant inspection, and revocation interface | Decision |
| AG-03 | Agents | Atomic spending-limit enforcement and attributable operation history | Launch if agent execution ships |
| AG-04 | Agents | Approval workflows and integration SDK/tooling | Later |
| FI-01 | Financial core | Payment intents, attempts, reservations, and explicit financial operation state | Foundation |
| FI-02 | Financial core | Double-entry ledger, integer money, and atomic financial changes | Foundation |
| FI-03 | Financial core | Scoped idempotency across API and transport retries | Foundation |
| FI-04 | Financial core | Outbox delivery and duplicate/out-of-order-safe callbacks and jobs | Foundation |
| FI-05 | Financial core | External banking reconciliation and tracked exception resolution | Foundation |
| FI-06 | Financial core | Refund processing and linked history | Launch, subject to rail support |
| FI-07 | Financial core | Chargebacks, disputes, fees, reversals, and payout processing | Decision |
| OP-01 | Internal admin | Permission-controlled lookup of users, merchants, devices, payments, and attempts | Launch |
| OP-02 | Internal admin | Readable operation timeline with requests, results, and recovery context | Launch |
| OP-03 | Internal admin | Reconciliation exceptions with ownership, notes, and resolution status | Launch |
| OP-04 | Internal admin | Audited access changes and authorized corrective workflows | Launch |
| OP-05 | Internal admin | Operational visibility into failures, delays, delivery backlog, and device connectivity | Launch |
| PL-01 | Platform | Tenant isolation and authorization on every relevant API operation | Launch |
| PL-02 | Platform | Secret handling, security/audit events, and sensitive-data redaction | Launch |
| PL-03 | Platform | Accessible UI, understandable errors, and explicit loading/recovery states | Launch |
| PL-04 | Platform | Retention, backup restoration, and incident recovery procedures | Foundation; targets undecided |
| PL-05 | Platform | Localization, additional currencies, and geographic expansion | Later |

Catalog and inventory are still launch-scope decisions. A wallet is now explicit product scope; the bank account, custody, and legal program structure remain to be finalized.

## 5. Shared payment behavior

All payment surfaces must distinguish these concepts:

| Concept | Meaning |
| --- | --- |
| Intent | The purchase/payment being requested |
| Attempt | One customer attempt to fulfill the intent |
| Transport retry | Re-delivery of the same request using the same backend idempotency key |
| Pending | Processing has not conclusively completed |
| Unknown outcome | The client lacks an authoritative result; it is a presentation/recovery condition, not proof of financial failure |
| Internal completion | The internal financial operation has committed |
| External settlement | The applicable external movement of funds has settled |
| Refund | A separate, linked operation with its own outcome |

The formal state machine and API/BLE message contracts remain to be specified. Cancellation, timeout, and disconnection must not be assumed to undo a committed financial operation.

## 6. Release acceptance gates

- Demonstrate one complete checkout from POS to Orb to committed financial result and receipt.
- Demonstrate no second financial effect after duplicate API requests, duplicated BLE messages, and lost response recovery.
- Demonstrate that delayed results cannot change a newer attempt and that an unknown outcome blocks unsafe retry.
- Demonstrate safe behavior for backend unavailability, BLE disconnect, app restart, session expiration, and terminal replacement.
- Demonstrate customer/merchant isolation and staff permission boundaries.
- Demonstrate ledger consistency, reservation consistency, and reconciliation against the selected integration.
- Demonstrate duplicate and out-of-order callback/job handling.
- Demonstrate backup restoration with measured recovery results.
- If refunds ship, demonstrate refund limits, permission checks, and duplicate submission safety.
- If agent execution ships, demonstrate expiration, revocation, scope, and concurrent spending-limit enforcement.

Performance, availability, recovery, and accessibility targets need explicit acceptance thresholds before implementation sign-off.

## 7. Decisions needed to finalize the spec

1. Launch sequencing and target customer segment within the confirmed full ecosystem.
2. Bank program/account structure, geography, currency, and onboarding requirements.
3. NFC authorization protocol, platform approvals, reader compatibility, and customer confirmation policy.
4. Final balance caps, approved payment credit eligibility/terms, program-day timezone, and P2P eligibility/limit treatment.
5. Merchant scope: payment terminal versus full POS; required existing POS integrations.
6. Agent scope: launch actions, grant owner, spending-limit model, and approvals.
7. Money operations: refunds, reversals, fees, payouts, and disputes applicable to the selected rail.
8. Experience: receipts, notifications, customer support, and merchant reporting requirements.
9. Operations: authentication provider, device provisioning/pairing, retention, recovery, throughput, and availability targets.

Once these are decided, each launch feature should receive a concrete screen/API flow, permissions, data requirements, failure behavior, dependencies, and measurable acceptance criteria. This draft does not authorize provisioning, deployment, subscriptions, or charges.

## 8. Wallet and ACH funding specification

### Funding and balances

- Confirmed balances fields: account_id, balance, balance_pending (default 0), credit_limit (default 0), credit_spent (default 0), updated_at. balance_pending is an unavailable awaiting-clearance summary. No open/early-spend or daily-value summary columns remain on balances.
- Bank loads remain in fundings until confirmed successful release. A pending load contributes no spending/sending availability and grants no credit. Card purchases through merchant acquiring do not fund the wallet.
- Sends use funded balance only. Merchant payments use balance first, then available separately approved credit. Before reservations, send availability = max(balance, 0); pay availability = max(balance, 0) + max(credit_limit - credit_spent, 0), subject to account eligibility and wallet/tag controls.
- Show funded balance and available payment credit separately; do not imply credit is customer-owned money or available for P2P. Pending load status appears in activity; balance_pending can be displayed separately and never contributes to availability.
- All wallets, tags, passes and devices share account-level funds and credit; an additional credential never creates another allowance. credit_spent tracks outstanding principal rather than daily spend.
- Funding release, reservations, daily headroom, and payment allocations are atomic and idempotent. Ledger remains authoritative. See BALANCE-POLICY.md for proposed credit repayment, refund attribution and later-return rules.
- Previous advance-against-ACH tiers and early-spend return policies are withdrawn. Credit approval/terms, return-deficit recovery, repayment attribution and exact provider release stage remain to finalize before launch.

### Load checks and lifecycle

1. Verify primary-holder funding authority and bank authorization.
2. Check load eligibility, balance/program-day headroom and risk limits atomically; reserve headroom against concurrent pending attempts.
3. Submit one idempotent load, recording pending/unknown/failed states in fundings. Pending funding is unavailable.
4. At confirmed successful release, post its funded value and any approved credit repayment allocation once, then create/link one successful fund transaction. Proposed priority is repayment of outstanding credit, then increased balance.
5. Failure before release creates no successful fund transaction and reverses no spending balance. Release reservations under the cap policy.
6. Later returns preserve the original successful transaction and append corrective accounting; the consumer deficit/credit reinstatement policy remains to finalize. No silent replacement bank debit.

### Daily-value control

- Product target: $2,000 maximum daily associated value, aggregated across access to the shared wallet.
- Use one defined program-day timezone and a server-side counter. Purchases do not decrease it.
- Draft conservative cap treatment: reserve headroom for accepted pending loads without granting spendable value, and count actual value once on successful release. Headroom reservation and failed-load treatment must be defined separately from available balance. Approved-refund daily-value treatment is finalized 2026-10-20 in BALANCE-POLICY.md and ORGANIZATIONS.md: refunds are never limited by and never counted toward the cap (they may take ordinary funds above it), and spending does not reopen addition headroom that day. Treatment of promotions, P2P receipts, failed loads and separate reversals must also be reflected in the implementation.
- Reserve both wallet-balance headroom and daily-value headroom for concurrent loads. Pending funding cannot bypass either cap.
- Example: $1,500 opening value, $1,000 spent, then $600 added gives $2,100 daily associated value; reject that addition even though the ending balance would be $1,100.
- This is not a universal statutory $2,000 spending limit. FinCEN's cited threshold concerns the closed-loop prepaid-program exclusion. P2P and the actual acceptance network require classification of the whole design; staying under the number alone does not establish exemption. [FinCEN rule guidance, questions 1 and 17](https://www.fincen.gov/resources/statutes-regulations/guidance/final-rule-definitions-and-other-regulations-relating).

## 9. Family specification

Confirmed model: one shared wallet with individual spend limits.

- Owner manages wallet funding, membership, invitations, member permissions, and spending controls.
- Only the primary holder requests device access links for a target wallets.id. Redeem the signed five-minute JWT once into a revocable wallet-scoped session. No wallets.member_account_id or recipient account-credential access; delegated spending does not grant owner/admin powers.
- Add a minor as a managed family profile, then assign one or more tags. Minor app access and age/guardian onboarding requirements remain policy decisions.
- Display each member's allowance, usage, remaining capacity, assigned credentials, and activity.
- Set individual limits. Proposed controls: per-purchase and recurring daily/weekly/monthly budgets, merchant restrictions, and pause/resume. Exact periods and restrictions remain product choices.
- Attribute every payment to the wallet, member, credential, merchant/recipient, and operation.
- Enforce each member's applicable limits across all their credentials, together with shared-wallet funds and global limits. Reserve budget when authorizing; release reservations on confirmed failure; commit usage on completion.
- Revoking a member immediately blocks new authorization and disables their access to shared funds. Define already-authorized operation and rejoining behavior explicitly.
- Credential reassignment must not erase prior member attribution or reset shared financial counters.
- Draft default: members can spend; funding, P2P, inviting others, and changing limits require explicit permissions. Minor P2P is unresolved, not automatically enabled.
- Define refund restoration of member budgets, recurring reset timezone, and visibility into other adults' activity. No negative usage or duplicate refund credit.

## 10. NFC credentials and digital passes

### Selected Orb NFC controller

Latest geometry, confirmed October 12, 2026: 65 mm diameter main PCB; separate 40 mm diameter antenna FPC with a 65 mm tail; antenna 12 mm below the tap surface. These supersede the 45 mm PCB / 35 mm antenna / 17 mm tap-gap proposals. Tail carries the two balanced antenna conductors to the main-board matching circuit. Turn count and connector remain subject to electrical/mechanical qualification. The previously discussed 16 mm antenna-to-main-PCB gap remains provisional until the updated assembly drawing confirms it. Measure and tune the complete antenna/tail/connector in its final routing, with PCB, battery, LEDs, and speaker installed; no range improvement is considered verified from geometry alone.

Decision recorded October 11, 2026: use **NXP PN7161** for the custom Orb NFC controller. PCB target: **PN7161B1HN**, SPI interface, HVQFN40 package, connected to the ESP32. Final ordering suffix and firmware revision must be matched to the approved Apple integration and supplier availability before procurement.

Rationale: PN7161 supports ISO/IEC 14443-A / ISO-DEP and NFC Forum Type 4 tags, matching NTAG 424 DNA's contactless interface. It adds Apple Enhanced Contactless Polling (ECP), available after formal authorization. These are documented hardware capabilities; the NTAG secure-command implementation and full Apple VAS integration still require firmware work. [NXP controller data sheet](https://www.nxp.com/docs/en/data-sheet/PN7160_PN7161.pdf), [NTAG 424 DNA data sheet](https://www.nxp.com/docs/en/data-sheet/NT4H2421Gx.pdf).

Apple pass acceptance is the intended implemented capability, not an assertion that the bare chip is a certified Apple Wallet reader. Obtain Apple authorization/ECP documentation, implement VAS and its key handling, and complete applicable reader certification via the WPC Reader Program. Validate the resulting reader with Nuclear's approved NFC pass on actual iPhone/Apple Watch devices before hardware production sign-off. [Apple reader integration requirements](https://developer.apple.com/wallet/loyalty-passes/).

This replaces the earlier PN7160/ST25R3916 alternatives for the custom Orb design. Google Wallet stays in feature scope, but PN7161 selection does not establish Smart Tap certification; that integration remains separately tracked. Orb's BLE relay architecture is unchanged.

### Physical tags

- Support NTAG 424 wristbands and cards, multiple per account, with customer-visible names and member assignments.
- Preserve the base URL format `https://tag.nclr.app/RANDOM_ID`. RANDOM_ID is an opaque application identifier, not a name/email and not assumed to be the chip's hardware identifier.
- Claiming a tag requires an authorized account flow and proof/control appropriate to provisioning. A public URL must not let a stranger claim an already assigned tag or inspect private balances.
- Manage states: unclaimed, active, paused, revoked, replaced. Enforce backend status for every payment.
- A copied static URL is insufficient payment authorization. Require cryptographic tag verification and replay controls. NTAG 424 supports secure dynamic messages and authentication; the protocol must choose dynamic URL fields or an authenticated reader exchange. The exact URL-only appearance can be retained as a base address while proof travels in agreed fields/reader data. [NXP NTAG 424 data sheet](https://www.nxp.com/docs/en/data-sheet/NT4H2421Gx.pdf).
- Bind accepted proof to the authenticated terminal and payment attempt; distinguish re-delivery of the same attempt from reuse for a different purchase. A fresh tag read by itself does not prove customer consent to an arbitrary amount.
- Provision keys securely, track device/tag compatibility, and implement loss/replacement/revocation workflows. Keep cryptographic secrets out of URLs and customer interfaces.

### Apple Wallet

- “Add to Apple Wallet” issues a signed Nuclear tap pass with a server-generated UUID for that pass credential, linked to the member and shared wallet.
- Keep UUID, account ID, physical tag identifier, payment intent, and attempt IDs distinct. UUID is a lookup identifier, not an authorization secret.
- Support pass issuance, installation guidance, update, replacement, and backend revocation. Each issued credential remains individually identifiable and controllable.
- NFC acceptance requires Apple's special entitlement and compatible Value Added Services reader support. Apple documents an encrypted NFC payload and a maximum 64-byte message, suitable for a UUID-sized identifier; generating the UUID alone does not enable NFC. [Apple Pass.NFC](https://developer.apple.com/documentation/walletpasses/pass/nfc-data.dictionary?changes=_9_8).
- Decide authentication and pass-sharing behavior. Adding a Nuclear pass must not be presented as issuing an ordinary Apple Pay bank card.

### Google Wallet

- “Add to Google Wallet” creates a member-linked pass object and separately tracked tap credential; reuse the UUID credential model as the proposed common internal model.
- Configure Smart Tap pass classes/objects, redemption issuer settings, authentication keys, and reader acceptance. Pass installation and NFC activation are separately testable capabilities. [Google pass configuration](https://developers.google.com/wallet/smart-tap/introduction/pass-configuration), [issuer configuration](https://developers.google.com/wallet/smart-tap/introduction/issuer-configuration?hl=en).
- Support pass updates, replacement, and backend revocation. The reader obtains pass data; Nuclear still authorizes and executes the internal wallet payment.

### Shared acceptance

Orb/reader firmware must support three separately validated credential paths: NTAG 424, Apple VAS, and Google Smart Tap. Support for NTAG reads alone does not establish phone-pass support. All paths feed the same payment API and financial controls; Orb retains its BLE-only backend relay architecture.

## 11. P2P specification

- Send funds to another eligible Nuclear user/wallet, showing the resolved recipient and amount before confirmation. Recipient lookup method remains open.
- Check sender authority, available eligible funded money, shared/member spending rules, recipient eligibility, and recipient balance/daily-value headroom where policy applies.
- Draft default excludes unguaranteed pending ACH from P2P. Transfers cannot convert restricted pending funds into unrestricted recipient money.
- Commit sender debit and recipient credit atomically with an idempotent transfer operation. Record both sides and a linked receipt.
- Define whether immediate transfers are final and how mistaken-recipient support works. Cancellation must not be promised after completion.
- Family members sharing one wallet do not transfer new money to each other; budget assignment changes authority within existing funds.
- Handle blocked/closed recipients, limit failures, duplicate submissions, and ambiguous client outcomes. Never partially debit the sender when recipient credit fails.
- Decide recipient invitations/payment requests, notes, notifications, fees, P2P refund behavior, and minor eligibility before release.
- P2P remains in product scope at Dami's explicit instruction. It is optional for initial launch and must not block the core merchant-payment release if program approval takes longer.
- Confirmed P2P boundary: an internal transfer of restricted Nuclear purchasing value between eligible wallets. Recipient value retains the same participating-merchant restrictions; users cannot cash out. External-wallet transfers are outside this feature.
- Legal classification of Nuclear's actual program remains to be confirmed. FinCEN's final-rule explanation expressly retains the closed-loop exclusion despite transfers within the program; this materially supports P2P compatibility and is stronger than merely finding no prohibition. See the final-rule discussion on printed pages 19 and 29–30: [FinCEN prepaid-access final rule](https://www.fincen.gov/system/files/shared/Prepaid_Final_7-22-201.pdf).
- The remaining question is whether the actual funds flow stays within closed-loop prepaid access and applicable money-transmitter limitations. Funding source, no cash-out, merchant restrictions, bank roles, and daily-value controls must be reflected in the approved program design.
- Conservative proposed daily accounting: incoming P2P consumes recipient daily-value headroom; outgoing P2P does not replenish sender daily-value headroom. Returning value via P2P counts again on receipt. Confirm treatment of reversals and refunds separately.
- Research disposition: high confidence there is no categorical P2P disqualification for qualifying closed-loop prepaid access; moderate confidence Nuclear's specified restricted-value transfers fit. See [FinCEN P2P research](FINCEN-P2P-RESEARCH.md) for sources, counterexamples, and targeted classification questions. Keep P2P independently switchable so it can be deferred without blocking the wallet/tap-payment release.

## 12. Additional ecosystem scope recovered from prior chats

| Module | Capabilities to specify | Status |
| --- | --- | --- |
| Merchant distribution | Free merchant software, wallet enrollment/signage, merchant offers, processing-savings dashboard | Prior business direction; detailed requirements open |
| External card purchases | Separate certified contactless/chip reader and acquiring integration; merchants bear card processing charges | Prior user direction; hardware/vendor selection open |
| Online merchant acceptance | Checkout/API integration, order totals including tax/shipping, refunds, attributable agent purchases | Prior discussion; launch timing open |
| Agent spending | Owner grants with merchant/action scope, recurring/task budgets, expiry/revocation, approval thresholds; API/MCP interface | Prior product direction; exact launch actions open |
| Exclusive | Shared family/agent controls and higher wallet capacity; $9.99 discussed, $19.99 household proposal | Pricing and entitlements unresolved |
| Auto reload | Consent, trigger, amount, funding caps, one pending automatic load, pause and failure notifications | Prior proposal |
| Payroll/time tracking | NFC clock-in/out, time records and exports; partner-led payroll calculations, taxes, filings, pay stubs, payouts | Prior proposal; separate rollout and partner requirements |

Ordinary wage payment and optional wallet reload are distinct flows. Free merchant software and 0% Nuclear merchant processing are business targets; final partner contracts, subscription economics, and payroll scope remain to be specified.

## 13. Added release acceptance gates

- Two family members using different tags cannot overspend shared funds or bypass individual limits through concurrent payments.
- Adding tags, passes, agents, or reloads does not multiply daily-value or approved payment credit capacity.
- Revoked/reassigned credentials enforce current authority while preserving historical attribution.
- A copied tag URL or UUID alone cannot authorize a payment; replay cannot charge a new intent.
- Verify NTAG, Apple VAS, and Google Smart Tap on the actual reader hardware and supported devices; installed passes are not sufficient proof of tap acceptance.
- Simultaneous loads cannot exceed balance/daily-value headroom; clearing a partially spent load cannot credit it twice.
- Failed/returned ACH preserves auditability and correctly tracks remaining funds, spent exposure, and risk restrictions.
- P2P is atomic, idempotent, subject to recipient headroom and sender authority, and cannot move restricted pending funds.
- Device access links cannot grant access after expiry, replay or revocation; minor profiles and assigned tags follow guardian permissions.
- Membership downgrade preserves access to existing funds while applying the approved restrictions to new loads.

## 14. Selected Orb battery

Selected by Dami on October 12, 2026: **Grepow GRP7550040**. This supersedes the smaller battery candidates discussed previously.

- Manufacturer reference listing: 1,500 mAh, 4.2 V full-charge voltage, 1C rate, 50 × 40.5 × 7.3 mm. These are listed cell dimensions, not a confirmed protected-pack envelope. [Grepow battery specifications](https://www.grepow.com/shaped-battery/round-lipo-battery.html).
- Procurement requirement: protected single-cell pack with PCM, suitable leads/connector, and temperature sensing compatible with the charger. Inclusion is not confirmed by the public model listing. Obtain pack drawing, dimensional tolerances, expansion allowance, nominal voltage, charging limits, and permitted continuous/pulse discharge currents from the supplier.
- A 1C rate corresponds to 1.5 A at this capacity; its discharge interpretation and PCM limits require supplier confirmation.
- Main PCB requires a charger matched to the cell, power-path management for operation while charging, and the required regulated supply rails.
- Mechanical design must accommodate the 50 mm cell width below the updated 65 mm circuitry PCB, including mounting clearance. Locate below the LED PCB as the proposed arrangement; account for its effect during assembled NFC antenna tuning.
- Planning energy: assuming 3.7 V nominal, 5.55 Wh nominal / 4.44 Wh usable with an illustrative 80% energy budget. Estimated runtimes at total average loads of 0.15 W, 0.50 W, and 2 W are approximately 30 h, 9 h, and 2.2 h. These are calculations, not measured performance or guaranteed battery specifications.
- Eight-hour operation requires total average power no greater than approximately 0.56 W under those assumptions. Verify with measured BLE, NFC, LED, and conversion consumption and define additional aging reserve before specifying guaranteed runtime.

## 15. Orb audio

Requested October 12, 2026: compact board-mounted audio for clear mid-tone payment chimes. Dami narrowed scope to chimes only, no speech, and prefers an SMT-style speaker, proposing CMS-151103-088SP as a candidate.

- Proposed signal path: local flash sound assets → ESP32 software decoding/PCM playback → I2S → MAX98357A mono Class D amplifier → miniature dynamic speaker. No separate MP3 playback module is required by this proposed design. Decoder compatibility and memory requirements must be checked against the final ESP32 variant. [Espressif audio framework](https://github.com/espressif/esp-adf), [amplifier specifications](https://www.analog.com/en/products/max98357a.html).
- Preferred speaker candidate: Same Sky CMS-151103-088SP, 15 × 11 × 3 mm, 8 ohms, 0.7 W nominal / 1 W maximum. Bare driver requires an acoustic enclosure. [Manufacturer product page](https://www.sameskydevices.com/product/audio/speakers/miniature-%2810-mm~40-mm%29/cms-151103-088sp).
- Assembly qualification: this part has solder pads, but its data sheet specifies hand soldering, not a reflow profile. Do not mark it as reflow-qualified SMT. Plan mounting/soldering after main PCB reflow, or select a separately documented reflow-capable alternative if automated SMT placement is mandatory. [Manufacturer data sheet, distributor-hosted copy](https://www.tme.eu/Document/0448399f828649c863bc52a078d2e0f6/cms-151103-088sp.pdf).
- Main PCB carries the amplifier and proposed speaker mounting. Provide a front acoustic opening and sealed separation from a rear cavity; evaluate a roughly 1 cm³ cavity, matching the supplier's acoustic test enclosure. Locate clear of the NFC antenna and account for speaker metal in RF testing. Candidate speaker and amplifier are not yet finalized parts.
- Provide success, failure, ready and optional connection/status cues; volume and mute settings. Emit success only for the matching committed payment result, aligned with the existing Orb animation rule. Avoid repeated success cues on duplicate result delivery.
- Use gain/output limiting appropriate to the speaker and supply voltage. Shut down the amplifier when inactive, budget simultaneous audio/NFC/LED peaks, and update runtime estimates from measured usage.
- Validate assembled acoustic quality, rattling, port obstruction, and NFC/BLE coexistence during loud playback. Target clean mid-tone chimes, initially exploring roughly 1–3 kHz with shaped attack/decay and modest gain. PCM WAV or synthesized tones can avoid MP3 decoding for these short sounds; MP3 remains optional. Speech and music playback are outside current scope.

## 16. Orb dome and enclosure

Confirmed October 12, 2026: white-opal diffuser appearance and injection molding for both dome and base, superseding the initial thermoforming plan. New proposed materials: UV-stabilized opal diffuser polycarbonate dome and opaque, unfilled PC/ABS base. Exact grades, wall thickness, light transmission, matte texture, and aging performance remain to be selected/verified.

Current attachment direction: flush exterior seam with a concealed molded snap joint, eliminating adhesive if moldability and retention are validated. Prefer flexible segmented hooks in the base engaging shallow catches on a hidden dome skirt; retain a removable bottom service plate. Design the base hooks for tooling shutoffs where feasible. Dome catches may require approved shallow bump-off geometry or lifters/collapsible tooling; undercut feasibility cannot be assumed. Keep thick bosses and ribs away from the illuminated dome surface to reduce sink/shadow defects. Earlier rim/adhesive options below are alternatives, not the current preferred design.

Proposed attachment: trim the thermoformed dome with a flat peripheral flange, captured between a base ledge and retaining bezel with a compliant gasket. Use concealed underside screws into base/bezel structure; avoid screw loading directly into the acrylic dome. Mechanical retention must allow forming tolerances and expansion, with controlled compression and no claimed ingress rating until tested. Initial flange width target 3–5 mm, subject to mechanical layout.

Permanent bonding is an alternative if a removable bottom service plate provides battery/electronics access. Select adhesive only after confirming both substrates and bonding tests on formed samples. Acrylic supplier guidance supports compatible permanently elastic silicone adhesives for dissimilar materials, and warns that stressed thermoformed acrylic may crack with solvent/polymerization bonding. Light-cured adhesives must not be assumed to cure through opal sheet. [Acrylic bonding guidance](https://www.plexiglas.de/en/service/processing/bonding-plexiglas), [joining guide](https://www.plexiglas.de/files/plexiglas-content/pdf/verarbeitungsrichtlinie/311-3-EN-joining-PLEXIGLAS.pdf).

## 17. Context provenance and remaining decisions

Sources: current user feature list and shared-wallet confirmation; ARCHITECTURE-DECISION.md; project chat “Develop closed-loop payments ledger” (balance model, bank-only funding, approved payment credit, daily-value accounting, agent/family controls, merchant/card/payroll scope); project chat “Nuclear Business Idea & Deck” (confirmed latest backend baseline).

Next decisions: final Free/Exclusive balance caps and entitlements; approved payment credit eligibility/terms; P2P eligibility and regulatory/program treatment; limits/reset/refund rules; Apple/Google approval and hardware plan; launch sequencing for merchant software, online payments, agents, and payroll. Advance against pending ACH is withdrawn. Approved payment credit is independent of funding attempts; shared-family-wallet scope remains confirmed.
