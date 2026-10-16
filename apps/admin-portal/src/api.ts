export type Vol = { count: number; volume: number };

import type { Page, Role } from "./roles";

export type Stats = {
  as_of: string;
  scheme: {
    balance: number;
    consumer_balance: number;
    merchant_balance: number;
    merchant_debt: number;
    pending: number;
    credit_outstanding: number;
    credit_limit: number;
  };
  reconciliation: {
    balances_match_ledger: boolean;
    balance_difference: number;
    credit_matches_ledger: boolean;
    credit_difference: number;
    ledger_balanced: boolean;
    earmarks_within_balances: boolean;
  };
  users: { total: number; active: number; suspended: number; closed: number; new_today: number; new_7d: number; new_30d: number; wallets: number };
  merchants: { total: number; active: number; transacting: number; terminals: number };
  payments: {
    sent: Vol;
    tapped: Vol;
    in_app: Vol;
    agents: Vol;
    merchant_payments: Vol;
    total: Vol;
    refunds: Vol;
    loaded: Vol;
    today: { sent: Vol; tapped: Vol; in_app: Vol; agents: Vol };
  };
};

export type TagModel = {
  id: string;
  type: "band" | "card";
  name: string;
  photo: string | null;
  currency: string;
  price: number;
  country: string | null;
  quantity: number;
  sold: number;
  limited: boolean;
  status: "pending" | "preorder" | "available" | "closed";
  created_at: string;
  tags?: number;
  unassigned?: number;
};

export type MerchantRow = {
  id: string; name: string; handle: string | null; status: string; created_at: string; balance: number;
  terminals: number; payments: number; volume: number;
};
export type UserRow = {
  id: string; name: string; handle: string | null; email: string | null; status: string; created_at: string;
  balance: number; wallets: number; agents: number;
};
export type TxKind = "all" | "sends" | "taps" | "funds" | "agents";
export type TxRow = {
  id: string; type: string; status: string; status_code: string | null; amount: number; timestamp: string;
  via: "tap" | "pass" | "app" | null; agent: boolean; from: string | null; from_wallet: string | null; to: string | null; to_wallet: string | null;
};
export type TxPage = {
  counts: Record<TxKind, number>;
  totals: { completed_count: number; completed_volume: number };
  transactions: TxRow[];
  next_cursor: string | null;
};
/** Program dates (America/New_York, YYYY-MM-DD), inclusive. */
export type DayRange = { from?: string; to?: string };

/** One model with its provisioning and activation numbers. */
export type TagDetail = TagModel & {
  tags: number; unassigned: number; activated: number; pending: number; rank: number; models_total: number;
};

export type ProvisionResult = {
  requested: number; inserted: number; duplicates_in_request: number; already_existing: { uid: string; model_id: string }[];
};

export type NewModel = {
  type: "band" | "card";
  name: string;
  photo?: string;
  price: number;
  quantity: number;
  limited: boolean;
  status: TagModel["status"];
};

export type AdminMe = { access_id: string; name: string; role: Role; pages: Page[]; landing: Page; mfa_enabled: boolean };

export type SignedIn = {
  session_token: string;
  expires_at: string;
  admin: { access_id: string; name: string; role: Role };
  role: Role;
  pages: Page[];
  landing: Page;
  mfa_enabled: boolean;
};

/** The Access Token was right and the account has an authenticator: a code is needed to finish. */
export type MfaChallenge = { mfa_required: true; mfa_token: string; expires_in: number };

export const isChallenge = (r: SignedIn | MfaChallenge): r is MfaChallenge => "mfa_required" in r && r.mfa_required === true;

/** Credentials issued by the server. The Access Token is shown once and cannot be fetched again. */
export type Credentials = { access_id: string; access_token: string };

export type AdminRow = {
  id: string;
  access_id: string;
  name: string;
  role: Role;
  status: "active" | "disabled";
  mfa_enabled: boolean;
  locked: boolean;
  last_login_at: string | null;
  created_at: string;
  created_by: string | null;
};

export type MfaSetup = { secret: string; otpauth_uri: string };

export class ApiError extends Error {
  constructor(public status: number, public code: string) {
    super(code);
  }
}

export const API_URL: string = (import.meta.env?.VITE_API_URL as string | undefined) ?? "https://nuclear-api.a-space.workers.dev";

async function send<T>(base: string, token: string | null, method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  const isBlob = typeof Blob !== "undefined" && body instanceof Blob;
  try {
    res = await fetch(base.replace(/\/$/, "") + path, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body === undefined ? {} : { "content-type": isBlob ? (body as Blob).type : "application/json" }),
      },
      body: body === undefined ? undefined : isBlob ? (body as Blob) : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, "network_error");
  }
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON error page */ }
  if (!res.ok) throw new ApiError(res.status, json?.error ?? `http_${res.status}`);
  return json as T;
}

/** Sign in with an access ID and Access Token. The token is sent once, over HTTPS, and never stored. */
export const signIn = (accessId: string, accessToken: string, base: string = API_URL) =>
  send<SignedIn | MfaChallenge>(base, null, "POST", "/v1/admin/login", { access_id: accessId, access_token: accessToken });

/** Second step: the 6-digit authenticator code, or a recovery code. */
export const completeMfa = (mfaToken: string, code: string, base: string = API_URL) =>
  send<SignedIn>(base, null, "POST", "/v1/admin/login/mfa", { mfa_token: mfaToken, code });

export type Api = ReturnType<typeof createApi>;

/** Calls made as a signed-in admin. The session token is held by the caller, never logged. */
export function createApi(token: string, base: string = API_URL) {
  const request = <T>(method: string, path: string, body?: unknown) => send<T>(base, token, method, path, body);
  // Uploaded photos come back as API paths; make them absolute so the page can show them.
  const absolutePhoto = <M extends { photo: string | null }>(m: M): M =>
    ({ ...m, photo: m.photo && m.photo.startsWith("/") ? base.replace(/\/$/, "") + m.photo : m.photo });
  return {
    me: () => request<AdminMe>("GET", "/v1/admin/me"),
    logout: () => request<null>("POST", "/v1/admin/logout"),
    merchants: async (q?: string) =>
      (await request<{ merchants: MerchantRow[] }>("GET", `/v1/admin/merchants${q ? `?q=${encodeURIComponent(q)}` : ""}`)).merchants,
    users: async (q?: string) =>
      (await request<{ users: UserRow[] }>("GET", `/v1/admin/users${q ? `?q=${encodeURIComponent(q)}` : ""}`)).users,
    transactions: (kind: TxKind = "all", cursor?: string, range: DayRange = {}) =>
      request<TxPage>("GET", `/v1/admin/transactions?kind=${kind}${range.from ? `&from=${range.from}` : ""}${range.to ? `&to=${range.to}` : ""}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`),
    admins: async () => (await request<{ admins: AdminRow[] }>("GET", "/v1/admin/admins")).admins,
    /** The server generates the Access ID and Access Token and returns them once. */
    createAdmin: (name: string, role: Role) =>
      request<{ admin: Pick<AdminRow, "id" | "access_id" | "name" | "role">; credentials: Credentials }>("POST", "/v1/admin/admins", { name, role }),
    /** Changes an admin's role (not your own). Takes effect on their next request. */
    setAdminRole: (id: string, role: Role) =>
      request<{ admin: Pick<AdminRow, "id" | "access_id" | "name" | "role"> }>("PUT", `/v1/admin/admins/${encodeURIComponent(id)}/role`, { role }),
    /** Rotates an admin's Access Token; the new one is returned once. */
    rotateAccessToken: (id: string) =>
      request<{ admin: Pick<AdminRow, "id" | "access_id" | "name">; credentials: Credentials }>("POST", `/v1/admin/admins/${encodeURIComponent(id)}/rotate-token`),
    mfaSetup: () => request<MfaSetup>("POST", "/v1/admin/mfa/setup"),
    mfaEnable: async (code: string) =>
      (await request<{ recovery_codes: string[] }>("POST", "/v1/admin/mfa/enable", { code })).recovery_codes,
    newRecoveryCodes: async (code: string) =>
      (await request<{ recovery_codes: string[] }>("POST", "/v1/admin/mfa/recovery-codes", { code })).recovery_codes,
    stats: () => request<Stats>("GET", "/v1/admin/stats"),
    models: async () => (await request<{ models: TagModel[] }>("GET", "/v1/admin/tag-models")).models.map(absolutePhoto),
    model: async (id: string) => absolutePhoto((await request<{ model: TagDetail }>("GET", `/v1/admin/tag-models/${encodeURIComponent(id)}`)).model),
    updateModel: async (id: string, patch: Partial<NewModel>) =>
      (await request<{ model: TagModel }>("PATCH", `/v1/admin/tag-models/${encodeURIComponent(id)}`, patch)).model,
    /** Loads a supplier's UIDs as unassigned tags for a model. */
    provisionTags: (id: string, uids: string[]) =>
      request<ProvisionResult>("POST", `/v1/admin/tag-models/${encodeURIComponent(id)}/tags`, { uids }),
    /** Uploads the (already resized) photo for a model. */
    uploadModelPhoto: (id: string, photo: Blob) => request<null>("PUT", `/v1/admin/tag-models/${encodeURIComponent(id)}/photo`, photo),
    createModel: async (m: NewModel) => (await request<{ model: TagModel }>("POST", "/v1/admin/tag-models", m)).model,
  };
}
