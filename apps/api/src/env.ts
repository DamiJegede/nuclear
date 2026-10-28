export interface Env {
  HYPERDRIVE: Hyperdrive;
  /** R2 bucket for uploaded images (tag and shop pictures). */
  IMAGES?: R2Bucket;
  /** Public address of this API, put in front of image keys (e.g. https://nuclear-api.a-space.workers.dev). Unset = the address of the request. */
  PUBLIC_URL?: string;
  /** Cloudflare Images binding (wrangler `images`): resizes and compresses uploaded profile photos. */
  IMG?: ImagesBinding;
  /** Private R2 bucket `nuclear-uploads` for customers' and businesses' uploaded files (never public; admins download through the API). */
  UPLOADS?: R2Bucket;
  /** Cloudflare Email Service binding (send_email). Needs a verified sending domain; see EMAIL_FROM. */
  EMAIL?: { send(message: { from: string; to: string; subject: string; text: string }): Promise<unknown> };
  /** Sender address for system emails, on a domain verified in Cloudflare Email Service, e.g. "Nuclear <noreply@nclr.app>". Unset = emails are not sent (the text is kept in the audit log). */
  EMAIL_FROM?: string;
  /** HS256 secret for wallet magic-link JWTs. `wrangler secret put JWT_SECRET`; `.dev.vars` locally. */
  JWT_SECRET: string;
  /** Base URL used to build magic links and customer email links. Defaults to https://app.nuclear.us */
  APP_URL?: string;
  /** Where email links for business accounts open (the merchant portal). Falls back to APP_URL. */
  MERCHANT_PORTAL_URL?: string;
  /** Where email links for organization accounts open (the organization portal). Falls back to APP_URL. */
  ORG_PORTAL_URL?: string;
  /** "true" enables POST /v1/sandbox/fundings (simulated bank load). Never enable in live. */
  SANDBOX_FUNDING?: string;
  /**
   * Operator bearer token for scripts calling /v1/admin/* (tag models, supplier imports, creating
   * admin accounts). People use the portal with their own access id and password instead. Unset =
   * operator access is off. `wrangler secret put ADMIN_API_TOKEN`; `.dev.vars` locally.
   */
  ADMIN_API_TOKEN?: string;
  /**
   * AES-256 key (base64 of 32 random bytes) that encrypts admins' authenticator secrets at rest.
   * `wrangler secret put MFA_ENCRYPTION_KEY`. Without it admin MFA enrollment and sign-in return 503.
   */
  MFA_ENCRYPTION_KEY?: string;
  /** The banking server (the one machine on the bank's IP allowlist): its base URL and the shared secret that signs our calls to it (docs/CROSS-RIVER.md). Unset = bank lookups answer "unknown" and nothing is sent. */
  BANKING_URL?: string;
  BANKING_SECRET?: string;
  /** Tests and local runs: a ready-made banking client used instead of calling BANKING_URL. */
  BANKING_CLIENT?: import("./lib/banks").BankingClient;
  /** AES-256 key (base64, 32 bytes) encrypting bank routing and account numbers at rest. Losing it makes every stored number unrecoverable: keep a copy in the password manager. Without it, saving a payout bank returns 503. */
  BANK_ENCRYPTION_KEY?: string;
  /** The Orb fleet key (64 hex chars = 32 bytes, docs/ORB.md §8a): the same key is compiled into every Orb's firmware. Rotating it needs a firmware release. Without it `POST /v1/terminal/orb/bind` returns 503. */
  ORB_KEY_V1?: string;
  /** Browser origins allowed to call the business API from a browser (the merchant portal), comma-separated. */
  MERCHANT_ORIGINS?: string;
  /** Browser origins allowed to call the customer API from the organization portal, comma-separated. */
  ORG_ORIGINS?: string;
  /** Browser origins allowed to call /v1/admin/* (comma-separated), e.g. the admin portal's URL. */
  ADMIN_ORIGINS?: string;
  /** Today's running estimate for the admin Overview: the Durable Object namespace (class StatsCounter). Unbound = no estimate (zeros). */
  STATS?: { idFromName(name: string): unknown; get(id: unknown): { fetch(url: string, init?: { method?: string; body?: string }): Promise<Response> } };
  /** The rate limits' Durable Object namespace (class RateLimiter). Unbound = an in-memory limiter per Worker instance (local runs and tests only). */
  LIMITER?: { idFromName(name: string): unknown; get(id: unknown): { fetch(url: string, init?: { method?: string; body?: string }): Promise<Response> } };
  /** How many rate-limit objects share the keys (default 1, max 16). */
  LIMITER_SHARDS?: string;
  /** How many counter objects share the estimate (default 1, max 64). Reads sum all of them. */
  STATS_SHARDS?: string;
  /** Seconds the admin Overview's live numbers are cached (default 300). 0 = no caching: every read computes everything (tests, tiny deployments). */
  STATS_TTL_SECONDS?: string;
  /** Program daily associated-value cap in cents (draft target $2,000). Configurable until finalized. */
  DAILY_VALUE_CAP_CENTS?: string;
  /**
   * NTAG 424 DNA PICC-data keys by URL version, as 32 hex chars (AES-128). `TAG_KEY_V1` decrypts
   * tag URLs of the form https://tag.nclr.app/v1/<cipherHex>. `wrangler secret put TAG_KEY_V1`.
   */
  [key: `TAG_KEY_V${number}`]: string | undefined;
}

/**
 * owner = the account holder's own login; wallet = delegated shared-wallet device;
 * agent = an agent wallet's API key (acts like a wallet session, but has no device).
 */
export type SessionKind = "owner" | "wallet" | "agent";

export type SessionAuth = {
  /** Null for agent keys. */
  deviceId: string | null;
  accountId: string;
  kind: SessionKind;
  /** Set for wallet sessions and agent keys. */
  walletId: string | null;
};

/** A merchant terminal's own JWT session (terminals are not devices). */
export type TerminalAuth = {
  terminalId: string;
  accountId: string;
  allowRefunds: boolean;
};

/** Who is calling /v1/admin: the operator token (scripts) or a signed-in admin (the portal). */
export type AdminAuth =
  | { kind: "operator" }
  | { kind: "admin"; adminId: string; accessId: string; name: string; role: import("./lib/roles").Role; sessionId: string; mfaEnabled: boolean };

export type AppContext = {
  Bindings: Env;
  Variables: { auth: SessionAuth; terminal: TerminalAuth; adminAuth: AdminAuth; orgKey: { accountId: string; keyId: string }; sql: import("./db").Sql; limiter: import("./lib/throttle").Limiter };
};
