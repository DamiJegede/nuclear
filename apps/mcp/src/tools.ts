/** The tools an agent sees. Each maps to one or two calls on the Nuclear API, made with the agent's own key. */
export type Api = (method: string, path: string, body?: unknown, idempotencyKey?: string) => Promise<{ status: number; json: any }>;

export type Tool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  run: (args: Record<string, unknown>, api: Api) => Promise<unknown>;
};

export class ToolError extends Error {
  constructor(public detail: unknown) { super("tool_error"); }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fail = (error: string, extra: object = {}) => { throw new ToolError({ error, ...extra }); };

function amount(v: unknown): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v <= 0 || v > 1_000_000_000) {
    fail("invalid_amount", { message: "amount_cents must be a positive whole number of cents (100 = $1.00)." });
  }
  return v as number;
}
function uuid(v: unknown, field: string): string {
  if (typeof v !== "string" || !UUID.test(v)) fail("invalid_" + field, { message: `${field} must be a UUID.` });
  return v as string;
}
function key(v: unknown): string {
  if (typeof v !== "string" || v.length < 8 || v.length > 100 || !/^[\w.:-]+$/.test(v)) {
    fail("invalid_idempotency_key", { message: "idempotency_key must be 8-100 characters (letters, digits, - _ . :). Use one new value per intended payment and reuse it when retrying." });
  }
  return v as string;
}

/** Turns an API answer into a tool result, or throws the API's error so the agent sees why it failed. */
function unwrap(r: { status: number; json: any }) {
  if (r.status >= 200 && r.status < 300) return r.json;
  throw new ToolError({ error: r.json?.error ?? `http_${r.status}`, ...(r.json?.status_code ? { status_code: r.json.status_code } : {}), ...(r.json?.retry_after ? { retry_after_seconds: r.json.retry_after, message: "Too many requests: wait this many seconds before trying again." } : {}) });
}

export const TOOLS: Tool[] = [
  {
    name: "get_wallet",
    description:
      "Your own wallet: its id (give this to others so they can send you money), name, spending balance and limits. " +
      "All money amounts are integer cents (100 = $1.00), USD. `balance` is the money set aside for you by your owner and is a hard limit: " +
      "you can never spend more than it. `can_send` / `can_pay` say whether you have permission; `max_send_cents` / `max_pay_cents` are the most you can send or pay in one go right now (permission, balance and the rest of your daily limit combined). `daily_limit` (null = none), `spent_today` and `remaining_today` show the daily limit, which resets at midnight Eastern. There is no separate per-transaction limit.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
    async run(_args, api) {
      const w = unwrap(await api("GET", "/v1/wallets")).wallets?.[0];
      if (!w) fail("wallet_not_found");
      const b = unwrap(await api("GET", "/v1/balance"));
      // What the agent can actually do right now: permission, balance and what is left of the daily limit together.
      const left = (v: number) => (w.remaining_today === null ? v : Math.min(v, w.remaining_today));
      const active = w.status === "active";
      const canSend = active && w.allow_send === true;
      const canPay = active && w.allow_pay === true;
      return {
        wallet_id: w.id, name: w.display_name, currency: "USD", status: w.status,
        can_send: canSend, can_pay: canPay,
        max_send_cents: canSend ? left(b.available_to_send) : 0,
        max_pay_cents: canPay ? left(b.available_to_pay) : 0,
        balance: w.balance, available_to_send: b.available_to_send, available_to_pay: b.available_to_pay,
        allow_send: w.allow_send, allow_pay: w.allow_pay,
        daily_limit: w.daily_limit, spent_today: w.spent_today, remaining_today: w.remaining_today,
        per_transaction_limit: null,
      };
    },
  },
  {
    name: "lookup_recipient",
    description:
      "Find the wallet to send money to. Give a person's handle (4-12 letters and digits, no @) or their exact email address. " +
      "Returns the wallet_id to use with send_money.",
    inputSchema: {
      type: "object",
      properties: { handle: { type: "string", description: "Their handle, without @." }, email: { type: "string", description: "Their exact email address." } },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
    async run(args, api) {
      const handle = typeof args.handle === "string" ? args.handle.trim().replace(/^@/, "") : "";
      const email = typeof args.email === "string" ? args.email.trim() : "";
      if ((handle === "") === (email === "")) fail("invalid_request", { message: "Give exactly one of handle or email." });
      const r = handle
        ? await api("GET", `/v1/handles/${encodeURIComponent(handle)}`)
        : await api("POST", "/v1/recipients/lookup", { email });
      if (r.status === 404) fail("not_found", { message: "No active person matches that." });
      const j = unwrap(r);
      if (j.type === "B") fail("not_found", { message: "That is a business, not a person. Use pay_merchant for businesses." });
      return { wallet_id: j.wallet_id, display_name: j.display_name, handle: j.handle ?? null };
    },
  },
  {
    name: "send_money",
    description:
      "Send money from your wallet to another person's wallet. The recipient must be a different person (not a business, not your own owner's wallets). " +
      "Fails if you lack sending permission, exceed your balance or daily limit. Always pass a fresh idempotency_key per intended payment, and reuse the SAME key if you need to retry: the money moves at most once.",
    inputSchema: {
      type: "object",
      properties: {
        to_wallet_id: { type: "string", description: "The recipient's wallet_id (from lookup_recipient)." },
        amount_cents: { type: "integer", minimum: 1, description: "Amount in cents; 100 = $1.00." },
        idempotency_key: { type: "string", description: "Unique per intended payment; reuse when retrying. 8-100 characters." },
      },
      required: ["to_wallet_id", "amount_cents", "idempotency_key"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    async run(args, api) {
      const r = await api("POST", "/v1/transfers", { to_wallet_id: uuid(args.to_wallet_id, "to_wallet_id"), amount: amount(args.amount_cents) }, key(args.idempotency_key));
      const j = r.json;
      if (r.status === 422 && j?.error === "declined") throw new ToolError({ error: "declined", status_code: j.status_code, message: "The payment was declined; no money moved." });
      const t = unwrap(r).transaction;
      return { status: t.status, transaction_id: t.id, amount_cents: t.amount, completed_at: t.completed_at };
    },
  },
  {
    name: "pay_merchant",
    description:
      "Pay a merchant from your wallet. Give the merchant's terminal_id and an amount_cents, or a checkout_id the merchant created. " +
      "Requires payment permission and enough balance. Always pass a fresh idempotency_key per intended payment; reuse it when retrying.",
    inputSchema: {
      type: "object",
      properties: {
        terminal_id: { type: "string", description: "The merchant terminal to pay (with amount_cents)." },
        checkout_id: { type: "string", description: "An existing checkout to pay (instead of terminal_id and amount_cents)." },
        amount_cents: { type: "integer", minimum: 1, description: "Amount in cents; 100 = $1.00. Not used with checkout_id." },
        reference: { type: "string", maxLength: 100, description: "Optional note shown to the merchant." },
        idempotency_key: { type: "string", description: "Unique per intended payment; reuse when retrying. 8-100 characters." },
      },
      required: ["idempotency_key"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    async run(args, api) {
      const idem = key(args.idempotency_key);
      const body: Record<string, unknown> = {};
      if (args.checkout_id !== undefined) {
        if (args.terminal_id !== undefined || args.amount_cents !== undefined) fail("invalid_request", { message: "With checkout_id, do not also give terminal_id or amount_cents." });
        body.checkout_id = uuid(args.checkout_id, "checkout_id");
      } else {
        body.terminal_id = uuid(args.terminal_id, "terminal_id");
        body.amount = amount(args.amount_cents);
      }
      if (typeof args.reference === "string" && args.reference.trim()) body.reference = args.reference.trim().slice(0, 100);
      const r = await api("POST", "/v1/payments", body, idem);
      if (r.status === 422 && r.json?.error === "declined") throw new ToolError({ error: "declined", status_code: r.json.status_code, message: "The payment was declined; no money moved." });
      const p = unwrap(r).payment;
      return { status: p.status, payment_id: p.id, amount_cents: p.amount, reference: p.reference ?? null };
    },
  },
  {
    name: "list_activity",
    description: "Your recent transactions (sent, received, payments), newest first. Amounts are integer cents.",
    inputSchema: { type: "object", properties: { limit: { type: "integer", minimum: 1, maximum: 50, description: "How many to return (default 20)." } }, additionalProperties: false },
    annotations: { readOnlyHint: true },
    async run(args, api) {
      const limit = typeof args.limit === "number" && Number.isInteger(args.limit) ? Math.min(Math.max(args.limit, 1), 50) : 20;
      const j = unwrap(await api("GET", `/v1/activity?limit=${limit}`));
      return {
        items: (j.items ?? []).map((i: any) => ({
          id: i.id, type: i.type, direction: i.direction, status: i.status, status_code: i.status_code ?? null,
          amount_cents: i.amount, counterparty: i.counterparty?.display_name ?? null, timestamp: i.timestamp,
        })),
        next_cursor: j.next_cursor ?? null,
      };
    },
  },
];
