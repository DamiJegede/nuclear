# Admin portal

Internal operations app (Vite + React + TypeScript). It talks to `apps/api` only, through the operator
endpoints under `/v1/admin`, and holds no database access.

## What it does today

- **Overview**: the scheme balance (all money held, split consumers/merchants), number of users, number
  of merchants, and payments processed (sent, tapped, in-app, refunds, loaded) lifetime and today.
  A banner shows whether account balances and credit reconcile with the ledger. Refreshes every minute.
- **Tag models**: list models with sold, UIDs loaded and unassigned counts; add a model (starts `pending`).

## Hosted

https://nuclear-admin.a-space.workers.dev (Cloudflare Pages on the unified Workers platform; static files
from `dist/`, security headers from `public/_headers`, SPA fallback, preview URLs off). Deploy with
`npm run deploy -w @nuclear/admin-portal` (builds, then `wrangler deploy`; config in `wrangler.jsonc`).
The page's CSP only lets it call `https://nuclear-api.a-space.workers.dev`; change `connect-src` in
`public/_headers` if `VITE_API_URL` changes.

## Run it

```bash
npm run admin:dev        # http://localhost:5173
npm run admin:test       # component and client tests
npm run admin:build      # typecheck + production build into dist/
```

Sign in with the operator token (`ADMIN_API_TOKEN`; locally it is in `apps/api/.dev.vars`). It is kept in
`sessionStorage`, so it survives a refresh but is gone when the tab closes. Set `VITE_API_URL` (see
`.env.example`) to point at a different API; the default is the deployed Worker.

The API only answers browser calls from origins listed in its `ADMIN_ORIGINS` var (set to
`http://localhost:5173` for development). Add the portal's real URL there once it is hosted.

## Known limits

- One shared operator token, no per-person admin accounts or audit trail yet.
- The API must list the portal's origin in `ADMIN_ORIGINS` (it does) and be deployed with the stats endpoint.
