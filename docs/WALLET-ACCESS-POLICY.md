# Wallet device access policy

Updated October 13, 2026. Schema/application plan; no implementation.

The primary account holder signs into their account and may share access to a wallet they own. Shared-wallet device access is not an account membership: wallets has no member_account_id. A recipient cannot sign in with their own account credentials to obtain shared-wallet access.

## Issue and redeem

1. An authenticated primary holder requests a link for a specific wallets.id. Backend verifies ownership and current wallet/account access; recipient devices cannot issue links or broaden permissions.
2. Backend first creates an unredeemed devices row with owner account_id, target wallet_id, NULL session_token_hash/session_expires_at and NULL revoked_at. Create a signed JWT with sub = wallets.id, device_id and jti = devices.id, a dedicated issuer and audience for wallet-link redemption, iat and exp = iat + 300 seconds. Include or persist the owner's authorization context and permitted scope. Do not put bank details or secrets in the claims; a signed JWT is not encrypted.
3. Form https://app.nuclear.us/magic-link/<token>. The holder sends or presents it to the intended recipient; the platform does not send messages without explicit authorization.
4. The target device validates/redeems through the backend. The server checks signature with a pinned allowed algorithm, issuer, audience, expiry, unrevoked issuance and current owner/wallet authorization. Atomically populate the initial session_token_hash and session_expires_at only if the referenced devices row is still unredeemed and unrevoked, and the row owner/wallet match the JWT and current authorization. Set expiry to server time + 90 days and last_accessed_at to server time. Return a cryptographically random session token to the client, storing only its unique hash. A replay fails the conditional update and cannot mint a second session.
5. A landing-page GET must not consume the link, since message previews may fetch it. Perform redemption as an explicit POST after the recipient opens/continues. Exchange for a session bound to the target browser/app installation. Expiry is enforced on the server when redeeming, not merely when loading the page.
6. Remove the bearer token from browser history after exchange, omit it from request/access/analytics logs, send no-referrer headers and avoid third-party resources on the redemption page. HTTPS is required.

The five minutes applies to link redemption; the resulting session lasts 90 days and is extended on every valid app launch as described below. Whoever obtains an unused bearer link can redeem it; issuing the URL does not itself prove the intended recipient's identity or bind it to a preselected device. Stronger intended-device binding requires an additional pairing/confirmation step, still an open product decision.

## Session scope and revocation

- Session authorizes only the target wallet and its permitted activity, with current wallet/account limits checked on every operation. Existing allow_pay/allow_send flags remain authoritative; no owner-level banking, funding, family administration or link issuance rights are inherited.
- Primary holder can list and revoke device access. Revocation of a wallet or account invalidates all affected links/sessions; revoked sessions cannot continue spending with a previously issued JWT.
- devices is the only device/session table: id, account_id, wallet_id, platform, push_token, session_token_hash, session_expires_at, revoked_at, created_at and last_accessed_at. No separate sessions table or session status column. Owner/wallet binding is immutable for each registration; new link issuance creates a fresh row.
- Logout or owner revocation sets revoked_at. Keep a non-NULL session_token_hash for a redeemed row; never reset it to NULL, which could reopen redemption. Token rotation, if used, replaces the hash. Expired or revoked registrations cannot redeem another link or extend their session.
- push_token is notification delivery only, not a device identity or authentication token. Current account/wallet authorization is checked on each request even while session expiry is valid.
- Transactions retain the original wallet/account and should record the authorized session/attempt through the eventual session/audit linkage. Do not recreate member_account_id for recipients.
- Use secure HttpOnly cookies for browser sessions where applicable, with CSRF protection on authenticated mutations; use protected app storage for native sessions.

## App-launch session extension

The client calls POST /v1/devices/session/extend every time the app launches, using the current session token. This is a rolling 90-day session, not a fixed maximum lifetime: regular valid launches can keep it active indefinitely unless revoked or otherwise restricted.

1. Hash the presented random token and resolve its unique devices row. Validate non-NULL session state, revoked_at IS NULL, current expiry > server time, and current owner/account/wallet authorization.
2. Atomically set session_expires_at to at least server time + 90 days (90 x 24 hours, timestamp arithmetic), and update last_accessed_at. Concurrent older requests must never shorten expiry. Guard the update against concurrent revocation, expiry or token rotation; extension never clears revoked_at.
3. Return the resulting expiry. Authentication failures do not extend access or create a session. An expired/revoked shared-wallet session requires a fresh primary-holder-issued link; a still-valid session may retry transient network failures without creating duplicate registrations.
4. Normal authenticated requests update last_accessed_at, but only this launch endpoint renews expiry. Offline launch cannot extend server state; do not manufacture a client-side renewal or authorize financial operations offline. The next online launch/retry must pass server checks.
5. Browser extension uses authenticated POST with CSRF protection; the redemption JWT is not accepted as a session/extension token.

This design uses a fresh devices row as the single-use grant for each link, with the hash changing from NULL exactly once. Failed/unredeemed grants can expire without becoming sessions. Primary-holder account login follows its own authenticated issuance path but uses the same hash/expiry/revocation representation; no delegated device gains owner login powers.

JWT validation reference: [RFC 8725](https://www.rfc-editor.org/rfc/rfc8725.html).
