# Competition: Square → Nuclear at $0

Reviewed **October 30, 2026**. Market: United States. This is a competitive inventory and proposed implementation backlog, not a statement that Nuclear already delivers these features or a replacement for its money rules.

## Objective

Offer merchants the useful software capabilities across Square's Free, Plus and Premium plans for **$0/month**, with **0% processing on Nuclear wallet payments**. Square already has a free entry plan; our opportunity is advanced business software without location or software-device subscriptions, combined with our closed-loop payment network.

This document proposes the work needed for that target. It does not authorize new financial products, change existing policies, or promise free hardware, unlimited external services, or free conventional card processing. **Payroll remains excluded**, following the owner's October 30 decision. Employer benefits remain permanently free under [ADOPTION-STRATEGY.md](ADOPTION-STRATEGY.md).

## Research method and limits

Opened the live [Square pricing comparison](https://squareup.com/us/en/pricing), expanded all 12 sections, read the rendered plan indicators, checked Food and beverage, Retail, Beauty and Services filters, and opened explanatory tooltips. Also reviewed the linked product pages cited below. The inventory covers the feature families and add-ons advertised there, including paid capabilities. It is not a test of Square's signed-in software, hardware or banking eligibility.

The industry filters rearrange the comparison for different businesses. A checkmark indicates plan availability; it does not remove processing charges, third-party charges, hardware requirements or eligibility conditions. Product-specific pages can show legacy or differing price examples; use the current unified comparison for the plan snapshot below. Recheck prices before publishing competitive advertising.

## Commercial baseline

| US plan | Monthly software, per location | In-person card | Online card |
| --- | ---: | ---: | ---: |
| Free | $0 | 2.6% + 15¢ | 3.3% + 30¢ |
| Plus | $49 | 2.5% + 15¢ | 2.9% + 30¢ |
| Premium | $149 | 2.4% + 15¢ | 2.9% + 30¢ |

Pro offers negotiated terms; businesses processing over $250,000 annually may qualify. The tiers progressively add advanced operations, customer retention and support. [Square plans](https://squareup.com/us/en/pricing), [payment fees](https://squareup.com/us/en/payments/our-fees).

| Other charge | Current published amount |
| --- | --- |
| Online API | 2.9% + 30¢ |
| Keyed/card on file | 3.5% + 15¢ |
| ACH invoices | 1%, $1 minimum; $10 cap on Plus/Premium |
| ACH API | 1%, $1 minimum, $5 cap |
| Afterpay | 6% + 30¢ |
| International cards | Additional 1.5% |
| Cash/check recording | Free |
| EBT | 1.8% + 5¢ |
| Bitcoin payments | Promotional 0% until 2027 |
| Gift-card loading | 2.5% Free/Plus; 0% Premium; funding payment fees can also apply |
| Bitcoin conversion | 1% Free/Plus; 0.5% Premium |
| Marketing texts | Plus: 500 included, then 3¢; Premium: 2,500, then 1.5¢ |
| Kitchen display software | Plus $30/device/month; Premium $20 |
| Kiosk software | $99/device/month; Lite iOS: Plus $50, Premium $30 |
| Restaurant inventory by MarketMan | $99/location/month on Plus/Premium |
| Hardware | Starts at $59 |
| Payroll, outside our scope | Starts at $35/month + $6/person |

Fee sources: [payment fees](https://squareup.com/us/en/payments/our-fees), [plan/add-on matrix](https://squareup.com/us/en/pricing), [gift cards](https://squareup.com/us/en/gift-cards), [hardware](https://squareup.com/us/en/hardware), [payroll](https://squareup.com/us/en/payroll). Figures are a dated snapshot, not a quote.

## Where Nuclear stands

Assessment is against repository code and current project notes, not marketing promises. Existing backend functionality still needs production and user-journey validation.

| Area | Existing foundation | Material gap |
| --- | --- | --- |
| Money | Wallet payments/sends, immutable money transactions, limits, idempotency, refunds, merchant close-out | Production funding and bank return journeys; end-to-end customer experience |
| Merchant portal | Business onboarding/review, catalog, categories, discounts, basic stock, orders, transactions, staff, terminals, Orbs, refund approvals, profile and payout bank | Full checkout application and deeper business operations |
| Tips | Payment attribution to staff, immutable tip records, staff visibility and reporting/download | Checkout tip prompts, pooling policies, commission rules and payout workflow; attribution is not disbursement |
| Settlement | Cross River integration, signed webhooks, instant-to-ACH fallback; sandbox ACH completion exercised | Successful instant payout and return-event journeys, production readiness and operational recovery |
| Terminal | Swift package for API, models, Orb protocol, reliability and cryptography | SwiftUI POS app, complete Bluetooth integration, receipt/peripheral UX |
| Orb | Rust core state machine, pairing/reset/payment protocol, animations, audio scheduling and secure-channel primitives | Board support, physical BLE/NFC/LED/audio drivers, key storage, OTA and hardware verification |
| Consumers | Wallet, tag and account APIs | Consumer UI and Apple/Google pass issuance/integration |
| Employers | Benefits portal, CSV/API distribution and claim flows | Adoption rollout; this is not payroll |
| Administration | Approval, support, audit, reconciliation and security tooling | Merchant-facing CRM is a different feature; support operations need launch procedures |

The API is still configured for sandbox funding. A bank sandbox round trip does not establish live-money readiness. Hardware Rev D is an engineering draft. The current secure-channel code is not proof of encryption on a physical Orb-to-terminal link.

Repository evidence: [AGENTS.md](../AGENTS.md), [PROGRESS.md](PROGRESS.md), [TABLES.md](TABLES.md), [merchant portal](../apps/merchant-portal/src), [terminal](../apps/merchant-terminal), [Orb firmware](../apps/orb-firmware), [ORB.md](ORB.md), [hardware](../hardware).

## Capability backlog

**Partial** means there is relevant code, but the complete merchant workflow is missing. **Missing** means no complete implementation was found in this review. **Partner** means delivery depends on an external provider or a separate product decision. These are proposed work packages, not release-date commitments.

Priorities reflect the merchant review below: **P0** blocks the chosen launch workflow; **P1** materially improves adoption and daily operation; **P2** expands into a new operating model; **P3** is advanced or partner-dependent expansion. **P0 core / P1–P2 extensions** means only the specified core is a launch gate. These labels are a proposed sequence, not a commitment to launch every industry at once.

## Merchant-first priority review — October 30, 2026

### Target and launch assumption

Our current merchant site names independent cafés, shops/retail and restaurants. The employer-benefits strategy favors useful acceptance near employees' workplaces and homes. On that evidence, the proposed first cohort is **single-location cafés, takeaway/counter-service food businesses and small shops**. Full-service restaurants remain a target, but need a separate readiness gate. Salons/appointments, large chains and merchant lending do not belong on the first cohort's critical path. AI-agent payments remain ecosystem scope, not a prerequisite for a cashier serving a queue.

This first-cohort ordering is a recommendation, not an owner-confirmed restriction. Validate it with actual pilot merchants before assigning release dates. Select businesses with recurring customer visits and funded Nuclear users nearby; free software alone does not create paying customers.

### Decide which trading workflow we are shipping

| Mode | Merchant's experience | Required boundary |
| --- | --- | --- |
| **Nuclear alongside an existing POS** | Merchant rings the sale in their current POS, then takes the exact final amount through Nuclear and records Nuclear as a tender there. | Current POS remains the source for item/tax calculations. Nuclear preserves the total and external order reference, provides payment evidence and reconciles payouts. Confirm the POS can record an external tender. Manual double entry is a pilot constraint, not a scalable integration. |
| **Nuclear as the shop's POS** | Merchant builds the basket, calculates taxes, accepts tenders, produces receipts and closes the day in Nuclear. | Native taxes, catalog, relevant modifiers/variants, discounts, refunds, staff access and reporting are mandatory. Cash recording is a gate for a cash-accepting pilot; normal card payments need an explicit existing-terminal/provider workflow. |

Recommended sequence: prove the alongside-POS payment journey with a limited cohort while completing native checkout. Do not describe that pilot as a replacement for Square. A shop cannot stop serving non-Nuclear customers because our wallet network is new. Record all tenders for a standalone POS, or clearly retain the existing POS as the complete sales record. Recording a card sale is not processing it, and recording an external sale must not credit the Nuclear wallet balance.

### Ranked first-release requirements

The rank is implementation dependency order; every applicable P0 requirement must pass before the selected cohort goes live.

| Rank | Merchant's question | Minimum outcome | Backlog |
| --- | --- | --- | --- |
| 1 | Can customers actually use this here? | Approved merchant, working customer signup/access, cleared funding or funded benefits, readable credential and an understood way to serve customers using other tenders. No checkout-queue onboarding requirement. | PAY-01/02, BNK-02, OPS-01 |
| 2 | Can I charge the correct total? | Native tax setup and accurate basket calculation for standalone POS; verified final total from the source POS for companion acceptance. Taxes must be visible before authorization. | PAY-03 |
| 3 | Can my cashier ring up our actual menu/products quickly? | Search/favorites, quantities, correct prices, basic variants/modifiers, unavailable items and straightforward discounts. No forced extra forms on ordinary sales. | RET-01, RES-01, PAY-04 |
| 4 | Did this customer pay, once? | Reliable tap/app confirmation, recovery after disconnect, decline/insufficient-funds handling, cancellation and durable payment lookup. Never ask for a second payment while the first result is unresolved. | PAY-01/02, OPS-01/05 |
| 5 | Can I give proof and fix a mistake? | Accessible receipt with item/total/tax detail where Nuclear owns the order; linked source-POS receipt where it does not. Transaction lookup, void-before-payment and permitted refunds with correct tax/tip treatment. | CRM-05, PAY-04 |
| 6 | Can my team operate safely? | Individual staff identity, cashier/manager permissions, safe staff switching, refund authority and auditable actions. Do not require sharing the owner's password. | STF-01, OPS-05 |
| 7 | Can customers leave a tip? | Optional suggested/custom/no-tip choices before approval for tipping businesses; attribution and tip totals. Automatic gratuity and pooling are separate extensions. | PAY-05, STF-03 |
| 8 | Where is my money? | Correct merchant balance, clear payout status/timing, bank verification, failed/returned payout handling and daily sales-to-bank reconciliation. | BNK-01/02, RPT-01 |
| 9 | Can I account for every sale today? | Gross sales, discounts, refunds, taxes, tips, tender breakdown and net payout, with export. Cash opening/closing and discrepancy handling when replacing a cash-accepting POS. | RPT-01, PAY-06 |
| 10 | What happens when the connection or Orb fails? | Clear blocked state, recovery and support contact. Existing POS/card/cash fallback remains usable. Offline wallet debits require separate approval/design. | PAY-10, OPS-01/03/06 |
| 11 | Can I get set up without rebuilding everything? | Guided tax/bank/staff/device setup and assisted catalog import, plus a practiced first sale, refund and close-out. | RET-06, OPS-06 |
| 12 | Will there be a reason to keep using it? | Nearby funded users and merchant discovery/acceptance information for the pilot; follow with simple repeat-visit rewards and merchant-funded offers. | PAY-02, CRM-02/03; employer adoption |

### Business-specific gates

| Business | Needed before replacing its POS | Can follow later |
| --- | --- | --- |
| Café / takeaway | Size/milk/add-on choices and price changes; taxable/exempt item treatment; fast repeat checkout; optional tips; item unavailable toggle; order identifier and a workable preparation handoff. | Timed menus, advanced kitchen analytics, ingredient costing, kiosk and delivery aggregation. If staff require printed tickets or KDS to prepare orders, that handoff becomes a pilot gate. |
| Small retail shop | Product/variant lookup, quantities, tax, discounts, returns, basic stock changes and import. Barcode scanner/labels are gates where the actual shop relies on them. | Supplier purchasing, transfer orders, stock aging, sophisticated bundles and multi-location inventory. |
| Full-service restaurant | Open checks, table/server assignment, split checks, preparation routing, relevant service charges, tip accounting and manager close. | Advanced coursing, reservation integrations, ingredient purchasing and drive-through tools. If these first-column workflows are absent, offer companion acceptance rather than a restaurant POS replacement. |
| Service/appointment business | Taking payment can use the common flow; replacing scheduling software requires booking, availability, reminders, cancellation/deposit policies and any essential resource allocation. | Classes, packages, discovery marketplace and advanced capacity optimization. |
| Online-first merchant | Order-linked hosted checkout, final tax/total from the correct source, payment confirmation/status recovery and reliable server notification before fulfillment. | Nuclear-built site editor, shipping integrations, SEO tools and marketing automation. Online checkout moves to P0 if an online merchant is in the first cohort. |

### Tax capability: the launch-sized requirement

**Taxes are P0 for native checkout.** Configuration, checkout math, refunds and reporting must ship together. A tax field alone does not meet the requirement.

- Merchant portal tax settings: name, percentage, applicable location, all-taxable-items versus selected-item application, enabled state, and tax-added versus tax-included pricing. Keep item taxability/category explicit; do not treat every product as taxable.
- Carry the selected item tax treatment into the terminal and compute the authorized total on the server. Use a defined decimal/integer rounding rule; test mixed baskets and discount allocation. Support the actual pilot's required tax components; if compound or special taxes are unsupported, do not onboard that checkout configuration yet.
- Store the rate/rule and resulting tax amounts on the original order/lines so later rate or catalog changes cannot rewrite historical receipts and reports. Corrections use an auditable new version or operation.
- A refund reverses the applicable original tax allocation, not today's rate. Preserve existing refund restrictions, including the current full-refund requirement for tipped payments, until explicitly changed.
- Reports separate taxable sales, exempt sales, tax collected and tax refunded. Include the collected tax in merchant settlement under the proposed ordinary-POS model; provide records for the merchant's filing process. Tax remittance and marketplace classification require their own approved scope.
- Manual, merchant-confirmed tax rates are a reasonable first implementation for a supported in-store pilot. Automatic nationwide determination and online destination-tax calculation are separate work. Do not silently reuse an in-store rate for all shipped orders.

For companion acceptance, the existing POS can remain the tax calculator and receipt source; Nuclear still needs an exact approved final amount, a source-order reference and unambiguous reporting. This is a limited integration path, not a reason to defer taxes in native POS.

### Priority changes from the initial Square inventory

Promote **basic** catalog choices/modifiers, item availability, staff permissions, receipts, daily reconciliation, recovery and assisted import to the applicable P0 path. Separate them from advanced features that previously shared the same row. Keep simple stock control, loyalty, offers, customer history, basic invoice/payment links and merchant online checkout close behind at P1. Advance a conditional feature to P0 whenever a named pilot merchant cannot complete its ordinary day without it.

Defer full site-building, booking-suite replacement, purchasing, multi-location transfers, workforce scheduling, extensive marketing and AI to their relevant expansion phases. Payroll stays excluded. Card/BNPL/banking products remain separate decisions. Branch management is P2 for the proposed single-location cohort; customer wallet funding and merchant payout reliability remain P0.


### 1. Checkout and payment acceptance

Square covers card-present and phone acceptance, stored/keyed cards, bank payments, Cash App Pay and Afterpay, alongside adjustments and return workflows. [Square payments](https://squareup.com/us/en/payments/our-fees).

| ID | Nuclear work required | State | Priority |
| --- | --- | --- | --- |
| PAY-01 | Ship the terminal app: sign-in, device activation, catalog/cart, payment request, Orb pairing, scanning, cancellation, timeout and clear success/failure states. | Partial | P0 |
| PAY-02 | Complete customer onboarding/access, cleared funding or funded benefits, credential assignment, balance visibility and app-confirmed checkout. Core supported credential journey is P0; Apple/Google pass rollout can follow at P1 unless required by the selected pilot. | Partial | P0 core / P1 passes |
| PAY-03 | Ship merchant tax settings, location/item applicability, included/added pricing, exemptions, server-side rounding, original tax snapshots, refund allocation and tax reports. Native POS requires this at launch; companion acceptance can use a verified total and receipt from its source POS. | Partial: settings, item taxability, added/included pricing, server rounding and order snapshots built 2026-10-31 (migration 0012, tests/tax.e2e.mts); refund allocation, tax reports and per-location rates still open | P0 native POS |
| PAY-04 | Finish discount, void and full/partial refund UX, permissions and receipts. Keep refund-to-original-wallet and negative-merchant-balance rules; current tipped-payment refunds require a full refund. | Partial | P0 |
| PAY-05 | Ship optional tips, suggested/custom/no-tip choices and staff attribution for tipping pilots. Add separate service-charge and automatic-gratuity policies only as the merchant workflow requires; never hide them in the total. | Partial | P0 tipping / P2 advanced |
| PAY-06 | Record cash/check/other tenders and reconcile them separately from Nuclear funds. Cash-accepting standalone pilots need opening float, cash movements and close discrepancies at launch; companion acceptance can retain these in its source POS. | Missing | P0 cash POS / P1 otherwise |
| PAY-07 | Implement exchanges, merchant-specific store credit, deposits, age-check prompts and cross-location returns with permissions and liability tracking. | Missing | P1–P2 |
| PAY-08 | Decide whether to integrate a card acquirer for EMV, phone Tap to Pay, online cards, saved cards and bank invoice collection. Orb/pass acceptance alone does not provide these services. | Partner | P3 / launch fallback required |
| PAY-09 | Evaluate Cash App Pay, BNPL, EBT and bitcoin separately. Do not present them as automatically included or promise their underlying fees are $0. | Partner | P3 |
| PAY-10 | Ship clear network-loss states, payment-status recovery and a practiced alternate-tender workflow. Add cached catalog/draft carts next; wallet authorization stays online until an explicit offline-risk model exists. | Missing | P0 recovery / P1 cache |

Square's offline card acceptance has reconnect deadlines and merchant loss exposure. Its advertised offline mode is not evidence that an offline Nuclear wallet debit is safe. [Square offline terms](https://squareup.com/help/us/en/article/7777-process-card-payments-with-offline-mode).

### 2. Catalog, inventory and retail operations

Square's retail offer spans catalog creation, stock control, purchasing and multi-location operations. [Square Retail](https://squareup.com/us/en/point-of-sale/retail).

| ID | Nuclear work required | State | Priority |
| --- | --- | --- | --- |
| RET-01 | For the selected pilot, ship basic variants/options, SKU or barcode lookup where essential, quantities and fast search/favorites. Add broader GTIN automation, advanced image tools, bundles and price schedules later. | Partial | P0 basics / P1 extensions |
| RET-02 | Make stock movements auditable: receiving, sales, returns, damage, adjustments, reservations, low-stock notifications and physical counts. | Partial | P1 / P0 stock-dependent retail |
| RET-03 | Add suppliers, purchase orders, costs, receiving against orders, bulk intake and purchase-order imports. Support barcode labels from products and receiving. | Missing | P2 |
| RET-04 | Add merchant locations, location-specific stock/prices, transfers, fulfillment routing and return permissions when expanding beyond the single-location cohort. Do not represent each branch as an unrelated merchant account. | Missing | P2 |
| RET-05 | Derive COGS, margin, stock aging, sell-through, vendor sales and projected profit from recorded costs and movements. | Missing | P2 |
| RET-06 | Provide assisted catalog import/migration for pilot onboarding, then self-service bulk tools and optional Shopify/Thrive-style connectors. Surface sync conflicts rather than silently overwriting stock. | Missing / Partner | P0 assisted import / P2 connectors |

### 3. Restaurants, kitchen and self-service

Square provides front-of-house, kitchen and ordering workflows, with separate KDS/kiosk software charges. [Square Restaurants](https://squareup.com/us/en/point-of-sale/restaurants).

| ID | Nuclear work required | State | Priority |
| --- | --- | --- | --- |
| RES-01 | Ship basic priced modifiers, required choices and unavailable-item handling for café/food pilots. Extend into advanced choice constraints, timed menus, bulk menu edits and guided ordering. | Partial | P0 food basics / P1 advanced |
| RES-02 | Build open checks, named tabs/house accounts, numbering, transfer/merge/split/reopen flows and server ownership. These are launch gates for full-service POS replacement, not the proposed counter-service pilot. Define holds before bar-tab preauthorization. | Missing | P2 / P0 full-service POS |
| RES-03 | Add floor plans, tables, seats, courses, kitchen firing and send-without-leaving-check behavior; integrate reservations if needed. | Missing | P2 / P0 full-service essentials |
| RES-04 | Add tableside order entry and QR ordering/payment, order-ready notifications, pickup queues, drive-through lanes and third-party delivery order ingestion. | Missing / Partner | P2 |
| RES-05 | Build a kitchen display with routing, timers, bump/recall, printer fallback and kitchen-performance reporting; no Nuclear software device subscription in the proposed model. | Missing | P2 / P0 if kitchen-dependent |
| RES-06 | Build a locked-down self-service kiosk, accessible checkout and remote device configuration. Hardware and device management costs need explicit funding. | Missing | P2 |
| RES-07 | Add recipe/ingredient inventory, yields, waste and food-cost purchasing workflows as the MarketMan-equivalent expansion. | Missing | P3 |
| RES-08 | Add party-size gratuity policies, shift/section reporting and manager close procedures. Distinguish tips, service-charge revenue and wages. | Partial | P0 close / P2 advanced |

### 4. Booking and service businesses

Square supports appointments, booking distribution, client communication and advanced scheduling. [Square Appointments](https://squareup.com/us/en/appointments).

| ID | Nuclear work required | State | Priority |
| --- | --- | --- | --- |
| BKG-01 | Create services, staff calendars, availability, booking website/widget and customer booking/cancellation/rescheduling flows. | Missing | P2 |
| BKG-02 | Handle deposits/prepayment, booking checkout, attached forms/contracts, cancellation/no-show policies and authorization evidence. | Missing | P2 |
| BKG-03 | Add service processing gaps, multi-staff bookings, daily caps, class capacities/packages, waitlists and multi-location availability. | Missing | P2 |
| BKG-04 | Reserve rooms/chairs/equipment without double booking; add future-booking, service-cost and staff-performance reports. | Missing | P2 |
| BKG-05 | Send reminders/confirmations; support customer replies and changes, notification templates, calendar sync, social/search booking links and a booking API. | Missing / Partner | P2–P3 |
| BKG-06 | Evaluate a consumer service-discovery experience comparable to Square Go; keep marketplace discovery separate from basic appointment software. | Missing | P3 |

### 5. Merchant ecommerce and fulfillment

Square combines a site builder with commerce, ordering and fulfillment. Nuclear's own tag shop is not merchant ecommerce. [Square Websites](https://squareup.com/us/en/online-store).

| ID | Nuclear work required | State | Priority |
| --- | --- | --- | --- |
| WEB-01 | Publish merchant storefronts sharing catalog, customer identity, prices, inventory and orders with POS; complete wallet checkout. | Partial backend | P1 checkout / P2 storefront |
| WEB-02 | Add site themes/editor, SEO, merchant domains, multiple sites, password pages, age gates, embeds/video and social links. | Missing | P2 |
| WEB-03 | Support pickup, delivery zones/times, scheduled restaurant/retail preorders, QR menus, order status and customer accounts. | Missing | P2 |
| WEB-04 | Add shipping zones, label purchase/printing, negotiated-label integration, live rates and shipment tracking. Postage remains a real expense. | Missing / Partner | P2 |
| WEB-05 | Add coupons, synchronized discounts, delivery/shipping thresholds, cart recovery, reviews, item badges, quantity caps and scheduled publishing. | Missing | P2 |
| WEB-06 | Add quick checkout, timed categories, product bundles and recurring orders/subscriptions with explicit renewal authorization. | Missing | P2 |
| WEB-07 | Integrate external storefronts, Google ordering and delivery providers as needed. Evaluate voice ordering separately; Square advertises it as beta. | Missing / Partner | P3 |

### 6. Customers, loyalty and gift value

Square offers a merchant customer directory, segmentation, rewards and physical/digital gift products. [Customer Directory](https://squareup.com/us/en/point-of-sale/features/customer-directory), [Loyalty](https://squareup.com/us/en/software/loyalty), [Gift Cards](https://squareup.com/us/en/gift-cards).

| ID | Nuclear work required | State | Priority |
| --- | --- | --- | --- |
| CRM-01 | Build merchant-scoped customer profiles with purchase history, notes, preferences, consent, import/export and segments. A Nuclear account is not permission to expose its entire history to every merchant. | Missing | P1 |
| CRM-02 | Build configurable visit/spend/item/category rewards, redemption and promotions; handle refunds, expiry and abuse without altering money transaction semantics. | Missing | P1 |
| CRM-03 | Add merchant-funded offers and coupons with eligibility, budget, redemption reporting and attribution. Keep employer allowance principal separate. | Missing | P1 |
| CRM-04 | Add merchant-specific physical/eGift issuance, gifting, redemption and liability reports. Decide transfer/refund/expiry rules; existing NFC credentials are not automatically merchant gift cards. | Missing | P2 |
| CRM-05 | Provide accessible payment receipts at launch, with item/tax detail when Nuclear owns the order or a linked source-POS receipt in companion mode. Add reward status when loyalty ships; receipt delivery must not force marketing signup. | Missing | P0 receipts / P1 rewards |

### 7. Messaging, marketing and reputation

Square combines campaigns, automations and an inbox with email/SMS and additional phone-related functions. [Marketing](https://squareup.com/us/en/marketing), [Messages](https://squareup.com/us/en/messages).

| ID | Nuclear work required | State | Priority |
| --- | --- | --- | --- |
| MKT-01 | Build email/push campaigns, templates, audience selection, scheduling, recurring/lifecycle campaigns, opt-out and attributed redemption reporting. | Missing | P2 |
| MKT-02 | Add service-message inbox/replies, DND/business hours, attachments/PDFs and safe customer-contact permissions. | Missing | P2 |
| MKT-03 | Evaluate business numbers, SMS outreach, call-to-text and voicemail transcription; set explicit usage budgets before including them for $0. | Partner | P3 |
| MKT-04 | Add review monitoring, lead-capture forms/popups, branded receipt templates and campaign dashboards. | Missing / Partner | P2 |

### 8. Invoices, estimates, contracts and projects

Square supports recurring billing, customer documents and project-based collections. [Invoices](https://squareup.com/us/en/invoices), [Contracts](https://squareup.com/us/en/contracts).

| ID | Nuclear work required | State | Priority |
| --- | --- | --- | --- |
| INV-01 | Add invoice numbering, line items/taxes, due dates, shareable payment links, delivery, reminders, status and receipts. A checkout request alone is not an invoice system. | Missing | P1 |
| INV-02 | Add recurring/batch invoices, deposits, milestones/payment schedules, custom fields and reusable templates. Renewed charges require suitable authorization. | Missing | P2 |
| INV-03 | Add estimates with alternative packages, customer acceptance, version history and conversion into an invoice. | Missing | P2 |
| INV-04 | Add contract templates, custom fields, e-signature evidence, signature-before-payment gates and project document/workspace views. | Missing | P2 |

### 9. Staff operations

Square's staff tools extend beyond staff access to attendance, scheduling and compensation records. [Square Shifts](https://squareup.com/us/en/staff/shifts).

| ID | Nuclear work required | State | Priority |
| --- | --- | --- | --- |
| STF-01 | Ship individual staff access, cashier/manager permissions, safe switching and refund controls at launch. Add configurable permission sets, multi-location scope and badge options later. | Partial | P0 basics / P1 extensions |
| STF-02 | Add clock-in/out, breaks, corrections, overtime summaries, shift schedules, leave requests and shift swaps. | Missing | P2 |
| STF-03 | Ship staff tip attribution and reconciled tip exports for tipping pilots. Add pooling/commission policies and correction workflows later; recording tips is not paying wages. | Partial | P0 attribution / P2 pooling |
| STF-04 | Add new-hire setup, staff documents, team announcements/chat and file sharing with retention/access controls. | Missing | P2–P3 |
| STF-05 | Export approved attendance/tip records to outside payroll tools if useful. Nuclear payroll, tax filing, wage disbursement and workers' compensation remain excluded. | Excluded / optional export | — |

### 10. Reports, owner dashboard and AI

Square offers mobile/web visibility and sales/customer reporting across operations. [Square Analytics](https://squareup.com/us/en/point-of-sale/features/dashboard/analytics), [Square AI](https://squareup.com/us/en/ai).

| ID | Nuclear work required | State | Priority |
| --- | --- | --- | --- |
| RPT-01 | Expand Overview into reconciled sales, refunds, discounts, taxes, tips, tenders and settlement reports, with date/location/staff filters and CSV export. | Partial | P0 daily totals / P1 depth |
| RPT-02 | Add custom business-week/day boundaries and scheduled sales summaries. Keep reporting calendars separate from existing financial limit/reset rules. | Missing | P1 |
| RPT-03 | Add deferred revenue, catalog/menu results, live shift/section views, close-of-day, kitchen, invoices, booking, labor, inventory and ecommerce reports as their source workflows ship. | Partial | P2 |
| RPT-04 | Add website traffic/conversion, campaign performance, returning-customer and product profitability views with traceable definitions. | Missing | P2 |
| RPT-05 | Evaluate natural-language business insights with merchant-scoped read access, disclosed uncertainty and per-merchant compute budgets. AI must not invent totals or move money. | Missing | P3 |

### 11. Settlement, banking and financing

Square markets checking/debit access, savings automation, earlier deposits, delivery-platform payouts, credit and bitcoin services. These have separate institutions, terms and eligibility. [Square Banking](https://squareup.com/us/en/banking).

| ID | Nuclear work required | State | Priority |
| --- | --- | --- | --- |
| BNK-01 | Complete settlement status UX: eligible balance, cutoff, expected arrival, bank failure/return, retries, negative-balance collection and reconciliation. Prove production behavior before advertising settlement speed. | Partial | P0 |
| BNK-02 | Complete production bank linking and customer funding with finality/return policies and clear pending-fund visibility; pending loads are not immediately spendable. | Partial | P0 |
| BNK-03 | Evaluate optional instant payouts and display actual eligibility/cost. A credited internal balance is not money delivered to an external bank. | Partial / Partner | P1 |
| BNK-04 | Treat merchant checking/debit cards, yield-bearing savings, automated savings, early ACH availability and delivery-provider payouts as separate partner products. | Partner | P3 |
| BNK-05 | Treat business lending and bitcoin receipt/conversion as separate decisions, not ordinary free software features. Existing approved wallet credit is not a merchant lending product. | Partner | P3 |

Consumer cash-out remains outside the agreed model. Merchant settlement is an existing permitted flow. Do not turn the internal pooled-bank accounting into an advertised consumer checking account by analogy with Square.

### 12. Hardware, platform, security and support

Square sells readers, handhelds, terminals, registers, stands, kiosks and accessories, alongside developer integrations. [Hardware](https://squareup.com/us/en/hardware), [Developer platform](https://developer.squareup.com/us/en).

| ID | Nuclear work required | State | Priority |
| --- | --- | --- | --- |
| OPS-01 | Finish and test Orb electronics/firmware, terminal integration, secure pairing/reconnect, battery reporting, prompts, payment indications and update/recovery procedures. | Partial | P0 |
| OPS-02 | Support the actual pilot's required printer/scanner/cash-drawer handoff at launch, or explicitly retain the source POS for it. Expand the compatibility matrix and customer displays later; new handheld/register products are separate decisions. | Missing / Partner | P0 required peripherals / P1–P3 breadth |
| OPS-03 | Ship basic device readiness, disconnect/battery visibility and replacement/reconnect guidance for the pilot. Expand remote configuration, fleet version inventory and signed update operations with hardware rollout. | Partial | P0 readiness / P1 fleet |
| OPS-04 | Publish merchant developer documentation, sandbox credentials, scoped authorization, webhooks, SDKs, integration testing and eventual partner/app discovery. Internal endpoints/MCP alone are not a public integration platform. | Partial | P2–P3 |
| OPS-05 | Establish fraud monitoring, security reviews, data retention, recovery, incident response, backups and measured operational availability. Validate real-device encryption and key protection. | Partial | P0 |
| OPS-06 | Ship guided onboarding, assisted import, help/contact, support escalation and a device fallback/replacement process for the pilot. Expand support channels/hours later; do not advertise 24/7 before staffing it. | Partial | P0 pilot / P2 breadth |

Square's support tiers differ: Free phone support is limited to the first 90 days during weekday hours; Plus retains weekday phone support; Premium advertises 24/7 phone support. All list chat/email. [Support comparison](https://squareup.com/us/en/pricing).

## What $0 must mean

| Category | Proposed Nuclear treatment |
| --- | --- |
| Business software | $0/month for native features in this backlog; no paid upgrade merely to unlock inventory, loyalty, booking, reports, staff or additional native software screens. |
| Locations and software devices | Target no subscription per branch, terminal, KDS or kiosk; measure the cost of serving large fleets. |
| Nuclear wallet payment | 0% merchant processing under the current direction; funding, bank operations and fraud losses still cost Nuclear money. |
| Card payments and external rails | Separate provider integration and published commercial terms; do not imply 0% card-network processing. |
| Messaging, voice and AI | Use in-app/push and budgeted usage first. Publish fair-use allocations or external costs before launch; unlimited carrier/AI usage is not funded by a $0 sticker price. |
| Hardware, shipping and consumables | Separately priced or explicitly subsidized; software parity does not mean free tablets, Orbs, printers, paper or postage. |
| Banking/credit/BNPL | Partner eligibility, licensing and economics require separate decisions. Never use custody principal as revenue. |
| Employer benefits | $0 PEPM and free platform/API/CSV access remain adopted policy. No payroll expansion. |

We should compete on a free native software suite, not imply Square's entire external ecosystem can be reproduced at no cost. Build native equivalents where sensible; do not promise free access to another vendor's paid service.

Before making the offer public, measure cost per active merchant and per wallet payment: banking and funding fees, returns/fraud, infrastructure, email/SMS, support, device replacements and incentives. Model quiet and high-volume merchants, multiple locations and abuse. Identify the separate revenue or subsidy that covers those costs; merchant balances and employer allowances are liabilities, not operating income.

## Recommended build sequence

1. **P0 — complete the selected pilot's trading day.** In dependency order: usable funded customers and onboarding; correct totals/taxes; fast catalog/modifiers; reliable terminal/Orb payments; receipt/refund recovery; staff permissions; applicable tipping; bank settlement; daily reconciliation; device/network fallback; assisted setup. For companion acceptance, explicitly retain source-POS tax, tender and receipt responsibilities. For native POS, deliver them in Nuclear. Reuse scheme v2.
2. **P1 — make the first cohort want to stay.** Add stock depth, loyalty/offers, merchant-scoped customer history, richer reports, streamlined imports, basic invoices/payment links, merchant online checkout and broader supported credentials/peripherals. Build a repeat-visit business, not just a successful first tap.
3. **P2 — expand one operating model at a time.** Qualify full-service restaurants with checks/table/kitchen workflows; retail with purchasing/multiple locations; online commerce with fulfillment; service businesses with booking. Add workforce and marketing depth where those merchants need it. Each vertical has its own launch gates.
4. **P3 — ecosystem breadth.** Evaluate external acquiring/BNPL, advanced connectors, ingredient platforms, discovery/voice/AI and new banking products. These are separate decisions and must not delay the first cohort's reliable daily operation.

These phases are dependency order, not dates. Full Square ecosystem parity is a substantially larger scope than the current Nuclear payment platform. Do not label a P0 release full parity.

## Acceptance criteria before parity claims

- [ ] A new approved merchant can onboard, configure catalog/taxes/bank/staff, activate a terminal and pair an Orb without operator intervention.
- [ ] A customer can onboard, fund after clearance, pay in-store/online, receive a receipt and obtain a refund with correct limits and reconciled balances.
- [ ] Checkout survives cancel, timeout, duplicate callbacks, BLE loss and terminal restart without a duplicate charge or ambiguous final result.
- [ ] Tips, taxes, discounts and refunds reconcile from order through money transactions, reports and settlement, including negative merchant balances and current tip-refund restrictions.
- [ ] Concurrent sales cannot oversell reserved stock or double-redeem a reward; return and cancellation rules reverse downstream effects correctly.
- [ ] Bank completion, rejection, return, retry and instant-fallback events are proven and visible to operators and merchants.
- [ ] Staff/location/customer boundaries are enforced in APIs and exports, and physical-device encryption, key handling and recovery are tested.
- [ ] Every promoted vertical completes its real workflow: purchasing, kitchen service, booking, shipping or recurring invoice—not just a navigation screen.
- [ ] The $0 promise has published boundaries and measured costs; support and availability promises match actual staffing and operations.

## Maintaining this comparison

Update this document when a work package ships, when scope changes, or before quoting Square prices externally. Record implementation evidence and date; do not mark a feature complete from a schema field, a marketing sentence or an isolated backend endpoint. Financial behavior remains governed by the canonical policy/schema documents; this competitive backlog does not override them.
