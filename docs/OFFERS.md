# Offers (built 2026-11-05, migrations 0016 and 0017)

A merchant's "buy X, get Y free or part price" deals: buy one get one free, buy 2 get the third half price, buy this and get another product free or half price. Owner decisions (2026-11-05): free **and** percent off are both supported; when more than one offer fits the same items the customer gets **the better one**; customers see offers before they order.

## The rule

One rule covers every case. An offer says: the customer buys `buy_qty` of a product, and gets `get_qty` of a product (the same one when `get_product_id` is empty) at `percent_off` (100 = free).

| Offer | buy_qty | get | get_qty | percent_off |
| --- | --- | --- | --- | --- |
| Buy one, get one free | 1 | same product | 1 | 100 |
| Buy 2, get the third half price | 2 | same product | 1 | 50 |
| Buy a starter, get a main half price | 1 | Salmon | 1 | 50 |

## How it prices an order

- **The server does it, always.** `app_offers(merchant, lines)` (SQL, migration 0016) takes the cart's priced lines and returns them with the offers applied. It runs for a checkout the POS creates (`quoteCart` calls it) and for a one-step payment (`app_pay_plan_base` calls it), then `app_tax` works out the sales tax on what is paid. A terminal, kiosk or app never works out its own offer, so every surface shows the same price.
- **Lines are split, not rewritten.** A product's units become a full-price line and, per offer, an offer-price line whose `discount` is the product's own discount plus the offer's share and which carries `offer: {id, name, percent_off}`. Tax, stock, refunds, receipts and reports keep working on ordinary lines. Stock counts every unit, free or not (the SQL groups by product).
- **A unit is used once**, as the thing bought or the thing given. For the same product, one set uses `buy_qty + get_qty` units; for two products it needs `buy_qty` of one and `get_qty` of the other.
- **The better offer wins.** The applicable offer that saves the customer most per set goes first (ties: the older offer) and is applied as many times as the basket allows, then the next best on the units that are left. It is a greedy rule, deterministic and easy to explain; it can miss a rare better combination.
- **Rounding:** the part price is rounded **down** (half of $9.99 is $4.99 off, so the customer pays $5.00). The offer works on the price after the product's own `discount`.
- **Tax:** worked out on what the customer pays, so a free unit carries none. The snapshot of each line stores the offer, so later changes never rewrite an old order.

## Time windows (migration 0017)

An offer can have a schedule, and it applies only while the schedule covers the moment the order is priced:

- **Days of the week** (`days`, ISO 1 = Monday to 7 = Sunday; none = every day; all seven is stored as none).
- **A time window** (`from_time` to `to_time`, both or neither, never equal). A window that ends before it starts runs past midnight and belongs to the day it started: Friday 10 PM to 2 AM covers Saturday 1 AM, not Friday 1 AM.
- **A date range** (`starts_on`, `ends_on`, either optional, first and last day included).
- **Times are New York time**, like every other day boundary in Nuclear (reports, close-out, daily limits). There is no per-merchant time zone yet, so a merchant outside the Eastern zone sets its hours in New York time.
- `offer_live(offer, at)` is the one definition; `app_offers(merchant, lines, at default now())` ignores offers that are not live at `at`. A checkout is priced when it is created and keeps that price if it is paid after the window closes. A one-step payment is priced when it is made.
- The API shows `schedule`, `schedule_text` ("Mon–Fri, 4 PM–6 PM") and `live_now` on every offer (merchant, terminal and public menu). The menu lists a scheduled offer with its hours and whether it is on now.

## Discounts in the reports

`GET /v1/business/report` adds `discounts` (every line's discount × units on completed payments: the products' own discounts and offers) and `offers` (the offers' part, from `offer.amount` stored on each offer line) to every day and the total; the Reports page has a Discounts card and column and the CSV has Discounts and Of which offers. They are **not reduced by refunds** (a refund returns what was paid; the discount was still given). `merchant_snapshots` carries `discounts_v` and `offers_v`; migration 0017 filled the days already snapshotted (it lifts the freeze trigger for that one update). Orders made before 0017 have no `offer.amount`, so their offer part reads 0 while their discount is counted.

## Refunds of offer lines

- A refund returns **what was paid for the units selected**: a paid unit returns its price (and its tax share), a unit an offer gave away returns $0.00. Mixed selections work and every selected unit can go back on the shelf (`restock`).
- A selection worth nothing (only free units) is refused with `nothing_to_refund` (it was `invalid_amount`); refund the units that were paid for.
- Returning only the paid unit of a buy-one-get-one pair refunds its price in full and the customer keeps the free one. That is the merchant's call at the counter; the order shows the offer on each line (`offer`, `net_price`) so staff can see it. A full refund returns everything that was paid.
- The terminal's order lookup and the merchant Orders page show each line's offer and "free".

- **Merchant portal:** an **Offers** page (Add Offer, Edit, Turn Off or On, Delete; a product search for both products; Free, Half price or Custom percent). API: `GET|POST /v1/business/offers`, `PATCH|DELETE /v1/business/offers/:id` (owner session; products must be the merchant's own; the name defaults to the rule in words).
- **Terminal:** `GET /v1/terminal/offers` lists the live offers. Checkout lines and the payment's items carry `offer`.
- **Table menu page** (`/t/<code>`, `GET /v1/menu/:code`): an Offers section, so customers see them before ordering.
- **Receipts:** a line shows the offer's name beside its price.

## Not built

- **Tabs:** offers are not applied to a shared tab. A tab's items belong to different members, so which member gets the free item needs its own rule; tab items keep the product's own `discount` only.
- **Limits:** no per-customer or per-day limits, no category or whole-order offers, no fixed-amount-off, no coupon codes (COMPETITION.md WEB-05) and no loyalty rewards (CRM-02).
- **Customer app screens:** the customer's app needs to show offers in its menu (the data is in the API).

## Data

`offers`: `id`, `account_id`, `name` (1-80), `buy_product_id`, `buy_qty` (1-20), `get_product_id` (null = the same product), `get_qty` (1-20), `percent_off` (1-100), `active`, `days`, `from_time`, `to_time`, `starts_on`, `ends_on` (the schedule, all optional), `created_at`, `updated_at`. Deleting a product deletes its offers. An inactive product's offers do not show on the menu or the terminal list, and they still price an order only while the products can be sold. Tests: `apps/api/tests/offers.e2e.mts`.
