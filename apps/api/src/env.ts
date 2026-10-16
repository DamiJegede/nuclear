export interface Env {
  HYPERDRIVE: Hyperdrive;
  /** HS256 secret for wallet magic-link JWTs. `wrangler secret put JWT_SECRET`; `.dev.vars` locally. */
  JWT_SECRET: string;
  /** Base URL used to build magic links. Defaults to https://app.nuclear.us */
  APP_URL?: string;
  /** "true" enables POST /v1/sandbox/fundings (simulated bank load). Never enable in live. */
  SANDBOX_FUNDING?: string;
  /**
   * Bearer token for /v1/admin/* (tag models and supplier band imports). Unset = the admin routes
   * answer 404. `wrangler secret put ADMIN_API_TOKEN`; `.dev.vars` locally.
   */
  ADMIN_API_TOKEN?: string;
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

/** owner = the account holder's own login; wallet = delegated shared-wallet device. */
export type SessionKind = "owner" | "wallet";

export type SessionAuth = {
  deviceId: string;
  accountId: string;
  kind: SessionKind;
  /** Set only for wallet sessions. */
  walletId: string | null;
};

/** A merchant terminal's own JWT session (terminals are not devices). */
export type TerminalAuth = {
  terminalId: string;
  accountId: string;
  allowRefunds: boolean;
};

export type AppContext = {
  Bindings: Env;
  Variables: { auth: SessionAuth; terminal: TerminalAuth; sql: import("./db").Sql };
};
