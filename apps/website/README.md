# Nuclear website

Canonical directory: `/Users/dami/GitHub/nuclear/apps/website`.

One SolidJS application, built with Vite:

- `/` — the original video-background homepage, with no merchant links.
- `/merchant` — the approved merchant marketing page, shared by direct link.

`src/App.jsx` selects the route. `src/Home.jsx` preserves the video homepage and Safari playback recovery. `src/Merchant.jsx` contains the merchant page and reactive savings calculator; `src/merchant-behavior.js` handles the checkout demo, tabs, navigation, FAQ and enrollment dialog. Static brand, hologram and video assets live in `public/`.

From the repository root:

- `npm run website:dev` — http://localhost:4187/ and http://localhost:4187/merchant
- `npm run website:build` — produces `apps/website/dist/`

The existing Worker in `src/index.js` serves `dist/` with SPA fallback and preserves video range requests. No public deployment was performed for this conversion.
