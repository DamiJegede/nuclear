# Offers (built 2026-11-05, migration 0016)

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

## Where merchants and customers see it

- **Merchant portal:** an **Offers** page (Add Offer, Edit, Turn Off or On, Delete; a product search for both products; Free, Half price or Custom percent). API: `GET|POST /v1/business/offers`, `PATCH|DELETE /v1/business/offers/:id` (owner session; products must be the merchant's own; the name defaults to the rule in words).
- **Terminal:** `GET /v1/terminal/offers` lists the live offers. Checkout lines and the payment's items carry `offer`.
- **Table menu page** (`/t/<code>`, `GET /v1/menu/:code`): an Offers section, so customers see them before ordering.
- **Receipts:** a line shows the offer's name beside its price.

## Not built

- **Tabs:** offers are not applied to a shared tab. A tab's items belong to different members, so which member gets the free item needs its own rule; tab items keep the product's own `discount` only.
- **Reports:** no Discounts column yet (the merchant snapshots do not store offer discounts).
- **Refunds:** a refund of an offer line returns what was paid for it; a free unit (paid $0.00) has nothing to return, so refund the paid units.
- **Limits and schedules:** no time windows (happy hour), no per-customer limits, no category or whole-order offers, no fixed-amount-off, no coupon codes (COMPETITION.md WEB-05) and no loyalty rewards (CRM-02).
- **Customer app screens:** the customer's app needs to show offers in its menu (the data is in the API).

## Data

`offers`: `id`, `account_id`, `name` (1-80), `buy_product_id`, `buy_qty` (1-20), `get_product_id` (null = the same product), `get_qty` (1-20), `percent_off` (1-100), `active`, `created_at`, `updated_at`. Deleting a product deletes its offers. An inactive product's offers do not show on the menu or the terminal list, and they still price an order only while the products can be sold. Tests: `apps/api/tests/offers.e2e.mts`.
