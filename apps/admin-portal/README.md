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

Sign in with your **Access ID** and **Access Token**, then a **6-digit code from your authenticator app**.

- **Getting an account:** an existing admin adds you on the **Admins** page (or the operator runs
  `npm run add-admin -- --name "Your Name"`). The system generates your 12-character Access ID and
  32-character Access Token and shows them **once**, with a download button. It can never show the token
  again.
- **First sign-in:** replace the issued token with your own (32 characters or more; the **Generate** button
  makes a strong one, then save it in your password manager), then set up two-step verification by scanning
  a QR code (or typing the key) with an authenticator app and saving the ten recovery codes shown once. If you
  lose your phone, use a recovery code or ask an admin/the operator for a reset (`manage-admin --reset-mfa`).
- The session token (8 hours) is kept in `sessionStorage`, so it survives a refresh but is gone when the tab
  closes. Several wrong attempts lock the
account for 15 minutes. Set `VITE_API_URL` (see
`.env.example`) to point at a different API; the default is the deployed Worker.

The API only answers browser calls from origins listed in its `ADMIN_ORIGINS` var (set to
`http://localhost:5173` for development). Add the portal's real URL there once it is hosted.

## Known limits

- No audit log of who did what yet.
- Any admin can add admins, but disabling or resetting someone is the operator's job (scripts) for now; there are no admin roles.
- The API must list the portal's origin in `ADMIN_ORIGINS` (it does) and be deployed with the stats endpoint.
