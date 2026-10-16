export interface Env {
  HYPERDRIVE: Hyperdrive;
  /** HS256 secret for wallet magic-link JWTs. `wrangler secret put JWT_SECRET`; `.dev.vars` locally. */
  JWT_SECRET: string;
  /** Base URL used to build magic links. Defaults to https://app.nuclear.us */
  APP_URL?: string;
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
  /** Browser origins allowed to call /v1/admin/* (comma-separated), e.g. the admin portal's URL. */
  ADMIN_ORIGINS?: string;
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
  | { kind: "admin"; adminId: string; accessId: string; name: string; sessionId: string; mfaEnabled: boolean };

export type AppContext = {
  Bindings: Env;
  Variables: { auth: SessionAuth; terminal: TerminalAuth; adminAuth: AdminAuth; sql: import("./db").Sql };
};
