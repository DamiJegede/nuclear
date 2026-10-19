# Merchant portal

The business-facing web app (Vite + React, same look as the admin portal). Hosted at https://nuclear-merchant.a-space.workers.dev
(Worker `nuclear-merchant`, static assets). It talks to `apps/api` only. It does not accept payments; it manages everything else.

- Sign in with email and password, or create a business account (it starts **pending** until an admin approves it).
- A pending or declined business sees only the review page: status, the reason if declined, and the document upload.
- Pages: Overview, Transactions, Orders, Catalog, Terminals, Orbs, Staff, Refunds, and Profile (the business name, top right).

```
npm run merchant:dev      # http://localhost:5174 (the API allows this origin via MERCHANT_ORIGINS)
npm run merchant:test
npm run merchant:build
npm run deploy -w @nuclear/merchant-portal
```

`VITE_API_URL` overrides the API address (see `.env.example`).
