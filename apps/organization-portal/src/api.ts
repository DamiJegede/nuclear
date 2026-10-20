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
export type Account = { account_id: string; type: "C" | "B" | "O"; handle: string | null; name: string; email: string | null; phone: string | null; photo: string | null; status: string };
export type Balance = { balance: number; balance_pending: number };
export type Batch = { id: string; rows: number; total: number; sent: number; held: number; created_at: string };
export type Device = { id: string; wallet_id: string | null; platform: string | null; created_at: string; last_accessed_at: string | null; session_expires_at: string | null; revoked_at: string | null; redeemed: boolean };
export type OrgDocument = { id: string; type: string; created_at: string };
export type OrgProfile = { legal_name: string; display_name: string; tax_id_last4: string | null; address: string | null; city: string | null; state: string | null; post_code: string | null; country: string | null; website: string | null };
export type OrgProfileInput = { legal_name: string; display_name: string; tax_id?: string; address?: string | null; city?: string | null; state?: string | null; post_code?: string | null; country?: string | null; website?: string | null };
export type Overview = {
  balance: number;
  employees: { total: number; claimed: number; unclaimed: number };
  held: number;
  last_batch: Batch | null;
};
export type Employee = { id: string; employee_id: string; name: string; email: string; balance: number; claimed: boolean; reminded_at: string | null; created_at: string };
export type BatchRowResult = {
  employee_id: string; name: string; email: string; amount: number; mode: "sent" | "held"; transaction_id: string;
  /** The employee's state now, not when the batch ran. */
  claimed: boolean; balance: number; reminded_at: string | null; removed: boolean;
};
export type BatchDetailData = { batch: Batch; summary: { claimed: number; unclaimed: number; still_held: number }; rows: BatchRowResult[] };
export type CreditRow = { employee_id: string; name: string; email: string; amount: number };
export type BatchResult = { batch: Batch; emails: { sent: number; failed: number; not_configured: number } };

// ---- Public calls (no session) ----------------------------------------------------------------------
export const signIn = (email: string, password: string, base: string = API_URL) =>
  send<Session>(base, null, "POST", "/v1/auth/login", { email, password, platform: "web" });
export const signUp = (input: { name: string; email: string; password: string; phone?: string }, base: string = API_URL) =>
  send<Session>(base, null, "POST", "/v1/auth/signup", { ...input, type: "O", platform: "web" });

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
    account: () => request<Account>("GET", "/v1/account"),
    uploadPhoto: (file: Blob) => request<{ photo: string }>("PUT", "/v1/account/photo", file),
    profile: async () => (await request<{ profile: OrgProfile | null }>("GET", "/v1/org/profile")).profile,
    saveProfile: async (input: OrgProfileInput) => (await request<{ profile: OrgProfile }>("PUT", "/v1/org/profile", input)).profile,
    documents: async () => (await request<{ documents: OrgDocument[] }>("GET", "/v1/account/documents")).documents,
    uploadDocument: (file: Blob) => request<{ document: OrgDocument }>("POST", "/v1/account/documents", file),
    devices: async () => (await request<{ devices: Device[] }>("GET", "/v1/devices")).devices,
    revokeDevice: (did: string) => request<null>("POST", `/v1/devices/${id(did)}/revoke`),
    overview: () => request<Overview>("GET", "/v1/org/overview"),
    employees: async (q = "", status: "" | "claimed" | "unclaimed" = "") => (await request<{ employees: Employee[] }>("GET", `/v1/org/employees${qs({ q, status })}`)).employees,
    removeEmployee: (eid: string) => request<null>("DELETE", `/v1/org/employees/${id(eid)}`),
    batches: async () => (await request<{ batches: Batch[] }>("GET", "/v1/org/credit-batches")).batches,
    batch: (bid: string) => request<BatchDetailData>("GET", `/v1/org/credit-batches/${id(bid)}`),
    /** Runs a CSV batch. The same idempotency key is safe to retry: the batch is applied once. */
    runBatch: (rows: CreditRow[], idempotencyKey: string) => request<BatchResult>("POST", "/v1/org/credit-batches", { rows }, { "idempotency-key": idempotencyKey }),
    /** Adds funds to the organization's wallet. */
    addFunds: (amountCents: number, idempotencyKey: string) => request<unknown>("POST", "/v1/sandbox/fundings", { amount: amountCents }, { "idempotency-key": idempotencyKey }),
  };
}
