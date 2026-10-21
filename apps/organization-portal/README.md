# Organization portal

The employer-facing web app (Vite + React, same look as the merchant portal). Hosted at https://nuclear-organization.a-space.workers.dev
(Worker `nuclear-organization`, static assets). It talks to `apps/api` only. An organization (account type `O`) funds its wallet and grants
benefits to employees; the money rules live in the API (see `docs/ORGANIZATIONS.md`).

- Sign in with email and password, or create an organization account (active at once). Right after the first sign-in a window asks it to choose **Fixed Benefits** (a schedule credits each employee's fixed amount automatically) or **Flexible Benefits** (credit when and how much it chooses); it can change this later.
- Pages: **Overview** (wallet with Add Funds, employees claimed and not yet, money held for unclaimed), **Employees** (search, status, remove, and checkboxes with an action bar to mass edit: set or clear fixed benefits, remove; in Fixed mode a Fixed Benefit column, Upload Fixed Benefits and an Edit per employee), **Benefits** (the program card, a CSV upload with Ready to Run checks, the run history, and a page per run with claimed and not-claimed reports to download), **API** (the Benefits API key, shown once, and its documentation) and **Profile** (legal details, documents, sessions).
- No per-view Refresh buttons in this portal.

```
npm run org:dev      # http://localhost:5175 (the API allows this origin via ORG_ORIGINS)
npm run org:test
npm run org:build
npm run deploy -w @nuclear/organization-portal
```

`VITE_API_URL` overrides the API address.
