export type Vol = { count: number; volume: number };

import type { Page, Role } from "./roles";

export type Stats = {
  as_of: string;
  /** Present when the numbers are the latest daily snapshot plus today's running estimate. */
  estimate?: { snapshot_date: string; snapshot_taken_at: string; today: string };
  scheme: {
    balance: number;
    consumer_balance: number;
    merchant_balance: number;
    organization_balance: number;
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
    escrow_matches_employees: boolean;
    benefits_match_ledger: boolean;
    daily_caps_match_ledger: boolean;
    wallet_counters_match: boolean;
  };
  /** When the ledger checks above were last computed (they run nightly or on Run Check, not per request). */
  reconciliation_checked_at: string;
  /** True when that is more than a day old. */
  reconciliation_stale: boolean;
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
  from_party: TxParty | null; to_party: TxParty | null;
};
/** One side of a transaction: opens the user or merchant page; the photo is set only when there is an image. */
export type TxParty = { id: string; kind: "user" | "merchant"; photo: string | null };
export type TxPage = {
  counts: Record<TxKind, number>;
  totals: { completed_count: number; completed_volume: number };
  transactions: TxRow[];
  next_cursor: string | null;
};
/** Program dates (America/New_York, YYYY-MM-DD), inclusive. */
export type DayRange = { from?: string; to?: string };

export type OrganizationRow = {
  id: string; name: string; email: string | null; status: string; created_at: string; email_verified: boolean; balance: number;
  mode: "fixed" | "flexible" | null; chosen: boolean | null; employees: number; claimed: number; held: number; runs: number;
};
export type OrganizationDetailData = {
  id: string; name: string; legal_name: string | null; handle: string | null; status: string; email: string | null; email_verified: boolean; phone: string | null;
  created_at: string; website: string | null; photo: string | null; bio: string | null;
  address: { line: string | null; city: string | null; state: string | null; post_code: string | null; country: string | null };
  balance: number;
  program: { mode: "fixed" | "flexible"; chosen: boolean; cadence: "monthly" | "weekly" | "biweekly" | null; day_of_month: number | null; weekday: number | null; next_run_date: string | null; fixed_total: number };
  employees: { total: number; claimed: number; unclaimed: number; removed: number; held: number };
  runs: { count: number; credited: number; last_run_at: string | null };
  api_key: { hint: string; created_at: string; last_used_at: string | null } | null;
  documents: number;
};
export type OrgEmployeeRow = {
  id: string; employee_id: string; name: string; email: string; status: "active" | "removed"; claimed: boolean; balance: number; fixed_benefit: number | null;
  reminded_at: string | null; created_at: string;
};
export type OrgRunRow = {
  id: string; source: "csv" | "api" | "schedule"; run_date: string; status: "credited" | "waiting_for_funds" | "missed"; row_count: number;
  total: number; sent: number; held: number; failure_code: string | null; created_at: string;
};
export type MerchantDetailData = {
  id: string; name: string; legal_name: string | null; handle: string | null; status: string; email: string | null; phone: string | null;
  created_at: string; website: string | null; photo: string | null; bio?: string | null; tier: string | null;
  address: { line: string | null; city: string | null; state: string | null; post_code: string | null; country: string | null };
  bank: { last4: string; status: string } | null;
  balance: number;
  stats: {
    payments: { count: number; volume: number; today: { count: number; volume: number }; declined: number };
    refunds: { count: number; volume: number };
    pending_refunds: { count: number; volume: number };
    customers: number; last_payment_at: string | null; terminals: number; staff: number; products: number;
  };
};
export type MerchantTerminal = {
  id: string; name: string; allow_refunds: boolean; created_at: string; signed_in: boolean;
  orb: { uid: string; model: string | null; software: string | null } | null;
  payments: number; volume: number; last_payment_at: string | null;
};
export type MerchantStaffRow = { id: string; staff_account_id: string; name: string; email: string | null; handle: string | null; role: "read" | "write"; bank_last4: string | null; created_at: string };
export type MerchantProduct = { id: string; name: string; category: string | null; price: number; discount: number; stock: number | null; active: boolean; status: string; total_sold: number; sold_today: number };
export type EmailResult = {
  total: number; sent: number; failed: number; not_configured: number; no_address: number; skipped: string[];
  results: { id: string; name: string; email: "sent" | "failed" | "not_configured" | "no_address" }[];
};
export type MerchantDocument = { id: string; type: string; created_at: string; file: string };
export type MerchantTxKind = "all" | "payments" | "refunds" | "pending";
export type MerchantTxRow = {
  id: string; type: string; status: string; status_code: string | null; amount: number; timestamp: string;
  via: "tap" | "pass" | "app" | null; reference: string | null; terminal: string | null; customer: string | null; approved_by: string | null; refund_of: string | null;
  from: string | null; to: string | null; from_party: TxParty | null; to_party: TxParty | null;
};
export type MerchantTxPage = {
  counts: Record<MerchantTxKind, number>;
  totals: { payments: { count: number; volume: number }; refunds: { count: number; volume: number } };
  transactions: MerchantTxRow[]; next_cursor: string | null;
};

export type UserDetailData = {
  id: string; name: string; handle: string | null; email: string | null; phone: string | null; status: string; tier: string | null; photo: string | null; bio?: string | null; created_at: string;
  login_locked: { retry_after: number } | null;
  balances: { balance: number; pending: number; credit_limit: number; credit_spent: number; earmarked: number; shared: number };
  stats: {
    sent: { count: number; volume: number }; received: { count: number; volume: number }; payments: { count: number; volume: number };
    loads: { count: number; volume: number }; failed: number; today: number; last_activity_at: string | null;
    wallets: number; agents: number; tags: number; devices: number; orders: number;
  };
};
export type UserWallet = {
  id: string; name: string; type: "default" | "agent" | "person"; status: string; balance: number | null; earmarked: boolean;
  daily_limit: number | null; spent_today: number | null; allow_pay: boolean; allow_send: boolean; tags: number;
  key: { hint: string; last_used_at: string | null } | null; created_at: string;
};
export type UserTag = { id: string; label: string | null; locked: boolean; transaction_limit: number | null; last_read_at: string | null; updated_at: string; model: string; model_type: string; wallet: string };
export type UserDevice = { id: string; platform: string | null; wallet: string | null; created_at: string; last_accessed_at: string | null; session_expires_at: string | null; revoked_at: string | null; active: boolean };
export type UserFunding = {
  banks: { id: string; last4: string; status: string; created_at: string }[];
  fundings: { id: string; amount: number; status: string; failure_code: string | null; last4: string | null; created_at: string; released_at: string | null; returned_at: string | null }[];
};
export type UserOrder = { id: string; type: "tag" | "shop"; delivery: "ship" | "download"; model_name: string; model_type: string | null; quantity: number; unit_price: number; total: number; status: string; shipping: { city?: string; region?: string; country?: string }; created_at: string };
export type UserTxKind = "all" | "sends" | "received" | "payments" | "loads" | "refunds";
export type UserTxRow = {
  id: string; type: string; status: string; status_code: string | null; amount: number; timestamp: string; direction: "in" | "out";
  via: "tap" | "pass" | "app" | null; counterparty: string | null; wallet: string | null; agent: boolean; reference: string | null;
  from: string | null; to: string | null; from_party: TxParty | null; to_party: TxParty | null;
};
export type UserTxPage = {
  counts: Record<UserTxKind, number>; totals: { money_out: number; money_in: number }; transactions: UserTxRow[]; next_cursor: string | null;
};

export type ShopItem = {
  id: string; name: string; description: string | null; photo: string | null; price: number; currency: string;
  stock: number | null; sold: number; status: "pending" | "available" | "closed"; kind: "physical" | "digital"; has_file: boolean; file_ext: string | null; created_at: string; updated_at: string;
};
export type NewShopItem = { name: string; description?: string | null; price: number; stock?: number | null; status?: ShopItem["status"]; kind?: ShopItem["kind"] };
export type LogRow = {
  id: string; actor_type: "admin" | "operator" | "customer" | "agent" | "system"; actor_id: string | null; actor_label: string | null;
  action: string; target_type: string | null; target_id: string | null; target_label: string | null; details: Record<string, unknown>; ip: string | null; created_at: string;
};
export type LogPage = { logs: LogRow[]; next_cursor: string | null };
export type LogFilter = { who?: string; action?: string; q?: string };

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

/** One settlement day: every merchant's payout or collection for that program day (the id is the date). */
export type SettlementRun = {
  id: string; cutoff_date: string; status: "submitted" | "completed" | "failed"; merchants: number; payout_total: number; collection_total: number;
  provider_reference: string | null; created_at: string; completed_at: string | null;
};
export type SettlementItem = {
  id: string; merchant_id: string; merchant: string; kind: "payout" | "collection"; amount: number; status: "submitted" | "settled" | "returned" | "failed";
  status_code: string | null; bank_last4: string | null;
};
export type SettlementRunResult =
  | { ran: false; reason: "no_provider" | "already_done" }
  | { ran: true; cutoff_date: string; created: number; payouts: number; collections: number; payout_total: number; collection_total: number; status: string };

/** The query string of a paged, filtered list. */
const listQuery = (q?: string, cursor?: string) => {
  const p = new URLSearchParams();
  if (q) p.set("q", q);
  if (cursor) p.set("cursor", cursor);
  const t = p.toString();
  return t ? `?${t}` : "";
};

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
  // Profile photos in transaction rows come as API paths too.
  const absParty = (p: TxParty | null): TxParty | null => (p ? absolutePhoto(p) : p);
  const absTx = <P extends { transactions: { from_party: TxParty | null; to_party: TxParty | null }[] }>(page: P): P =>
    ({ ...page, transactions: page.transactions.map((t) => ({ ...t, from_party: absParty(t.from_party), to_party: absParty(t.to_party) })) });
  return {
    me: () => request<AdminMe>("GET", "/v1/admin/me"),
    logout: () => request<null>("POST", "/v1/admin/logout"),
    merchants: (q?: string, cursor?: string) => request<{ merchants: MerchantRow[]; next_cursor: string | null; total: number; counts: Record<string, number> }>("GET", `/v1/admin/merchants${listQuery(q, cursor)}`),
    users: (q?: string, cursor?: string) => request<{ users: UserRow[]; next_cursor: string | null; total: number }>("GET", `/v1/admin/users${listQuery(q, cursor)}`),
    transactions: async (kind: TxKind = "all", cursor?: string, range: DayRange = {}) =>
      absTx(await request<TxPage>("GET", `/v1/admin/transactions?kind=${kind}${range.from ? `&from=${range.from}` : ""}${range.to ? `&to=${range.to}` : ""}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`)),
    organizations: (q?: string, cursor?: string) => request<{ organizations: OrganizationRow[]; next_cursor: string | null; total: number }>("GET", `/v1/admin/organizations${listQuery(q, cursor)}`),
    organization: async (id: string) => absolutePhoto((await request<{ organization: OrganizationDetailData }>("GET", `/v1/admin/organizations/${encodeURIComponent(id)}`)).organization),
    organizationEmployees: (id: string, q?: string, cursor?: string) =>
      request<{ employees: OrgEmployeeRow[]; next_cursor: string | null; total: number }>("GET", `/v1/admin/organizations/${encodeURIComponent(id)}/employees${[q ? `q=${encodeURIComponent(q)}` : "", cursor ? `cursor=${encodeURIComponent(cursor)}` : ""].filter(Boolean).map((x, i) => (i ? "&" : "?") + x).join("")}`),
    organizationRuns: async (id: string) => (await request<{ runs: OrgRunRow[] }>("GET", `/v1/admin/organizations/${encodeURIComponent(id)}/runs`)).runs,
    organizationDocuments: async (id: string) => (await request<{ documents: MerchantDocument[] }>("GET", `/v1/admin/organizations/${encodeURIComponent(id)}/documents`)).documents,
    downloadOrganizationDocument: async (id: string, uploadId: string): Promise<Blob> => {
      let res: Response;
      try { res = await fetch(`${base.replace(/\/$/, "")}/v1/admin/organizations/${encodeURIComponent(id)}/documents/${encodeURIComponent(uploadId)}`, { headers: { authorization: `Bearer ${token}` } }); }
      catch { throw new ApiError(0, "network_error"); }
      if (!res.ok) throw new ApiError(res.status, `http_${res.status}`);
      return res.blob();
    },
    setOrganizationStatus: (id: string, status: "active" | "suspended") =>
      request<{ organization: { id: string; status: string } }>("PUT", `/v1/admin/organizations/${encodeURIComponent(id)}/status`, { status }),
    organizationActivity: (id: string, cursor?: string) => request<LogPage>("GET", `/v1/admin/organizations/${encodeURIComponent(id)}/activity?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`),
    merchant: async (id: string) => absolutePhoto((await request<{ merchant: MerchantDetailData }>("GET", `/v1/admin/merchants/${encodeURIComponent(id)}`)).merchant),
    merchantTerminals: async (id: string) => (await request<{ terminals: MerchantTerminal[] }>("GET", `/v1/admin/merchants/${encodeURIComponent(id)}/terminals`)).terminals,
    merchantStaff: async (id: string) => (await request<{ staff: MerchantStaffRow[] }>("GET", `/v1/admin/merchants/${encodeURIComponent(id)}/staff`)).staff,
    merchantProducts: (id: string, cursor?: string) => request<{ products: MerchantProduct[]; next_cursor: string | null; total: number }>("GET", `/v1/admin/merchants/${encodeURIComponent(id)}/products${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`),
    merchantTransactions: async (id: string, kind: MerchantTxKind = "all", cursor?: string, range: DayRange = {}) =>
      absTx(await request<MerchantTxPage>("GET", `/v1/admin/merchants/${encodeURIComponent(id)}/transactions?kind=${kind}${range.from ? `&from=${range.from}` : ""}${range.to ? `&to=${range.to}` : ""}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`)),
    /** Business approval (Admin, Merchants): the uploaded documents, a download, and the decision. */
    merchantDocuments: async (id: string) => (await request<{ documents: MerchantDocument[] }>("GET", `/v1/admin/merchants/${encodeURIComponent(id)}/documents`)).documents,
    downloadMerchantDocument: async (id: string, uploadId: string): Promise<Blob> => {
      let res: Response;
      try { res = await fetch(`${base.replace(/\/$/, "")}/v1/admin/merchants/${encodeURIComponent(id)}/documents/${encodeURIComponent(uploadId)}`, { headers: { authorization: `Bearer ${token}` } }); }
      catch { throw new ApiError(0, "network_error"); }
      if (!res.ok) throw new ApiError(res.status, `http_${res.status}`);
      return res.blob();
    },
    /** Email one merchant, a list, or every active and/or pending merchant ({{name}} is filled in per merchant). */
    emailMerchants: (input: { merchant_ids?: string[]; audience?: "active" | "pending" | "active_pending"; subject: string; body: string }) =>
      request<EmailResult>("POST", "/v1/admin/merchants/email", input),
    approveMerchant: (id: string) => request<{ merchant: { id: string; status: string }; email: "sent" | "failed" | "not_configured" }>("POST", `/v1/admin/merchants/${encodeURIComponent(id)}/approve`),
    declineMerchant: (id: string, reason: string) => request<{ merchant: { id: string; status: string }; email: "sent" | "failed" | "not_configured" }>("POST", `/v1/admin/merchants/${encodeURIComponent(id)}/decline`, { reason }),
    /** Support action: signs a terminal out so its token stops working. */
    /** Admin: approve or reject a merchant's pending refund (approving moves the money now). */
    resolveMerchantRefund: (merchantId: string, refundId: string, action: "approve" | "reject") =>
      request<{ refund: { id: string; status: string; status_code: string | null } }>("POST", `/v1/admin/merchants/${encodeURIComponent(merchantId)}/refunds/${encodeURIComponent(refundId)}/${action}`),
    /** Admin: suspend or reactivate a merchant. */
    setMerchantStatus: (merchantId: string, status: "active" | "suspended") =>
      request<{ merchant: { id: string; status: string } }>("PUT", `/v1/admin/merchants/${encodeURIComponent(merchantId)}/status`, { status }),
    user: async (id: string) => absolutePhoto((await request<{ user: UserDetailData }>("GET", `/v1/admin/users/${encodeURIComponent(id)}`)).user),
    userWallets: async (id: string) => (await request<{ wallets: UserWallet[] }>("GET", `/v1/admin/users/${encodeURIComponent(id)}/wallets`)).wallets,
    userTags: async (id: string) => (await request<{ tags: UserTag[] }>("GET", `/v1/admin/users/${encodeURIComponent(id)}/tags`)).tags,
    userDevices: async (id: string) => (await request<{ devices: UserDevice[] }>("GET", `/v1/admin/users/${encodeURIComponent(id)}/devices`)).devices,
    userFunding: async (id: string) => (await request<{ funding: UserFunding }>("GET", `/v1/admin/users/${encodeURIComponent(id)}/funding`)).funding,
    userOrders: async (id: string) => (await request<{ orders: UserOrder[] }>("GET", `/v1/admin/users/${encodeURIComponent(id)}/orders`)).orders,
    userTransactions: async (id: string, kind: UserTxKind = "all", cursor?: string, range: DayRange = {}) =>
      absTx(await request<UserTxPage>("GET", `/v1/admin/users/${encodeURIComponent(id)}/transactions?kind=${kind}${range.from ? `&from=${range.from}` : ""}${range.to ? `&to=${range.to}` : ""}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`)),
    /** Support actions (Admin, Support): sign out everywhere, unlock the login, revoke an agent key. */
    signOutUser: (id: string) => request<{ signed_out: number }>("POST", `/v1/admin/users/${encodeURIComponent(id)}/sign-out`),
    unlockUserLogin: (id: string) => request<null>("POST", `/v1/admin/users/${encodeURIComponent(id)}/unlock-login`),
    revokeAgentKey: (walletId: string) => request<null>("POST", `/v1/admin/wallets/${encodeURIComponent(walletId)}/revoke-key`),
    /** Admin: suspend or reactivate a person, or one of their wallets. */
    setUserStatus: (id: string, status: "active" | "suspended") => request<{ user: { id: string; status: string } }>("PUT", `/v1/admin/users/${encodeURIComponent(id)}/status`, { status }),
    setWalletStatus: (walletId: string, status: "active" | "suspended") => request<{ wallet: { id: string; status: string } }>("PUT", `/v1/admin/wallets/${encodeURIComponent(walletId)}/status`, { status }),
    signOutTerminal: (id: string) => request<null>("POST", `/v1/admin/terminals/${encodeURIComponent(id)}/sign-out`),
    /** Settlement (Transactions page roles read; Admin runs and confirms). */
    settlements: async () => (await request<{ settlements: SettlementRun[] }>("GET", "/v1/admin/settlements")).settlements,
    settlement: async (date: string) => request<{ settlement: { id: string; cutoff_date: string; status: string; provider_reference: string | null }; items: SettlementItem[] }>("GET", `/v1/admin/settlements/${encodeURIComponent(date)}`),
    runSettlement: () => request<SettlementRunResult>("POST", "/v1/admin/settlements/run"),
    confirmSettlement: (date: string) => request<{ status: string; settled: number; returned: number }>("POST", `/v1/admin/settlements/${encodeURIComponent(date)}/confirm`),
    /** Admin: the bank returned a load that was already released (writes a fund_return; the person may end up in debt). */
    returnFunding: (id: string, code: string) => request<{ funding: { id: string; status: string }; transaction_id: string }>("POST", `/v1/admin/fundings/${encodeURIComponent(id)}/return`, { code }),
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
    /** The cached snapshot (cheap). */
    stats: () => request<Stats>("GET", "/v1/admin/stats"),
    /** Recompute the live numbers now (the API ignores it when they are only seconds old). */
    refreshStats: () => request<Stats>("POST", "/v1/admin/stats/refresh"),
    /** Recompute the ledger checks now (at most once a minute). */
    runReconciliation: () => request<Stats>("POST", "/v1/admin/stats/reconcile"),
    shopItems: async () => (await request<{ items: ShopItem[] }>("GET", "/v1/admin/shop-items")).items.map(absolutePhoto),
    createShopItem: async (i: NewShopItem) => (await request<{ item: ShopItem }>("POST", "/v1/admin/shop-items", i)).item,
    updateShopItem: async (id: string, patch: Partial<NewShopItem>) => (await request<{ item: ShopItem }>("PATCH", `/v1/admin/shop-items/${encodeURIComponent(id)}`, patch)).item,
    /** The downloadable file of a digital item (PDF, ZIP, EPUB, MP3, MP4, PNG, JPEG or TXT, 25 MB at most). */
    uploadShopItemFile: (id: string, file: Blob) => request<null>("PUT", `/v1/admin/shop-items/${encodeURIComponent(id)}/file`, file),
    uploadShopItemPhoto: (id: string, photo: Blob) => request<null>("PUT", `/v1/admin/shop-items/${encodeURIComponent(id)}/photo`, photo),
    /** The audit log, newest first. */
    logs: (f: LogFilter = {}, cursor?: string) => request<LogPage>("GET", `/v1/admin/logs?limit=50${f.who ? `&who=${encodeURIComponent(f.who)}` : ""}${f.action ? `&action=${encodeURIComponent(f.action)}` : ""}${f.q ? `&q=${encodeURIComponent(f.q)}` : ""}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`),
    userActivity: (id: string, cursor?: string) => request<LogPage>("GET", `/v1/admin/users/${encodeURIComponent(id)}/activity?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`),
    merchantActivity: (id: string, cursor?: string) => request<LogPage>("GET", `/v1/admin/merchants/${encodeURIComponent(id)}/activity?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`),
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
