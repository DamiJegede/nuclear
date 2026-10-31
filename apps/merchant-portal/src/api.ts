import { clearCache } from "./cache";

export class ApiError extends Error {
  constructor(public status: number, public code: string, public extra?: Record<string, unknown>) {
    super(code);
  }
}

export const API_URL: string = (import.meta.env?.VITE_API_URL as string | undefined) ?? "https://api.nclr.app";

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
export type AccountStatus = "active" | "pending" | "declined" | "suspended" | "closed";
export type Account = {
  account_id: string; type: "B" | "C"; handle: string | null; name: string; email: string | null; email_verified?: boolean; phone: string | null; photo: string | null; bio: string | null;
  tier: string; status: AccountStatus; decline?: { reason: string | null; at: string };
};
export type Balance = { balance: number; earmarked: number; balance_pending: number; credit_limit: number; credit_spent: number; available_to_send: number; available_to_pay: number; restricted: boolean };
export type BusinessDocument = { id: string; type: string; created_at: string };
export type Orb = { id: string; uid: string; model: string; software: string };
export type Terminal = { id: string; name: string; allow_refunds: boolean; created_at: string; updated_at: string; orb: Orb | null };
export type OwnedOrb = Orb & { terminal_id: string | null };
export type StaffMember = { id: string; staff_account_id: string; handle: string | null; name: string | null; role: "read" | "write"; created_at: string };
export type TipRow = { id: string; amount: number; created_at: string; transaction_id: string; kind: "tip" | "refund"; staff_account_id: string; staff_name: string; reference: string | null };
export type TipsPage = {
  business: { id: string; name: string }; role: "owner" | "write" | "read"; period: { from: string | null; to: string | null };
  total: number; count: number; staff: { staff_account_id: string; name: string; total: number }[]; tips: TipRow[]; next_cursor: string | null;
  /** Per program day (New York), newest first, refunds netted out. */
  days: { date: string; total: number; count: number }[];
};
export type Employer = { business_id: string; name: string; role: "read" | "write" };
export type Refund = {
  id: string; status: "pending" | "completed" | "failed"; status_code: string | null; amount: number; payment_id: string | null; payment_amount: number;
  attempt: string | null; reference: string | null; payer: { display_name: string } | null; items: unknown; requested_on_terminal_id: string | null;
  approver_account_id: string | null; timestamp: string; completed_at: string | null;
};
export type Device = { id: string; wallet_id: string | null; platform: string | null; created_at: string; last_accessed_at: string | null; session_expires_at: string | null; revoked_at: string | null; redeemed: boolean };
export type HandleLookup = { account_id: string; handle: string; type: "B" | "C"; display_name: string; photo: string | null; wallet_id: string };

export type SalesPeriod = "week" | "last_week" | "30d";
export type Sales = { period: SalesPeriod; from: string; to: string; today: string; fees: number; total: number; days: { date: string; sales: number; payments: number }[] };

export type Overview = {
  balance: number; balance_pending: number; terminals: { count: number; paired: number }; pending_refunds: { count: number; amount: number };
  staff: { count: number; writers: number }; open_orders: number; city: string | null; state: string | null; categories: number; products: number; best_seller: { name: string; sold_today: number } | null;
  today: { transactions: number; since: string | null; closed_out_at: string | null }; yesterday: { net: number };
  payout_bank: { last4: string; institution: Institution | null } | null;
};
/** A bank by routing number: its name and logo when we have them, and whether it takes instant payouts (null = not known). */
/** The bank a payout goes to. `choices` (brands, the partner bank last) is there when the routing number belongs to a partner bank several brands run on, `needs_choice` until the merchant says which. */
export type BankChoice = { id: string; name: string; icon: string | null };
export type Institution = { id: string; name: string | null; icon: string | null; instant: boolean | null; choices?: BankChoice[]; needs_choice?: boolean };
export type CloseOutResult = { settlement: { id: string; date: string; amount: number; rail: "instant" | "ach"; status: string; arrival: "instant" | "today" | "next_business_day" } };
export type TxKind = "all" | "payments" | "refunds" | "pending";
export type TxRow = {
  id: string; type: string; status: string; status_code: string | null; amount: number; timestamp: string; via: "tap" | "pass" | "app" | null;
  reference: string | null; terminal: string | null; customer: string | null; approved_by: string | null; refund_of: string | null; from: string | null; to: string | null;
  /** For a completed payment: the part of `amount` that is tip, and who served the order (from its checkout). */
  tip?: number | null; served_by?: string | null;
  /** For a refund: the payment it refunds. */
  original?: { id: string; timestamp: string; amount: number; tip: number; served_by: string | null; via: "tap" | "pass" | "app" | null; reference: string | null } | null;
};
export type TxPage = {
  /** Counts and totals come with the first page only (null on the pages after it). */
  counts: Record<TxKind, number> | null; totals: { payments: { count: number; volume: number }; refunds: { count: number; volume: number } } | null;
  transactions: TxRow[]; next_cursor: string | null;
};
export type DayRange = { from?: string; to?: string };
export type Profile = { legal_name: string; display_name: string; tax_id_last4: string | null; address: string | null; city: string | null; state: string | null; post_code: string | null; country: string | null; website: string | null };
export type ProfileInput = { legal_name: string; display_name: string; tax_id?: string; address?: string | null; city?: string | null; state?: string | null; post_code?: string | null; country?: string | null; website?: string | null };
export type PayoutBank = { id: string; last4: string; status: string; created_at: string; institution: Institution | null };
export type Payout = { id: string; kind: "payout" | "collection"; amount: number; status: string; status_code: string | null; timestamp: string; completed_at: string | null; bank_last4: string | null; source?: "nightly" | "close_out"; rail?: "instant" | "ach" };
export type Category = { id: string; name: string; active: boolean; products: number; created_at: string };
export type Product = {
  id: string; category_id: string | null; name: string; currency: string; price: number; discount: number; effective_price: number; photo: string | null;
  stock: number | null; active: boolean; status: "available" | "sold_out"; total_sold: number; sold_today: number; created_at: string; taxable: boolean;
};
export type ProductInput = { name: string; price: number; discount: number; category_id: string | null; stock: number | null; active: boolean; taxable: boolean };
/** Sales tax settings: the rate in basis points (825 = 8.25%) and whether prices already include it. */
export type TaxSettings = { tax_rate: number; tax_included: boolean };
export type CheckoutItem = { id: string; product_id: string | null; name: string; unit_price: number; discount: number; net_price: number; quantity: number; refunded_quantity: number; pending_refund_quantity: number; refundable_quantity: number };
export type Checkout = { id: string; status: "open" | "paid" | "canceled" | "expired"; reference: string | null; currency: string; total: number; terminal_id: string | null; expires_at: string | null; created_at: string; items: CheckoutItem[]; tip_amount?: number; sales_tax?: number; served_by?: string | null; served_by_name?: string | null };

// ---- Public calls (no session) ----------------------------------------------------------------------
export const signIn = (email: string, password: string, base: string = API_URL) =>
  send<Session>(base, null, "POST", "/v1/auth/login", { email, password, platform: "web" });
export const signUp = (input: { name: string; email: string; password: string; phone?: string }, base: string = API_URL) =>
  send<Session>(base, null, "POST", "/v1/auth/signup", { ...input, type: "B", platform: "web" });

// Emailed links and "forgot password": public, no session.
export const requestPasswordReset = (email: string, base: string = API_URL) => send<{ ok: true }>(base, null, "POST", "/v1/auth/password-reset", { email });
export const confirmPasswordReset = (token: string, password: string, base: string = API_URL) => send<{ ok: true }>(base, null, "POST", "/v1/auth/password-reset/confirm", { token, password });
export const verifyEmail = (token: string, base: string = API_URL) => send<{ verified: true }>(base, null, "POST", "/v1/auth/verify-email", { token });

export type Api = ReturnType<typeof createApi>;

/** Calls made as a signed-in business owner. The session token is held by the caller, never logged. */
export function createApi(token: string, base: string = API_URL) {
  // Any successful change (not a read) empties the page cache, so the next visit to a page pulls fresh data.
  const request = async <T>(method: string, path: string, body?: unknown, headers?: Record<string, string>) => {
    const r = await send<T>(base, token, method, path, body, headers);
    if (method !== "GET") clearCache();
    return r;
  };
  const id = encodeURIComponent;
  const qs = (o: Record<string, string | number | undefined>) => {
    const p = Object.entries(o).filter(([, v]) => v !== undefined && v !== "").map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`);
    return p.length ? `?${p.join("&")}` : "";
  };
  return {
    logout: () => request<null>("POST", "/v1/auth/logout"),
    /** Tips for a period: everyone's (the business, or write staff) or only the caller's. A person who works for several businesses names one. */
    tips: (o: { business?: string; staff?: string; cursor?: string } & DayRange) => request<TipsPage>("GET", `/v1/tips${qs({ business: o.business, staff: o.staff, from: o.from, to: o.to, cursor: o.cursor })}`),
    employers: async () => (await request<{ employers: Employer[] }>("GET", "/v1/tips/employers")).employers,
    resendVerification: () => request<{ already_verified?: boolean; email?: string }>("POST", "/v1/auth/verify-email/resend"),
    account: () => request<Account>("GET", "/v1/account"),
    balance: () => request<Balance>("GET", "/v1/balance"),
    setBio: async (bio: string | null) => (await request<{ bio: string | null }>("PUT", "/v1/account/bio", { bio })).bio,
    setHandle: (handle: string) => request<{ handle: string }>("PUT", "/v1/account/handle", { handle }),
    /** The profile picture: any PNG, JPEG or WebP; the API crops it to 256 x 256 JPEG. */
    uploadPhoto: (file: Blob) => request<{ photo: string }>("PUT", "/v1/account/photo", file),
    documents: async () => (await request<{ documents: BusinessDocument[] }>("GET", "/v1/account/documents")).documents,
    uploadDocument: (file: Blob) => request<{ document: BusinessDocument; status: AccountStatus }>("POST", "/v1/account/documents", file),

    terminals: async () => (await request<{ terminals: Terminal[] }>("GET", "/v1/terminals")).terminals,
    createTerminal: (input: { name: string; allow_refunds: boolean }) =>
      request<{ terminal: Terminal; session_token: string; session_expires_at: string }>("POST", "/v1/terminals", input),
    updateTerminal: async (tid: string, patch: Partial<{ name: string; allow_refunds: boolean }>) => (await request<{ terminal: Terminal }>("PATCH", `/v1/terminals/${id(tid)}`, patch)).terminal,
    /** Issues a new terminal session token (the old one stops working); shown once. */
    terminalSession: (tid: string) => request<{ session_token: string; session_expires_at: string }>("POST", `/v1/terminals/${id(tid)}/session`),
    revokeTerminal: (tid: string) => request<null>("POST", `/v1/terminals/${id(tid)}/revoke`),
    pairOrb: async (tid: string, orb: { uid: string; model: string; software: string }) => (await request<{ orb: Orb }>("PUT", `/v1/terminals/${id(tid)}/orb`, orb)).orb,
    unpairOrb: (tid: string) => request<null>("DELETE", `/v1/terminals/${id(tid)}/orb`),
    orbs: async () => (await request<{ orbs: OwnedOrb[] }>("GET", "/v1/orbs")).orbs,
    releaseOrb: (oid: string) => request<null>("POST", `/v1/orbs/${id(oid)}/release`),

    staff: async () => (await request<{ staff: StaffMember[] }>("GET", "/v1/staff")).staff,
    lookupHandle: (handle: string) => request<HandleLookup>("GET", `/v1/handles/${id(handle.replace(/^@/, ""))}`),
    addStaff: async (staffAccountId: string, role: "read" | "write") => (await request<{ staff: StaffMember }>("POST", "/v1/staff", { staff_account_id: staffAccountId, role })).staff,
    setStaffRole: async (sid: string, role: "read" | "write") => (await request<{ staff: StaffMember }>("PATCH", `/v1/staff/${id(sid)}`, { role })).staff,
    removeStaff: (sid: string) => request<null>("DELETE", `/v1/staff/${id(sid)}`),

    refunds: async (status: "pending" | "completed" | "failed" = "pending") => (await request<{ refunds: Refund[] }>("GET", `/v1/refunds${qs({ status, limit: 100 })}`)).refunds,
    resolveRefund: (rid: string, action: "approve" | "reject") => request<unknown>("POST", `/v1/refunds/${id(rid)}/${action}`),

    overview: () => request<Overview>("GET", "/v1/business/overview"),
    sales: (period: SalesPeriod) => request<Sales>("GET", `/v1/business/sales?period=${period}`),
    transactions: (kind: TxKind = "all", cursor?: string, range: DayRange = {}) =>
      request<TxPage>("GET", `/v1/business/transactions${qs({ kind, from: range.from, to: range.to, cursor })}`),
    taxSettings: () => request<TaxSettings>("GET", "/v1/business/tax"),
    saveTaxSettings: (input: TaxSettings) => request<TaxSettings>("PUT", "/v1/business/tax", input),
    profile: async () => (await request<{ profile: Profile | null }>("GET", "/v1/business/profile")).profile,
    saveProfile: async (input: ProfileInput) => (await request<{ profile: Profile }>("PUT", "/v1/business/profile", input)).profile,
    bank: async () => (await request<{ bank: PayoutBank | null }>("GET", "/v1/business/bank")).bank,
    saveBank: async (input: { routing_number: string; account_number: string }) => (await request<{ bank: PayoutBank }>("PUT", "/v1/business/bank", input)).bank,
    payouts: async () => (await request<{ payouts: Payout[] }>("GET", "/v1/business/payouts")).payouts,
    closeOut: async () => (await request<CloseOutResult>("POST", "/v1/business/close-out")).settlement,
    chooseBank: async (institution_id: string) => (await request<{ bank: PayoutBank }>("PUT", "/v1/business/bank/institution", { institution_id })).bank,
    removeBank: () => request<null>("DELETE", "/v1/business/bank"),
    categories: async () => (await request<{ categories: Category[] }>("GET", "/v1/business/categories")).categories,
    createCategory: async (name: string) => (await request<{ category: Category }>("POST", "/v1/business/categories", { name })).category,
    updateCategory: async (cid: string, patch: Partial<{ name: string; active: boolean }>) => (await request<{ category: Category }>("PATCH", `/v1/business/categories/${id(cid)}`, patch)).category,
    deleteCategory: (cid: string) => request<null>("DELETE", `/v1/business/categories/${id(cid)}`),
    products: (filter: { category_id?: string; q?: string; cursor?: string } = {}) => request<{ products: Product[]; next_cursor: string | null; total: number }>("GET", `/v1/business/products${qs(filter)}`),
    createProduct: async (input: Partial<ProductInput> & { name: string; price: number }) => (await request<{ product: Product }>("POST", "/v1/business/products", input)).product,
    updateProduct: async (pid: string, patch: Partial<ProductInput>) => (await request<{ product: Product }>("PATCH", `/v1/business/products/${id(pid)}`, patch)).product,
    deleteProduct: (pid: string) => request<null>("DELETE", `/v1/business/products/${id(pid)}`),
    uploadProductPhoto: (pid: string, file: Blob) => request<{ photo: string }>("PUT", `/v1/business/products/${id(pid)}/photo`, file),
    checkouts: async (status: Checkout["status"] = "open") => (await request<{ checkouts: Checkout[] }>("GET", `/v1/business/checkouts${qs({ status, limit: 100 })}`)).checkouts,
    /** Who a paid order's tip went to, net of refunds: read when the order is opened. */
    checkoutTips: (cid: string) => request<{ tips: { staff_account_id: string; name: string; amount: number }[]; total: number; given: number; returned: number }>("GET", `/v1/business/checkouts/${id(cid)}/tips`),
    cancelCheckout: (cid: string) => request<{ checkout: Checkout }>("POST", `/v1/business/checkouts/${id(cid)}/cancel`),
    devices: async () => (await request<{ devices: Device[] }>("GET", "/v1/devices")).devices,
    revokeDevice: (did: string) => request<null>("POST", `/v1/devices/${id(did)}/revoke`),
  };
}
