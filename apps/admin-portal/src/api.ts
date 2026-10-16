export type Vol = { count: number; volume: number };

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
  };
  users: { total: number; active: number; suspended: number; closed: number; new_7d: number; new_30d: number };
  merchants: { total: number; active: number; transacting: number; terminals: number };
  payments: {
    sent: Vol;
    tapped: Vol;
    in_app: Vol;
    merchant_payments: Vol;
    total: Vol;
    refunds: Vol;
    loaded: Vol;
    today: { sent: Vol; tapped: Vol; in_app: Vol };
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

export type NewModel = {
  type: "band" | "card";
  name: string;
  photo?: string;
  price: number;
  quantity: number;
  limited: boolean;
  status: TagModel["status"];
};

export class ApiError extends Error {
  constructor(public status: number, public code: string) {
    super(code);
  }
}

export const API_URL: string = (import.meta.env?.VITE_API_URL as string | undefined) ?? "https://nuclear-api.a-space.workers.dev";

export type Api = ReturnType<typeof createApi>;

/** A thin client for the operator endpoints. The token is held by the caller, never logged. */
export function createApi(token: string, base: string = API_URL) {
  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetch(base.replace(/\/$/, "") + path, {
        method,
        headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
        body: body === undefined ? undefined : JSON.stringify(body),
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
  return {
    stats: () => request<Stats>("GET", "/v1/admin/stats"),
    models: async () => (await request<{ models: TagModel[] }>("GET", "/v1/admin/tag-models")).models,
    createModel: async (m: NewModel) => (await request<{ model: TagModel }>("POST", "/v1/admin/tag-models", m)).model,
  };
}
