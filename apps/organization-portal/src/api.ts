import { clearCache } from "./cache";

export class ApiError extends Error {
  constructor(public status: number, public code: string, public extra?: Record<string, unknown>) {
    super(code);
  }
}

export const API_URL: string = (import.meta.env?.VITE_API_URL as string | undefined) ?? "https://nuclear-api.a-space.workers.dev";

async function send<T>(base: string, token: string | null, method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
  let res: Response;
  const isBlob = typeof Blob !== "undefined" && body instanceof Blob;
  try {
    res = await fetch(base.replace(/\/$/, "") + path, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body === undefined ? {} : { "content-type": isBlob ? (body as Blob).type : "application/json" }),
        ...headers,
      },
      body: body === undefined ? undefined : isBlob ? (body as Blob) : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, "network_error");
  }
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON error page */ }
  if (!res.ok) throw new ApiError(res.status, json?.error ?? `http_${res.status}`, json ?? undefined);
  return json as T;
}

// ---- Types ----------------------------------------------------------------------------------------
export type Session = { account_id: string; device_id: string; session_token: string; session_expires_at: string };
export type Account = { account_id: string; type: "C" | "B" | "O"; handle: string | null; name: string; email: string | null; email_verified?: boolean; phone: string | null; photo: string | null; status: string };
export type Balance = { balance: number; balance_pending: number };
/** One benefits run: every credit run is the same record, whether it came from this portal's CSV, the API or (later) the scheduler. */
export type Run = { id: string; rows: number; total: number; sent: number; held: number; source: "csv" | "api" | "schedule"; status: "credited" | "waiting_for_funds" | "missed"; run_date: string; created_at: string };
export type Device = { id: string; wallet_id: string | null; platform: string | null; created_at: string; last_accessed_at: string | null; session_expires_at: string | null; revoked_at: string | null; redeemed: boolean };
export type OrgDocument = { id: string; type: string; created_at: string };
export type OrgProfile = { legal_name: string; display_name: string; tax_id_last4: string | null; address: string | null; city: string | null; state: string | null; post_code: string | null; country: string | null; website: string | null };
export type OrgProfileInput = { legal_name: string; display_name: string; tax_id?: string; address?: string | null; city?: string | null; state?: string | null; post_code?: string | null; country?: string | null; website?: string | null };
export type ApiKeyStatus = { hint: string; name: string; created_at: string; last_used_at: string | null };
export type Overview = {
  balance: number;
  employees: { total: number; claimed: number; unclaimed: number };
  held: number;
  last_run: Run | null;
};
export type Employee = { id: string; employee_id: string; name: string; email: string; balance: number; claimed: boolean; reminded_at: string | null; created_at: string; fixed_benefit: number | null };
export type Cadence = "monthly" | "weekly" | "biweekly";
export type Program = {
  mode: "fixed" | "flexible"; chosen: boolean; cadence: Cadence | null; day_of_month: number | null; weekday: number | null; start_date: string | null; next_run_date: string | null;
  fixed: { employees: number; total: number }; balance: number; funded: boolean;
};
export type ProgramInput = { mode: "flexible" } | { mode: "fixed"; cadence: "monthly"; day_of_month: number } | { mode: "fixed"; cadence: "weekly" | "biweekly"; weekday: number };
export type BulkAction = { action: "remove" } | { action: "clear_fixed" } | { action: "set_fixed"; amount: number };
export type FixedRow = { employee_id: string; name: string; email: string; fixed_benefit: number };
export type RunRowResult = {
  employee_id: string; name: string; email: string; amount: number; mode: "sent" | "held"; transaction_id: string;
  /** The employee's state now, not when the run happened. */
  claimed: boolean; balance: number; reminded_at: string | null; removed: boolean;
};
export type RunDetailData = { run: Run; summary: { claimed: number; unclaimed: number; still_held: number }; rows: RunRowResult[] };
export type CreditRow = { employee_id: string; name: string; email: string; amount: number };
export type RunResult = { run: Run; emails: { sent: number; failed: number; not_configured: number } };

// ---- Public calls (no session) ----------------------------------------------------------------------
export const signIn = (email: string, password: string, base: string = API_URL) =>
  send<Session>(base, null, "POST", "/v1/auth/login", { email, password, platform: "web" });
export const signUp = (input: { name: string; email: string; password: string; phone?: string }, base: string = API_URL) =>
  send<Session>(base, null, "POST", "/v1/auth/signup", { ...input, type: "O", platform: "web" });

// Emailed links and "forgot password": public, no session.
export const requestPasswordReset = (email: string, base: string = API_URL) => send<{ ok: true }>(base, null, "POST", "/v1/auth/password-reset", { email });
export const confirmPasswordReset = (token: string, password: string, base: string = API_URL) => send<{ ok: true }>(base, null, "POST", "/v1/auth/password-reset/confirm", { token, password });
export const verifyEmail = (token: string, base: string = API_URL) => send<{ verified: true }>(base, null, "POST", "/v1/auth/verify-email", { token });

export type Api = ReturnType<typeof createApi>;

/** Calls made as a signed-in organization owner. The session token is held by the caller, never logged. */
export function createApi(token: string, base: string = API_URL) {
  // Any successful change (not a read) empties the page cache, so the next visit to a page pulls fresh data.
  const request = async <T>(method: string, path: string, body?: unknown, headers?: Record<string, string>) => {
    const r = await send<T>(base, token, method, path, body, headers);
    if (method !== "GET") clearCache();
    return r;
  };
  const id = encodeURIComponent;
  const qs = (o: Record<string, string | undefined>) => {
    const p = Object.entries(o).filter(([, v]) => v !== undefined && v !== "").map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`);
    return p.length ? `?${p.join("&")}` : "";
  };
  return {
    logout: () => request<null>("POST", "/v1/auth/logout"),
    resendVerification: () => request<{ already_verified?: boolean; email?: string }>("POST", "/v1/auth/verify-email/resend"),
    account: () => request<Account>("GET", "/v1/account"),
    uploadPhoto: (file: Blob) => request<{ photo: string }>("PUT", "/v1/account/photo", file),
    apiKey: async () => (await request<{ key: ApiKeyStatus | null }>("GET", "/v1/org/api-key")).key,
    /** Generates a key and kills the old one. The token is in this answer only. */
    generateApiKey: () => request<{ key: ApiKeyStatus; token: string }>("POST", "/v1/org/api-key"),
    revokeApiKey: () => request<null>("DELETE", "/v1/org/api-key"),
    profile: async () => (await request<{ profile: OrgProfile | null }>("GET", "/v1/org/profile")).profile,
    saveProfile: async (input: OrgProfileInput) => (await request<{ profile: OrgProfile }>("PUT", "/v1/org/profile", input)).profile,
    documents: async () => (await request<{ documents: OrgDocument[] }>("GET", "/v1/account/documents")).documents,
    uploadDocument: (file: Blob) => request<{ document: OrgDocument }>("POST", "/v1/account/documents", file),
    devices: async () => (await request<{ devices: Device[] }>("GET", "/v1/devices")).devices,
    revokeDevice: (did: string) => request<null>("POST", `/v1/devices/${id(did)}/revoke`),
    overview: () => request<Overview>("GET", "/v1/org/overview"),
    employees: async (q = "", status: "" | "claimed" | "unclaimed" = "") => (await request<{ employees: Employee[] }>("GET", `/v1/org/employees${qs({ q, status })}`)).employees,
    removeEmployee: (eid: string) => request<null>("DELETE", `/v1/org/employees/${id(eid)}`),
    program: async () => (await request<{ program: Program }>("GET", "/v1/org/program")).program,
    setProgram: async (input: ProgramInput) => (await request<{ program: Program }>("PUT", "/v1/org/program", input)).program,
    /** One action on many employees (their ids) at once, all or nothing. */
    bulkEmployees: (ids: string[], op: BulkAction) => request<{ action: string; count: number }>("POST", "/v1/org/employees/bulk", { ids, ...op }),
    uploadFixedBenefits: (rows: FixedRow[]) => request<{ employees: unknown[]; fixed: { employees: number; total: number } }>("POST", "/v1/org/fixed-benefits", { rows }),
    setFixedBenefit: (eid: string, amountCents: number | null) => request<{ fixed_benefit: number | null }>("PATCH", `/v1/org/employees/${id(eid)}`, { fixed_benefit: amountCents }),
    runs: async () => (await request<{ runs: Run[] }>("GET", "/v1/org/benefit-runs")).runs,
    run: (rid: string) => request<RunDetailData>("GET", `/v1/org/benefit-runs/${id(rid)}`),
    /** Runs the benefits from a CSV. The same idempotency key is safe to retry: the run is applied once. */
    runBenefits: (rows: CreditRow[], idempotencyKey: string) => request<RunResult>("POST", "/v1/org/benefit-runs", { rows }, { "idempotency-key": idempotencyKey }),
    /** Adds funds to the organization's wallet. */
    addFunds: (amountCents: number, idempotencyKey: string) => request<unknown>("POST", "/v1/sandbox/fundings", { amount: amountCents }, { "idempotency-key": idempotencyKey }),
  };
}
