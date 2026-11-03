# Tabs: shared orders for a table

Designed **October 31, 2026**, revised the same day several times (fund holds, four split modes and Cover, a close that never declines, and finally **no holds while ordering: money is held only when a person closes their position**). Status: **built 2026-10-31 (API, merchant portal, web menu page); the customer app and terminal screens are not built** (see "As built" at the end). This is the specification and what was built. It reuses the money rules in [SCHEME-V2.md](SCHEME-V2.md), [BALANCE-POLICY.md](BALANCE-POLICY.md) and [WALLET-ACCESS-POLICY.md](WALLET-ACCESS-POLICY.md) and makes **one change to them: fund holds** (below). Backlog entries: RES-02 and RES-04 in [COMPETITION.md](COMPETITION.md); customer journey in [FEATURE-SPEC.md](FEATURE-SPEC.md) (TB-01 to TB-18) and [PLATFORM-SCOPE.md](PLATFORM-SCOPE.md) (section 6, "Tabs").

## What it is

A **tab** is one open order at a merchant that several people share. Each person adds items from the merchant's catalog on their own phone (or a server adds them verbally), everyone sees the whole tab (who is on it, what each person ordered, who is paying for what), and when the host closes it **wallets are debited according to the split mode the table chose**. The merchant receives one ordinary payment per paying wallet.

A table has a printed **QR code and an NFC cube**. Scanning or tapping it opens the merchant's menu and opens a tab (or shows the tab already open at that table, with the faces and names of the people on it and a Join button).

**Ordering is free of money checks.** Nobody's funds are touched while they order, and a server can assign an item to anyone without any funds being held, because a table changes all the time. Money is checked and held at two moments only: when a person **closes their position** (to leave early and still be covered) and at **Pay**.

## The four ways to split, and Cover

The host picks the mode (default Own Tab) while the tab is open.

| UI name | Working name | Key | Who pays what |
| --- | --- | --- | --- |
| **Own Tab** | Cover your tab | `own` | Everyone pays for what they ordered, plus tax and their share of the tip. A person who wants to leave early closes their position and their funds are held. |
| **Pitch In** | Chip in | `pitch` | Everyone puts in what they can afford (a pledge, held when made). The tab closes when the pledges cover the bill; if they total more, every pledge is cut in proportion. |
| **Equal Shares** | Even split | `equal` | The whole bill (items, tax, tip) is divided equally between everyone still on the tab. Each person closes their position with a ceiling for their share. |
| **On Me** | Carry | `host` | The host pays for everyone, including people who join later, optionally up to a per-person limit. Nobody else needs funds. |
| **Cover** (a feature of Own Tab and Equal Shares, not a mode) | Cover | `covers` | Any member taps faces and pays for those people's bills, in whole or up to a limit. The covered people see who is covering them. |

On Me is the same thing as the host covering every member, built in as a mode so it also covers late joiners.

Everything below is one allocation engine: the mode and the Covers decide **which wallet pays which part of the bill**; the order, the tax, the tip and the merchant's payments are the same in every mode.

## Decisions taken in this design

| # | Decision | Why |
| --- | --- | --- |
| 1 | **A member is a wallet** (`tab_members` is keyed by `wallet_id`), not just an account. | The wallet carries the face and the name (`wallets.photo`, `display_name`) and is what pays. A family account with two children's wallets is two people. Delegated wallet sessions work unchanged. |
| 2 | **Joining is the consent.** Join says: "the host can pay this tab from your wallet for the items assigned to you, tip up to your limit" and asks for the **most tip** the person agrees to (default 25% of what they pay for). | One consent, at the door, instead of a step before every order. |
| 3 | **Adding items never needs funds and nothing is held while ordering** (owner, 2026-10-31). Servers assign items to a member or to the Table with no check. | Table dynamics change at any time; friction at ordering costs the merchant more than it saves. |
| 4 | **Funds are held when a person closes their position** (owner, 2026-10-31): they press **Close My Tab**, their share is fixed and their funds are held. This is how an early bird leaves and is still charged. In Pitch In the pledge is the hold; in Equal Shares the ceiling is. | The hold exists only to protect people who are not there at Pay. |
| 5 | **The host closes the tab and approves for everyone** (owner, 2026-10-31); a manager may close for a host who has gone. Nobody is charged beyond what they agreed (their tip limit, or their hold). | Closing must not wait for a person who went home. |
| 6 | **A tab's payment never declines** (owner, 2026-10-31). Pay checks every payer's funds, limits and status **inside the same call, under the locks, before writing anything**, and refuses with a **shortfall** naming who is short. Closed positions are guaranteed by their holds. A declined row is never written by a tab. | The payment is a capture or a checked debit; there is no half-paid tab. |
| 7 | **One tip for the tab, split by the ratio of spend** (each person's item total before tax, after discounts), largest remainder, ties by wallet id. In Equal Shares the ratio is equal, in Pitch In the ratio of amounts. | The owner's rule. |
| 8 | **Each paying wallet's payment is a normal `pay` transaction with its own checkout** (`checkouts.tab_id`). Tax, tips, receipts, refunds, reports, settlement and stock work per payment with the existing code. | Tabs add order state and holds in front of the money functions; no new money type. |
| 9 | **A table cube is not a payment credential.** A plain NFC tag with a static `https://nclr.app/t/<code>` link, never an NTAG 424 band; no counter, no secret. | Scanning authorizes nothing. |
| 10 | **The table is freed the moment the party is done**, even if a shortfall remains (the tab becomes `unpaid`, off the table, holds kept). | A new party must never find the last party's tab. |
| 11 | **Verbal orders** are assigned by a server to a member (by face and name) or to **the Table** (a guest who is not on Nuclear or not on the tab). The Table's bill is paid by the host unless a member covers it. | Real service is partly verbal. |
| 12 | **`tab_members` is kept** next to `tab_items`. | See the next section. |

## Do we need `tab_members` if `tab_items` has the wallet?

Shares and totals can be read from `tab_items` alone. A small members table stays because:

1. **Someone who joined but has not ordered yet** has no item but must appear with a face and a name and may read the tab.
2. **Authorization and consent.** "May this wallet read, order on, or be charged for this tab?" must be a primary-key lookup, and the consent (the tip limit agreed at Join) belongs to the member.
3. **Leaving, removal and position state.** A person who left early (position closed, hold standing) or was removed by staff must stay visible.

`tab_items.wallet_id` records who ordered what (NULL is the Table); `tab_members` is one row per person (join and tip limit, position closed, away, removed); the money held lives in `fund_holds`.

## Fund holds

A **fund hold** sets money aside on a wallet for one tab. The money stays in the balance, but nothing else can spend, send, buy with, move or earmark it. A hold is a **ceiling**: the payment may be less, never more. **A hold exists only for a person who has closed their position** (or pledged, or set an Equal Shares ceiling); a person who is still ordering has none.

**One column (planned migration):** `wallets.held` (bigint, default 0, `>= 0`): the sum of that wallet's active holds. Nothing is added to `balances`. The account's shared funds are already computed by summing over the account's few wallets (the earmark, `shared_funds()` and `v_em` in the money functions); the same read now also sees `held`, so the hot path gains no query.

**What is spendable** (every money function and the balance endpoint use these):

| Spender | Available |
| --- | --- |
| A wallet with its own balance (earmarked or Benefits) | `wallets.balance - wallets.held` (and never more than the account's balance) |
| A wallet that draws on shared funds, to send or buy | funded `balance` minus the sum over the account's wallets of (`wallets.balance` for an earmarked wallet, else `wallets.held`) |
| The same wallet, to pay a merchant | the figure above plus unused approved credit |

So the earmark rule becomes: the shared pool loses an earmarked wallet's whole balance (its holds are inside it) and a shared wallet's holds. A hold is backed by the same capacity a payment is (funded balance, then unused approved credit), so a person who pays with credit can still close a position. At Pay the hold is released and the payment goes through the normal path. Holds are never created from another wallet's earmark, and never by a business or organization account (they cannot join tabs).

**Worked example.** An account has $100 and two wallets: Main (shared) and Lunch (earmarked $30), so the shared pool is $70. Main orders $20 of food; the tax and a 25% tip limit make its share at most $25. Main's owner presses **Close My Tab**: a $25 hold is placed, `wallets.held` for Main is 25 and Main's spendable becomes $70 - 25 = $45. The balance is still $100 and no transaction exists. Lunch is unaffected (its $30 was already out of the shared pool). At Pay the tab's amount for Main is $23: the hold is released and the payment is made, the balance becomes $77, and the unused $2 is spendable again. If the tab is canceled or expires the hold is released and nothing is charged.

**The `fund_holds` table** (who is holding the funds):

| Column | Meaning |
| --- | --- |
| `id` | uuidv7. |
| `account_id`, `wallet_id` | The holder: whose money is set aside, and from which wallet. |
| `kind`, `tab_id` | `tab` and the tab (the table is generic so later uses need no new table). |
| `amount` | The ceiling in cents: the person's amount at the tip limit, or their pledge, or their Equal Shares ceiling. Fixed while the position is closed. |
| `status` | `active`, `captured` (paid at Pay), `released`. |
| `ended_at`, `end_reason` | `paid`, `reopened`, `left`, `removed`, `mode_changed`, `canceled`, `expired`, `withdrawn_by_system`. |
| `transaction_id` | The payment that captured it. |

One **active** hold per tab and wallet (partial unique index). An ended hold is frozen by trigger. Holds are written only by the SQL tab functions, which also update `wallets.held` in the same statement under the balance locks. **Reconciliation** adds `holds_match_wallets` (every `wallets.held` equals the sum of that wallet's active holds), `holds_belong_to_open_tabs` and `holds_are_backed` (a wallet's active holds are within what it can spend).

**A hold reserves everything a payment checks**, so the capture cannot decline: placing it requires available funds (as above), the wallet's hard limit, **the wallet's daily limit (`spent_today + held <= limit`, so the limit is reserved too)** and an active wallet and account with `allow_pay`. After that, anything that would stop the money being there **acts on the hold when it happens**:

- the wallet or account is suspended or closed, `allow_pay` is switched off, or the owner lowers the earmark: the wallet's holds are released (`withdrawn_by_system`) in the same statement, so the position reopens; an earmark edit below `held` is refused (`hold_active`);
- a fund return, or an approved-credit reduction, takes the balance below the holds: the newest holds on that wallet are released the same way;
- the merchant changes its tax rate or prices while a tab is open: every closed position on its open tabs is reopened (hold released) and the people are told.

Each of these bumps the tab's `version` and notifies the members, so the shortfall appears at once (see "Shortfall"). A person who is still ordering has no hold, so none of this applies to them; they are checked live at Pay.

**Hold and other money paths:** `app_send`, `app_pay_app`, `app_pay_tap`, `app_pay_checkout`, `app_purchase`, the wallet move, the earmark edit (`PUT /v1/wallets/:id/balance`) and `GET /v1/balance` all subtract the holds. With `held = 0` they behave exactly as today, so this slice ships and is tested first, on its own (build plan, step 1).

## Journeys

### Open or join (QR or NFC cube)

1. Someone taps the cube or scans the QR. The link `https://nclr.app/t/<code>` opens the Nuclear app (universal link), or a web page with the **menu only** (read-only, with an Open In Nuclear button).
2. The person signs in (an owner session or a delegated wallet session) and chooses the paying wallet (default if they do not choose; a Benefits wallet may pay, including for other people).
3. If the table has **no open tab**, the app offers *Open a tab*. The person becomes the host and first member and chooses the split mode.
4. If a tab is **open**, the app shows **the faces and names of everyone on it**, who is covering whom, and a **Join** button (wallet photo and display name only, never handle, email or balance). Scanning never joins by itself. Pressing Join is the consent (decision 2), with the tip limit.
5. A tab can be opened with no table (counter, bar, takeaway). Every tab has its own **invite link and QR** (`invite_code`) that a member can show to friends. The host can **lock** the tab; staff can remove a member who has no items and can rotate a table's code.

### Order

- Any member adds items from the menu (`product_id`, quantity), **with no funds check and no hold**. The server snapshots name, price, discount and taxability into `tab_items`. Everyone sees every member's items, quantities and subtotals. A member may remove their own items (including items a server assigned to them) while their position is open. A manager may void any item. Stock is not taken here (it is taken at Pay); a sold-out product cannot be added from the app.
- **Verbal orders:** a server (terminal or the merchant portal) adds items by picking the member's face and name, or **the Table** when the guest is not on Nuclear or not on the tab. There is no funds check, so assignment is instant. Items for the Table are paid by the **host** unless another member **covers the Table** like any other person. In Pitch In, Equal Shares and On Me the Table's items are simply part of the bill. Staff-added items carry `added_by` and are audited. A server can assign only to joined members (their Join is the consent).
- A member whose position is **closed** cannot be assigned or add items (`position_closed`): the server assigns to the Table or the member reopens. While the host's position is closed, items for the Table are refused the same way until the host reopens or another member covers the Table.

### Close My Tab (leave early and still be covered)

A member who is leaving before the host pays presses **Close My Tab**. It is optional for people who will be there at Pay.

- **Own Tab:** their share is fixed from their items now (items, tax, their tip share at their tip limit) and **funds for that ceiling are held**; their items are locked. If the funds are not there the app says exactly how much is missing and nothing is held.
- **Pitch In:** the person enters a **pledge**; it is held. Raising, lowering or withdrawing is allowed until the tab is paid.
- **Equal Shares:** the person sets a **ceiling** for their equal share (the app suggests the share plus the tip limit); it is held.
- **On Me:** only the host pays; members never need to close.
- A member can **reopen** their position any time before Pay (hold released, items editable again). A member with items cannot leave the tab without closing their position first; a member with no items simply leaves.
- A leaver appears on the tab as "left, charged at Pay". The **host** cannot leave while the tab is open without handing the role to another member (`POST /v1/tabs/:id/host`) or to staff.

### Cover (cover someone's bill)

In Own Tab or Equal Shares any member can tap the faces of other members, or **the Table**, and press **Cover**, optionally with a **limit** per person. The covered person's bill, up to the limit, becomes the coverer's to pay.

- A bill is whatever the person ordered plus tax and tip share (Own Tab) or their equal share (Equal Shares). Above the limit the covered person pays the difference.
- A person has **one** coverer, and a member who covers others cannot be covered (no chains). Nothing is held when a Cover is made. If the coverer closes their position, an unlimited Cover **becomes a limit equal to what it covers at that moment**; items the covered person adds afterwards are theirs.
- **The covered person sees who is covering them**: the face and name of the coverer on their own row ("Covered by Pat") and in the tab summary, and can **decline** the Cover (they then pay their own). The coverer sees the faces they cover and the running cost, and can stop covering while the tab is open.
- On Me shows every member "On <host>". A covered person's closed tab shows "Paid by <face>"; they have no payment of their own. Cover and On Me are not available in Pitch In (a pledge is already the way to pay for others).

### Shortfall: the difference that must be resolved

The tab always shows **what is not yet covered**, to everyone, and **Pay is disabled while a known shortfall exists**:

- **Pitch In:** the bill minus the sum of the pledges ("$18.40 short").
- **Equal Shares:** each person who has closed their position with a ceiling below their equal share, and by how much (shares shift as items and people change); the shortfall is their sum. A person who has not closed is expected to pay their share at Pay.
- **Own Tab, On Me, Cover:** the known shortfall is zero unless a closed position was reopened by the system (suspension, a fund return, a rate change). People who have not closed their position are marked "not yet settled" (informational).

Because people who are still ordering have no hold, **Pay also checks their funds, limits and status live, inside the same call**; if any payer cannot pay, **nothing is written** and the answer is `shortfall` naming the wallets and the amounts short (a person sees their own reason; the host sees only that they are short and by how much). A shortfall is resolved by raising a pledge or ceiling, closing a position, Covering the person, voiding items, the person leaving (with no items), or sending their share to the counter.

### Ready, review and Pay

1. Any member presses **Ready**. The tab moves to `paying`: no more items, and everyone sees **who pays what** (their own amount and, if they cover others, what they pay for others). The tip (percent of the item total, a fixed amount or none) can be set by any member and by staff; any change bumps the version. Any member can press **Back to ordering** until the tab is paid.
2. The **host presses Pay** (or a manager, below), sending the version they saw; a changed version is refused (`stale_version`).
3. Pay requires no known shortfall, then checks every payer live as above. A tip that would exceed one person's tip limit is **clipped for that person** (their consent is the limit, and the others' shares do not change), and the tab shows who it was clipped for; a clipped tip is not a shortfall.
4. On success every payer is told: paid, with a receipt for their own payment.
5. **The table is freed the moment the party is done.** Pay with no shortfall closes the tab at once. When the party has gone and a shortfall remains, the host or a manager presses **Clear Table**: the tab becomes **`unpaid`**, leaves the table at once, keeps every hold and is resolved away from the table (people close their positions or raise pledges, a member Covers, or the share goes to the counter, then Pay runs; or the manager cancels). **Clear Table on a tab with no shortfall just tries Pay** as a manager. Only `open` and `paying` tabs hold a table.

### Staff

Staff see open tabs, each member's items and who has closed their position, who holds funds and who is covered, live, in the merchant portal (a Tabs page) and on the terminal. They can assign the **server** (who receives the tip), void items, add items for a member or the Table, remove a member with no items, lock joins, hand the host role to a member, rotate the table code, press **Clear Table** and **cancel** a tab (all holds are released, nothing is charged). A **manager** (STF-01) may also **Pay for a host who has gone** (audited as `tab.closed_by_staff`); everyone's consent is their Join (tip limit) and, for closed positions, their hold. Nobody can be charged beyond the tip limit they agreed to or, for a closed position, beyond the hold.

A member can also settle their share **at the counter**: staff turn that member's part into an ordinary open checkout and the customer taps a band or card (existing terminal flow); that member's hold is released and their share leaves the tab. This is the route for a wallet that cannot cover the share online.

## The allocation engine (`app_tab_quote`)

One pure SQL function reads the tab and returns, for every paying wallet, its **lines, tax, tip, amount, who it is paying for, position (open or closed) and `short`**. Every screen shows its output, Ready shows it to everybody, and Pay runs it again under the locks, so what people saw is what is charged (the version check makes them agree).

**Inputs:** the non-void items, the tab's tip, the merchant's tax rate, the split mode, the Covers, the positions and holds.

1. **Tab totals.** Each line's net is (unit price - discount) x quantity. **Tax is computed once for the whole tab** with the existing `app_tax(merchant, lines)` (one half-up rounding, shared over the taxable lines by largest remainder), so the table is taxed as one order. Each orderer `o` (a member, or the Table) has `items_o`, a tax share `tax_o` and a tip share `tip_o` (largest remainder of the tab tip by `items_o`, ties by wallet id). Their **bill** is `b_o = items_o + tax_o (when added on top) + tip_o`; the tab total is `T = sum b_o`.
2. **Who pays each bill, by mode.**
   - **Own Tab:** each orderer pays their own bill, unless Covered. The Table's bill is paid by the host unless a member covers the Table.
   - **On Me:** the host pays every bill, each person's bill up to the per-person limit and the orderer paying the rest, if a limit is set.
   - **Equal Shares:** `T` is divided equally between the members still on the tab (largest remainder, ties by wallet id).
   - **Pitch In:** each wallet pays its pledge, reduced if the pledges total more than `T`: amounts are `T` shared by pledge (largest remainder, never above a pledge), so the total is exactly `T`.
   - **Cover** moves a person's bill (up to the limit) onto the coverer in Own Tab, or a person's equal share in Equal Shares.
3. **Lines of each payment.** When a whole bill moves to a payer (Own Tab, On Me, a full Cover) the payer's checkout carries **the real lines**, so item refunds and restock work, and each line keeps its own tax share. When a bill is cut (Equal Shares, Pitch In, a Cover with a limit that binds) the cut money is carried as **share lines**: one **Share of table (taxable)** line and one **Share of table (not taxable)** line of quantity 1. The tax and tip of the payment are then shared by amount (largest remainder over the paying wallets), and the net is what is left, so the payments add up exactly to the tab's net, tax and tip. A checkout may have both kinds. Share lines refund by amount. Items for the Table are real lines and go with whoever pays for the Table.
4. **Reports stay correct:** per payment the tax and tip are recorded as for any order, so the daily report, tips and tax collected match what was charged.
5. **Rounding:** payments may differ from an exact fraction by a cent or two in Equal Shares and Pitch In; the table shows the exact amounts before anyone pays.

## Pay: `app_close_tab` (one SQL function, one transaction)

1. Lock the tab row (`FOR NO KEY UPDATE`). Require `status = 'paying'` and the version the caller saw.
2. **Lock order, up front:** products (by id), then the **balances rows of the merchant and of every paying wallet's account, ascending by account id**, then the wallets. Taking all balances first, in one order, keeps a Pay from deadlocking against a single payment by one of those people (the lock order in AGENTS.md: tag, checkout, products, balances by account id, wallet).
3. Run `app_tab_quote`. For payers with a **closed position**, require their active hold to cover their amount (tip clipped as above). For payers **without** one, check, under these same locks, funded balance plus approved credit, the wallet hard limit, the daily limit and account and wallet status. **If anyone is short, return `{ok: false, short: [{wallet_id, amount}]}` and write nothing.**
4. For each payer in wallet id order: release its hold if it has one (captured; `wallets.held` drops), insert a checkout (`tab_id`, lines, `sales_tax`, `total`, `reference` = table name, `served_by` = the tab's server) and complete it through the payment core with the payer's tip share and the idempotency key `pay:<merchant>:c:<account>:tab:<tab id>:<wallet id>`: funded balance then approved credit, tips recorded to `tips`, `sold_today` raised. Everything was checked or reserved in step 3, so this cannot fail. **Stock is taken here but never below zero**: the food has already been served, so a product that sold out meanwhile is clamped at 0 and never causes a decline.
5. A payment that nevertheless could not complete is a **bug, not a customer state**: the function raises inside its own block, so nothing is written (not even a declined row), every hold stays, an alert is logged and the tab is left for staff.
6. On success the tab is `closed`, the holds are `captured` and linked to their transactions. A repeat call after success returns the same result (the per-payer keys make it a replay). Holds of members who are not paying are released (`end_reason = left`).

The other tab functions that touch money are `app_tab_settle` (Close My Tab: checks, places the hold, locks the items), `app_tab_reopen`, `app_tab_set_mode` (changing the mode releases every hold and reopens every position; the people are told), `app_tab_cover` (a Cover changes who pays whom, so it reopens the affected positions) and `app_tab_release` (cancel, expiry, leaving). **Adding, voiding and assigning items touch no balance or wallet row**, so they are ordinary TypeScript and add no lock contention. Each money function locks the tab, then the balances of everyone it touches ascending by account id, then the wallets, so none can deadlock with a Pay or a payment.

### After Pay

- The merchant sees N ordinary payments. Settlement, close-out, the daily report, the sales chart, tips views and receipts read them unchanged. A payer's receipt lists their lines, and for a Cover names the person covered ("includes Sam's order").
- **Refunds** are per payment through the existing rules (a tip returns only with the whole payment). A refund goes to the wallet that paid, never to the person who was covered.
- **Reconciliation:** `tab_paid_once` (every closed tab has exactly one completed payment per payer and their sum equals the tab total), together with the hold checks above.

## What each person sees

- **Every member:** the faces and names of all members; who ordered each item (or "Table"); each person's subtotal; the split mode; for every member whether their position is closed (a check mark only, never an amount) and whether they have left; and, when the tab is paying, **who pays what** and the shortfall.
- **A covered or carried person:** "Covered by Pat" or "On <host>" on their row, the face and name of whoever is paying, their own items and what they would otherwise have paid, and a Decline Cover button. After Pay: "Paid by <face>".
- **A coverer or host:** the faces they are paying for and their running cost, and the limit.
- **Only the holder:** the amount of their own hold and their tip limit. Nobody sees another person's balance or hold amount.

## Joining safely

- The code on the table is **static by nature** (anyone can photograph a QR). Therefore: joining requires a signed-in Nuclear account; the member list shows wallet photo and display name only; nobody is charged beyond the tip limit they agreed to at Join or the hold they placed; staff can remove a member with no items; the host or any member can lock the tab; a table code can be rotated; joins are rate limited per account and per IP. Because ordering needs no funds, a joiner can add items that Pay may then find unpayable: Pay refuses with a shortfall and nothing is written; staff void the items or send the share to the counter.
- Remote joiners: someone with a photo of the QR can join an open tab and read faces, names and items. The control is lock-after-everyone-arrives, staff removal and rotation. This is an **accepted privacy risk** (owner, 2026-10-31).
- A member is charged for items **assigned to them by a server** because they joined (the consent); they see each assigned item live, can void it before Pay, and see their amount in Ready.
- Agent wallets cannot join tabs in version 1.

## Data model (planned migration, not written)

New tables are **order state**, mutable until the tab ends; the money truth stays in `transactions` (immutable). Rows are frozen by trigger once the tab is `closed`.

### `venue_tables`

A table, counter or bar with a code (not named `tables`, to avoid the SQL word).

| Column | Meaning |
| --- | --- |
| `id`, `account_id` | The merchant. |
| `name` | "Table 4", "Bar". Shown on the menu page and as the order reference. |
| `code` | Unguessable, URL-safe, unique. Printed on the QR and written to the NFC cube. Rotatable. |
| `served_by` | Default server (staff account) who receives tips. Nullable. |
| `active` | A deactivated table opens no new tab. |

### `tabs`

| Column | Meaning |
| --- | --- |
| `id`, `account_id` | The merchant. |
| `table_id` | Nullable. At most one **open or paying** tab per table (partial unique index). `closed`, `unpaid`, `canceled` and `expired` tabs are off the table, so a new party can open one at once. |
| `host_wallet_id` | The host (the opener; changeable). |
| `status` | `open`, `paying` (review, items locked), `closed`, `unpaid` (the party left with a shortfall: off the table, holds kept), `canceled`, `expired`. |
| `split_mode` | `own`, `pitch`, `equal`, `host` (UI: Own Tab, Pitch In, Equal Shares, On Me). Changed by the host while `open`; changing it releases every hold and reopens every position. |
| `cover_cap` | On Me only: the most the host pays per person, null = no limit. |
| `version` | Bumped by every change. Ready and Pay act on the version people saw. The app reads `GET /v1/tabs/:id?since=<version>`. |
| `invite_code`, `locked` | The invite link (rotatable); no new members. |
| `served_by` | The staff account that receives the tip. Without one the tab cannot carry a tip. |
| `tip_mode`, `tip_value`, `tip_amount` | `none`, `percent` (basis points) or `amount`; `tip_amount` is fixed at review. |
| `opened_at`, `review_at`, `closed_at`, `closed_by`, `closed_reason` | Timeline; `closed_by` is the host or a staff account. |

### `tab_members`

Primary key (`tab_id`, `wallet_id`). `account_id` (the owner), `joined_at` (the consent), `max_tip_bps` (the most tip they agreed to, default 2500), `settled_at` (position closed; null while open), `away_at` (left early), `removed_at`, `removed_by`.

### `tab_items`

| Column | Meaning |
| --- | --- |
| `id`, `tab_id` | |
| `wallet_id`, `account_id` | Who ordered it. **NULL for both means the Table** (a verbal order for a guest who is not on Nuclear or the tab). Staff-added items still name the member; `added_by` records the staff account. |
| `product_id`, `name`, `unit_price`, `discount`, `taxable`, `quantity` | The snapshot when the item was added. |
| `note` | Up to 80 characters for the kitchen. |
| `status` | `ordered` or `void` (`voided_at`, `voided_by`). Never deleted from an open tab. |

### `tab_covers`

One row per covered person: unique on (`tab_id`, `covered_wallet_id`), where **`covered_wallet_id` NULL is the Table** (at most one row for it). `payer_wallet_id`, `cap` (cents or null), `created_at`, `declined_at`, `ended_at`. One coverer per person; a member cannot be both a payer here and a covered wallet. Without a row the Table's bill belongs to the host.

### `fund_holds` and the wallet column

See "Fund holds" above (`fund_holds` and `wallets.held`). `checkouts.tab_id` (nullable, indexed) links each payer's checkout to the tab.

## Staying fresh

The architecture has no WebSocket layer for customers. Version 1 refreshes by conditional read: the app calls `GET /v1/tabs/:id?since=<version>` every few seconds **only while the tab screen is in front** and gets `{unchanged: true}` (a primary-key read on `tabs`) until something changes. Push notifications ("Sam added Fries", "Pat is covering you", "The tab was paid") use the existing `devices.push_token` once the app exists. A Durable Object per active tab is the later upgrade. The payment never relies on polling.

## Lifecycle and cleanup

- An open or paying tab idle for 12 hours, and an `unpaid` tab 12 hours after it went unpaid, becomes `expired` (the daily cron, `lib/retention.ts`): **every hold is released and nothing is charged.** The merchant's remedy is to Pay (the host, or a manager) before that; an `unpaid` tab is flagged to staff on the Tabs page.
- Closed, canceled and expired tabs are kept as order history; empty expired tabs are purged after 30 days. Ended holds are kept with their tab.

## API (planned)

Customer (owner or delegated wallet session):

| Route | Purpose |
| --- | --- |
| `GET /v1/menu/:code` | Public. Merchant, table name and the active, available catalog. No tab data. |
| `GET /v1/tab-codes/:code` | Signed in. The table and its open tab with member faces and names, or none. |
| `POST /v1/tab-codes/:code/join {wallet_id?, max_tip_bps?}` | Open a tab or join the open one. Idempotent per wallet. |
| `POST /v1/tabs/join {invite_code, wallet_id?, max_tip_bps?}` | Join by invite link. |
| `GET /v1/tabs`, `GET /v1/tabs/:id?since=` | My tabs; one tab with members, items, positions, covers, who pays what, shortfall, version. |
| `POST /v1/tabs/:id/items`, `DELETE /v1/tabs/:id/items/:itemId` | Add (no funds check); remove my own (void). |
| `POST /v1/tabs/:id/settle {amount?}`, `POST /v1/tabs/:id/reopen-position` | Close My Tab (amount = pledge or ceiling in Pitch In and Equal Shares); reopen it. |
| `PUT /v1/tabs/:id/tip-limit {max_tip_bps}` | Change my tip limit while my position is open. |
| `PUT /v1/tabs/:id/mode {mode, cover_cap?}` | Host: choose the split mode. |
| `POST /v1/tabs/:id/covers {wallet_ids?, table?, cap?}`, `DELETE .../covers/:wallet`, `POST .../covers/:wallet/decline` | Cover faces or the Table; stop covering; decline a Cover. |
| `POST /v1/tabs/:id/ready`, `POST /v1/tabs/:id/reopen`, `PUT /v1/tabs/:id/tip` | Review, back to ordering, set the tip. |
| `POST /v1/tabs/:id/pay {version}` | Host: Pay, debit everyone. |
| `POST /v1/tabs/:id/leave`, `POST /v1/tabs/:id/lock`, `POST /v1/tabs/:id/host {wallet_id}` | Leave; lock joins; hand over the host role. |

Merchant (owner session) and terminal (terminal session; staff roles from STF-01):

| Route | Purpose |
| --- | --- |
| `GET|POST /v1/business/tables`, `PATCH|DELETE .../:id`, `POST .../:id/rotate-code` | Tables, QR link and NFC link. |
| `GET /v1/business/tabs`, `GET .../:id` | Open tabs and history with per-member items, positions, holds and covers. |
| `POST /v1/business/tabs/:id/items {wallet_id? or table: true, ...}`, `.../items/:itemId/void`, `.../members/:wallet/remove`, `.../lock`, `.../server`, `.../host`, `.../clear`, `.../cancel`, `.../pay` | Staff actions, each audited in `logs` (`pay` and `clear` need the manager role). The terminal has the same item route. |
| `POST /v1/terminal/tabs/:id/members/:wallet/checkout` | Turn one wallet's part into an open checkout to be paid by tap at the counter. |

Errors: `tab_not_found`, `tab_locked`, `tab_closed`, `not_a_member`, `position_closed`, `insufficient_funds` (on Close My Tab, with the amount missing), `shortfall` (with who is short and by how much), `hold_active`, `stale_version`, `not_ready`, `tip_needs_server`, `item_unavailable`, `cover_chain`, `already_covered`.

## Merchant portal and the menu page

- **Tables** page: create a table, its QR code (downloadable, print-ready) and the NFC link for a cube, rotate the code, set the default server.
- **Tabs** page: open and unpaid tabs, each with members (faces), items, subtotals, positions, who is covered and the shortfall, and the staff actions above; an `unpaid` tab is flagged.
- **Menu page** at `https://nclr.app/t/<code>` (the website app): read-only menu and an Open In Nuclear button. Ordering itself is in the app.

## Build plan

1. **Holds first, on their own** (no tabs yet): migration (`wallets.held`, `fund_holds`), the five money functions and the wallet move, earmark edit and balance endpoint made hold-aware, the reconciliation checks. With no holds nothing changes, so the existing 47 suites must pass untouched; new suite `holds.e2e.mts` places holds with test-only helpers and proves: a held amount cannot be sent, paid, bought with, moved or earmarked; earmarked and Benefits wallets hold from their own money; credit backs a hold; a daily limit is reserved; a suspension, an earmark cut and a fund return release or shrink holds; concurrent hold and spend on one account never overspend.
2. **Tabs backend:** migration (`venue_tables`, `tabs`, `tab_members`, `tab_items`, `tab_covers`, `checkouts.tab_id`, triggers), `app_tab_*` functions, `app_tab_quote`, `app_close_tab`, `lib/tabs.ts`, `routes/tabs.ts`, the expiry job, audit rows. Suite `tabs.e2e.mts`: join and leave races; add, void and assign with no funds; Close My Tab with and without funds; the four modes with uneven spends, ties and exactness to the cent; Cover with and without a limit, the Table covered, chain refusal, decline; On Me with a limit; tax per payer; tip clipping at a tip limit; Pay with an unsettled payer who cannot pay (nothing written, `shortfall`); a Pay racing a member's own payment (no deadlock, no double debit); idempotent retry; refund of one payer; stock clamped at zero; delegated and Benefits wallets; a stranger cannot read or act; the manager Pay; Clear Table and `unpaid`; expiry releases holds.
3. **Merchant portal:** Tables (QR download) and Tabs pages.
4. **Menu page** on the website app.
5. **Customer app** screens (join, order, close position, cover, review, pay, receipt) and push, with the consumer app. The only part blocked on the mobile app; 1 to 4 are buildable and testable without it.
6. **Terminal:** tab list, verbal-order assignment by face and name or the Table, and the counter-checkout fallback.

## Release gates for tabs

- [ ] A held amount cannot be spent, sent, used to buy, moved or earmarked; `wallets.held` always equals the sum of that wallet's active holds; with no holds every existing money test is unchanged.
- [ ] Adding or assigning items, by a member or a server, never checks or holds funds; a person who only joined is never charged beyond the tip limit they agreed to.
- [ ] Someone who closes their position and leaves is still charged exactly their share at Pay, and the merchant is paid.
- [ ] A tab never writes a declined payment: Pay with a payer who cannot pay writes nothing and answers `shortfall`; suspending a wallet, a fund return, lowering an earmark or changing the tax rate releases holds and shows a shortfall at once.
- [ ] Pitch In and Equal Shares always show the shortfall and cannot close until it is zero.
- [ ] In every mode the payments add up exactly to the tab's net, tax and tip; the tip shares add up to the tab tip to the cent; each payment's tax follows the business rule at Pay.
- [ ] A covered or carried person sees who is paying for them; a coverer cannot be covered; a declined Cover falls back to the person's own bill; the Table can be covered and is otherwise the host's.
- [ ] A Pay concurrent with a member's own payment cannot deadlock or double-debit.
- [ ] A payer's refund, receipt and report line match their own payment; no member can see another member's receipt or hold amount.
- [ ] The table is free the moment the party is done; a new party's tab never sees the old one.
- [ ] Closed tabs and their payments are never changed afterwards; expired and canceled tabs release every hold and debit nothing.

## Decisions to confirm with the owner

Settled 2026-10-31 (owner): the host approves for everyone (no per-person approval) and a manager may Pay for a host who has gone; fund holds exist (`wallets.held` and `fund_holds`, no `balances` column) but **only when a person closes their position**; ordering and verbal assignment never check or hold funds; the four modes and Cover (name kept); covered and carried people see who pays for them; idle tabs expire after 12 hours releasing every hold; open joining by anyone with the code (accepted privacy risk); a Benefits wallet may pay for other people; the table is freed the moment the party is done (an `unpaid` tab if a shortfall remains); a tab's payment never declines (Pay refuses with a shortfall and writes nothing).

| # | Question | Proposed answer |
| --- | --- | --- |
| 1 | Tip limit at Join? | Default 25% of what the person pays for, their choice; a tip above it is clipped for that person only. |
| 2 | Charging a person for items a server assigned to them, without a step in between | Yes: Join is the consent; they see items live, can void them, and see their amount in Ready. |
| 3 | Cover rules | One coverer per person, no chains, optional limit, an unlimited Cover becomes a limit when the coverer closes their position, the covered person can decline, only in Own Tab and Equal Shares. |
| 4 | On Me limit | Optional per-person limit; above it the person pays the rest. |
| 5 | Equal Shares population | Everyone still on the tab, including members who ordered nothing (they leave to drop out). |
| 6 | Pitch In surplus | Pledges are cut in proportion so the total is exactly the bill; Cover is not offered in Pitch In. |
| 7 | An `unpaid` tab after the table is freed | Holds stay for up to 12 hours so the shortfall can be resolved and Pay run; then it expires and releases them. |
| 8 | Button label for closing a position | **"Close My Tab"** (owner, 2026-10-31). |
| 9 | Shared dishes ("share the nachos")? | Not in version 1; later one item becomes N lines priced by largest remainder. |

## As built (2026-10-31)

Built and live on nuclear-dev (migrations `0014_fund_holds.sql`, `0015_tabs.sql`; API `47a21824`, merchant portal `4ac0c0aa`). Where the build differs from the text above:

- **The allocation engine is TypeScript, not SQL.** `apps/api/src/lib/tabQuote.ts` is a pure function (`quoteTab`, `apportion`, `ceilingFor`); there is no `app_tab_quote`. The API reads the tab, computes the quote and passes the paying wallets (lines, tax, tip, amount) to `app_close_tab`, which checks the tab's `version` under its lock, so what people saw is what is charged. Tax comes from `app_tax` over every line of the tab (one rounding for the table).
- **SQL functions that touch money:** `app_tab_settle` (Close My Tab), `app_tab_release` (every release, by tab, wallet, account or hold) and `app_close_tab` (Pay). Joining, ordering, covers, mode, tip, lock, host, leave, ready, Clear Table, cancel and expiry are TypeScript in `lib/tabs.ts`; the ones that give holds back call `app_tab_release` inside their transaction (a cover or a mode change reopens positions).
- **Differences in the data model:** `tabs` has no `tip_amount` column (the tip is computed from `tip_mode`/`tip_value` and the items); `tab_covers` has its own `id`; `tabs.closed_reason` is `host`, `staff`, `canceled` or `expired`; `fund_holds.end_reason` includes `withdrawn_by_system`.
- **Close My Tab** (`POST /v1/tabs/:id/settle`) is allowed while the tab is `open` or `paying`. **Pay** is allowed from `paying` and `unpaid`. The host can also press **Clear Table** (`POST /v1/tabs/:id/clear`), not only staff. The merchant owner acts as the manager (`/v1/business/tabs/:id/pay` and `/clear`) until staff roles (STF-01) exist.
- **A Pay with a known shortfall** (a closed position below its amount, or a Pitch In whose pledges do not cover the bill) is refused before the database is called; otherwise `app_close_tab` checks every payer live (tallied per account, so two wallets of one account cannot spend the same money) and returns `short` without writing anything. A `clear` that finds a shortfall leaves the tab `unpaid` and frees the table.
- **Holds are released at the moment something unbacks them:** a wallet suspended, closed or switched off for payments (`routes/wallets.ts`, admin), an account suspended (admin), a fund return (`fitHolds`, newest first), a tax-rate change (`releaseHoldsOfMerchant`); an earmark edit below `held` is refused (`hold_active`).
- **Rate limits:** `tabJoin` (60 an hour per account) and `tabJoinIp` (60 a minute).
- **Not built:** customer app screens and push; terminal screens (tab list, verbal-order picking by face, the counter-checkout fallback, TB-12); manager staff roles; the admin Overview reconciliation entries `holds_are_backed` and `tab_paid_once` (the test suites assert them); purging old empty tabs.
- **Menu page:** `apps/website/src/Menu.jsx` serves `/t/<code>` (read-only menu from the public, CORS-open `GET /v1/menu/:code`); the website is not deployed, so the printed link does not open it yet.
- Tests: `holds.e2e.mts` (22), `tabs.e2e.mts` (93: the whole journey, the four modes, Cover, shortfalls that write nothing, Clear Table, expiry, races), `tabquote.test.mts` (2,983 checks including 600 random tabs), and the merchant portal's tests (62).

## Not in scope

Splitting by percentage, deposits and card-style pre-authorizations beyond a tab's life, tabs that run for days, kitchen routing and a kitchen display (RES-05), floor plans and seat maps (RES-03), delivery, loyalty, group chat, agents joining tabs, offline tabs.
