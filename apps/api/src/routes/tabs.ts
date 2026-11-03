import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { z } from "zod";
import type { AppContext } from "../env";
import { imageUrl } from "../lib/images";
import { RULES, byAccount, byIp, rateLimit } from "../lib/throttle";
import { receiptUrl } from "../lib/receiptLink";
import { track } from "../lib/tracker";
import { n } from "../lib/money";
import { uuid } from "../lib/validate";
import { requireDeviceSession } from "../session";
import {
  TabError, addCovers, addItem, closeMyTab, declineCover, isMode, joinByInvite, leave, loadState, myTabs, openFree, openOrJoinByCode, payTab, ready, reopenPosition, reopenTab,
  setHost, setLocked, setMode, setTip, setTipLimit, stopCover, tabView, tableByCode, voidItem, type PayResult,
} from "../lib/tabs";

/**
 * Shared tabs for customers (docs/TABS.md): `/v1/menu/:code` (public), `/v1/tab-codes/*` (what a table's QR code or NFC cube opens) and `/v1/tabs/*`. A person acts with a
 * wallet: the delegated session's own wallet, or one of the owner's (`wallet_id`, default the default wallet). Agent keys cannot join tabs.
 */
export const menu = new Hono<AppContext>();
export const tabCodes = new Hono<AppContext>();
export const tabs = new Hono<AppContext>();
menu.use("*", cors({ origin: "*", allowMethods: ["GET"], maxAge: 600 }));   // the menu is public and read-only: the website page reads it from the browser
tabCodes.use("*", requireDeviceSession);
tabs.use("*", requireDeviceSession);

type Fn = () => Promise<Response | object>;
/** Runs a tab operation: a TabError is the refusal (its status and code), anything else is a real error. */
export async function run(c: Context<AppContext>, fn: Fn): Promise<Response> {
  try {
    const r = await fn();
    return r instanceof Response ? r : c.json(r);
  } catch (e) {
    if (e instanceof TabError) return c.json({ error: e.code, ...e.extra }, e.status as 400);
    throw e;
  }
}
const actorOf = (c: Context<AppContext>) => { const a = c.get("auth"); return { accountId: a.accountId, walletId: a.walletId, sessionKind: a.kind as "owner" | "wallet" }; };
const memberActor = (c: Context<AppContext>) => ({ kind: "member" as const, ...actorOf(c) });
const viewerOf = async (c: Context<AppContext>) => {
  const a = c.get("auth");
  const rows = a.kind === "wallet" ? [{ id: a.walletId! }] : await c.get("sql")<{ id: string }[]>`select id from wallets where account_id = ${a.accountId}`;
  return { kind: "member" as const, walletIds: rows.map((r) => r.id) };
};
const walletId = z.object({ wallet_id: uuid.optional() });
const parse = async <T extends z.ZodTypeAny>(c: Context<AppContext>, schema: T) => {
  const b = schema.safeParse(await c.req.json().catch(() => ({})));
  if (!b.success) throw new TabError(400, "invalid_request", { issues: b.error.flatten() });
  return b.data as z.infer<T>;
};
const tipLimit = z.number().int().min(0).max(10000);

// ---- the menu behind a table's code: public, read-only, no tab data
menu.get("/:code", async (c) => {
  const sql = c.get("sql");
  const t = await tableByCode(sql, c.req.param("code"));
  if (!t) return c.json({ error: "table_not_found" }, 404);
  const [[m], [tax], products] = await Promise.all([
    sql<{ id: string; name: string; photo: string | null }[]>`select id, name, photo from accounts where id = ${t.account_id}`,
    sql<{ rate: number; included: boolean }[]>`select coalesce(tax_rate, 0) as rate, coalesce(tax_included, false) as included from businesses where account_id = ${t.account_id}`,
    sql<{ id: string; name: string; price: bigint; discount: bigint; photo: string | null; taxable: boolean; category: string | null }[]>`
      select p.id, p.name, p.price, p.discount, p.photo, p.taxable, c.name as category
        from products p left join categories c on c.id = p.category_id
       where p.account_id = ${t.account_id} and p.active and p.status = 'available' and (c.id is null or c.active) order by c.name nulls last, p.name, p.id limit 500`,
  ]);
  return c.json({
    merchant: { name: m!.name, photo: imageUrl(m!.photo) }, table: { name: t.name }, tax: { rate: tax?.rate ?? 0, included: tax?.included ?? false },
    products: products.map((p) => ({ id: p.id, name: p.name, price: n(p.price), discount: n(p.discount), photo: imageUrl(p.photo), taxable: p.taxable, category: p.category })),
  });
});

// ---- scanning a code: who is on the table's tab (never joins by itself)
tabCodes.get("/:code", async (c) => {
  const sql = c.get("sql");
  const t = await tableByCode(sql, c.req.param("code"));
  if (!t) return c.json({ error: "table_not_found" }, 404);
  const [open] = await sql<{ id: string; status: string; locked: boolean; split_mode: string }[]>`select id, status, locked, split_mode from tabs where table_id = ${t.id} and status in ('open', 'paying')`;
  if (!open) return c.json({ table: { id: t.id, name: t.name }, tab: null });
  const st = await loadState(sql, open.id);
  return c.json({
    table: { id: t.id, name: t.name },
    tab: {
      id: open.id, status: open.status, mode: open.split_mode, locked: open.locked, joinable: open.status === "open" && !open.locked,
      members: st.members.filter((m) => m.removed_at === null).map((m) => ({ wallet_id: m.wallet_id, name: m.name, photo: imageUrl(m.photo), host: m.wallet_id === st.tab.host_wallet_id })),
    },
  });
});

const joinBody = z.object({ wallet_id: uuid.optional(), max_tip_bps: tipLimit.optional() });
const joinLimits = [rateLimit("tabjoin", RULES.tabJoin, byAccount), rateLimit("tabjoin-ip", RULES.tabJoinIp, byIp)] as const;
tabCodes.post("/:code/join", ...joinLimits, async (c) => run(c, async () => {
  const b = await parse(c, joinBody);
  const r = await openOrJoinByCode(c.get("sql"), actorOf(c), c.req.param("code"), b);
  const view = await tabView(c.get("sql"), r.id, await viewerOf(c));
  return c.json({ created: r.created, tab: view }, r.created ? 201 : 200);
}));

tabs.post("/join", ...joinLimits, async (c) => run(c, async () => {
  const b = await parse(c, joinBody.extend({ invite_code: z.string().min(16).max(64) }));
  const r = await joinByInvite(c.get("sql"), actorOf(c), b.invite_code, b);
  return c.json({ tab: await tabView(c.get("sql"), r.id, await viewerOf(c)) });
}));

// a tab with no table (counter, bar, takeaway)
tabs.post("/", async (c) => run(c, async () => {
  const b = await parse(c, joinBody.extend({ merchant_id: uuid }));
  const r = await openFree(c.get("sql"), actorOf(c), b.merchant_id, b);
  return c.json({ created: true, tab: await tabView(c.get("sql"), r.id, await viewerOf(c)) }, 201);
}));

tabs.get("/", async (c) => {
  const rows = await myTabs(c.get("sql"), c.get("auth").accountId);
  return c.json({ tabs: rows.map((r) => ({ id: r.id, status: r.status, mode: r.mode, merchant: r.merchant_name, table: r.table_name, opened_at: r.opened_at, closed_at: r.closed_at, wallet_id: r.wallet_id })) });
});

tabs.get("/:id", async (c) => run(c, async () => {
  const id = uuid.safeParse(c.req.param("id"));
  if (!id.success) return c.json({ error: "invalid_request" }, 400);
  const sql = c.get("sql");
  const viewer = await viewerOf(c);
  const [m] = await sql<{ v: number }[]>`
    select t.version as v from tab_members m join tabs t on t.id = m.tab_id where m.tab_id = ${id.data} and m.account_id = ${c.get("auth").accountId}
       ${c.get("auth").kind === "wallet" ? sql`and m.wallet_id = ${c.get("auth").walletId}` : sql``} limit 1`;
  if (!m) return c.json({ error: "tab_not_found" }, 404);
  const since = Number(c.req.query("since"));
  if (Number.isInteger(since) && since === m.v) return c.json({ unchanged: true, version: m.v });
  return c.json({ tab: await tabView(sql, id.data, viewer) });
}));

const idParam = (c: Context<AppContext>) => { const id = uuid.safeParse(c.req.param("id")); if (!id.success) throw new TabError(400, "invalid_request"); return id.data; };
const refreshed = async (c: Context<AppContext>, id: string, extra: object = {}) => ({ ...extra, tab: await tabView(c.get("sql"), id, await viewerOf(c)) });

tabs.post("/:id/items", async (c) => run(c, async () => {
  const id = idParam(c);
  const b = await parse(c, walletId.extend({ product_id: uuid, quantity: z.number().int().min(1).max(1000), note: z.string().trim().max(80).optional() }));
  const r = await addItem(c.get("sql"), memberActor(c), id, b);
  return c.json(await refreshed(c, id, { item_id: r.id }), 201);
}));
tabs.delete("/:id/items/:itemId", async (c) => run(c, async () => {
  const id = idParam(c);
  const item = uuid.safeParse(c.req.param("itemId"));
  if (!item.success) return c.json({ error: "invalid_request" }, 400);
  await voidItem(c.get("sql"), memberActor(c), id, item.data, c.req.query("wallet_id") ?? null);
  return refreshed(c, id);
}));

tabs.post("/:id/settle", async (c) => run(c, async () => {
  const id = idParam(c);
  const b = await parse(c, walletId.extend({ amount: z.number().int().min(1).max(1_000_000_000).optional() }));
  const r = await closeMyTab(c.get("sql"), actorOf(c), id, b);
  return refreshed(c, id, { hold: r.amount });
}));
tabs.post("/:id/reopen-position", async (c) => run(c, async () => {
  const id = idParam(c);
  const b = await parse(c, walletId);
  await reopenPosition(c.get("sql"), actorOf(c), id, b.wallet_id);
  return refreshed(c, id);
}));
tabs.put("/:id/tip-limit", async (c) => run(c, async () => {
  const id = idParam(c);
  const b = await parse(c, walletId.extend({ max_tip_bps: tipLimit }));
  await setTipLimit(c.get("sql"), actorOf(c), id, b.max_tip_bps, b.wallet_id);
  return refreshed(c, id);
}));

tabs.put("/:id/mode", async (c) => run(c, async () => {
  const id = idParam(c);
  const b = await parse(c, walletId.extend({ mode: z.string().refine(isMode), cover_cap: z.number().int().min(1).max(1_000_000_000).nullable().optional() }));
  await setMode(c.get("sql"), memberActor(c), id, { mode: b.mode as "own", cover_cap: b.cover_cap ?? null, wallet_id: b.wallet_id });
  return refreshed(c, id);
}));

tabs.post("/:id/covers", async (c) => run(c, async () => {
  const id = idParam(c);
  const b = await parse(c, walletId.extend({ wallet_ids: z.array(uuid).max(20).optional(), table: z.boolean().optional(), cap: z.number().int().min(1).max(1_000_000_000).nullable().optional() }));
  await addCovers(c.get("sql"), actorOf(c), id, b);
  return refreshed(c, id);
}));
tabs.delete("/:id/covers/:wallet", async (c) => run(c, async () => {
  const id = idParam(c);
  const w = c.req.param("wallet");
  await stopCover(c.get("sql"), actorOf(c), id, w === "table" ? null : uuid.parse(w), c.req.query("wallet_id") ?? null);
  return refreshed(c, id);
}));
tabs.post("/:id/covers/decline", async (c) => run(c, async () => {
  const id = idParam(c);
  const b = await parse(c, walletId);
  await declineCover(c.get("sql"), actorOf(c), id, b.wallet_id);
  return refreshed(c, id);
}));

tabs.post("/:id/ready", async (c) => run(c, async () => {
  const id = idParam(c);
  const b = await parse(c, walletId);
  await ready(c.get("sql"), memberActor(c), id, b.wallet_id);
  return refreshed(c, id);
}));
tabs.post("/:id/reopen", async (c) => run(c, async () => {
  const id = idParam(c);
  const b = await parse(c, walletId);
  await reopenTab(c.get("sql"), memberActor(c), id, b.wallet_id);
  return refreshed(c, id);
}));
tabs.put("/:id/tip", async (c) => run(c, async () => {
  const id = idParam(c);
  const b = await parse(c, walletId.extend({ mode: z.enum(["none", "percent", "amount"]), value: z.number().int().min(0).max(1_000_000_000).optional() }));
  await setTip(c.get("sql"), memberActor(c), id, b);
  return refreshed(c, id);
}));

export const payBody = z.object({ wallet_id: uuid.optional(), version: z.number().int().min(1) });
export async function paymentsJson(c: Context<AppContext>, r: PayResult) {
  const out = await Promise.all(r.payments.map(async (p) => ({ wallet_id: p.wallet_id, transaction_id: p.transaction_id, amount: p.amount, receipt_url: await receiptUrl(c, p.transaction_id) })));
  if (!r.replayed && out.length > 0) track(c, { in_app_n: out.length, in_app_v: out.reduce((s, p) => s + p.amount, 0) });
  return out;
}
tabs.post("/:id/pay", async (c) => run(c, async () => {
  const id = idParam(c);
  const b = await parse(c, payBody);
  const r = await payTab(c.get("sql"), memberActor(c), id, b.version, { wallet_id: b.wallet_id });
  return refreshed(c, id, { payments: await paymentsJson(c, r), replayed: r.replayed });
}));
tabs.post("/:id/clear", async (c) => run(c, async () => {
  const id = idParam(c);
  const b = await parse(c, payBody);
  const r = await payTab(c.get("sql"), memberActor(c), id, b.version, { wallet_id: b.wallet_id, clear: true });
  return refreshed(c, id, { payments: await paymentsJson(c, r), replayed: r.replayed });
}));

tabs.post("/:id/leave", async (c) => run(c, async () => {
  const id = idParam(c);
  const b = await parse(c, walletId);
  const r = await leave(c.get("sql"), actorOf(c), id, b.wallet_id);
  return { left: r.left, away: r.away };
}));
tabs.post("/:id/lock", async (c) => run(c, async () => {
  const id = idParam(c);
  const b = await parse(c, walletId.extend({ locked: z.boolean() }));
  await setLocked(c.get("sql"), memberActor(c), id, b.locked, b.wallet_id);
  return refreshed(c, id);
}));
tabs.post("/:id/host", async (c) => run(c, async () => {
  const id = idParam(c);
  const b = await parse(c, walletId.extend({ new_host_wallet_id: uuid }));
  await setHost(c.get("sql"), memberActor(c), id, b.new_host_wallet_id, b.wallet_id);
  return refreshed(c, id);
}));
