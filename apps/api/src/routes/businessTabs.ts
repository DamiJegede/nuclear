import { Hono } from "hono";
import { z } from "zod";
import type { AppContext } from "../env";
import { customerLog } from "../lib/audit";
import { n } from "../lib/money";
import { uuid } from "../lib/validate";
import { newCode, addItem, businessTabs, cancelTab, clearTable, removeMember, setHost, setLocked, setServer, tabView, voidItem, payTab } from "../lib/tabs";
import { paymentsJson, payBody, run } from "./tabs";
import { TabError } from "../lib/tabs";

/**
 * The merchant side of tabs (docs/TABS.md), mounted under /v1/business with the owner's session: the tables (each with its QR / NFC link) and the staff actions on open
 * tabs. Every action is audited. A manager's actions (Pay for a host who has gone, Clear Table) are the owner's today; staff roles come with STF-01.
 */
export const businessTabsRoutes = new Hono<AppContext>();
export const TABLE_LINK_BASE = "https://nclr.app/t/";

type TableRow = { id: string; name: string; code: string; served_by: string | null; active: boolean; created_at: Date; open_tab: string | null };
const tableJson = (t: TableRow) => ({ id: t.id, name: t.name, code: t.code, link: TABLE_LINK_BASE + t.code, served_by: t.served_by, active: t.active, open_tab_id: t.open_tab, created_at: t.created_at });
const TABLE_SELECT = (sql: import("../db").Sql, merchant: string, id?: string) => sql<TableRow[]>`
  select v.id, v.name, v.code, v.served_by, v.active, v.created_at, (select t.id from tabs t where t.table_id = v.id and t.status in ('open', 'paying')) as open_tab
    from venue_tables v where v.account_id = ${merchant} ${id ? sql`and v.id = ${id}` : sql``} order by v.created_at, v.id`;

const name = z.string().trim().min(1).max(60);
const servedBy = uuid.nullable().optional();
async function checkServer(sql: import("../db").Sql, merchant: string, staff: string | null | undefined) {
  if (!staff) return;
  const [s] = await sql<{ id: string }[]>`select staff_account_id as id from staff where account_id = ${merchant} and staff_account_id = ${staff}`;
  if (!s && staff !== merchant) throw new TabError(404, "staff_not_found");
}

businessTabsRoutes.get("/tables", async (c) => c.json({ tables: (await TABLE_SELECT(c.get("sql"), c.get("auth").accountId)).map(tableJson) }));
businessTabsRoutes.post("/tables", async (c) => run(c, async () => {
  const b = z.object({ name, served_by: servedBy }).safeParse(await c.req.json().catch(() => ({})));
  if (!b.success) return c.json({ error: "invalid_request", issues: b.error.flatten() }, 400);
  const sql = c.get("sql"), merchant = c.get("auth").accountId;
  await checkServer(sql, merchant, b.data.served_by);
  const [t] = await sql<{ id: string }[]>`insert into venue_tables (account_id, name, code, served_by) values (${merchant}, ${b.data.name}, ${newCode()}, ${b.data.served_by ?? null}) returning id`;
  await customerLog(c, merchant, null, "tab.table_created", { table_id: t!.id, name: b.data.name });
  return c.json({ table: tableJson((await TABLE_SELECT(sql, merchant, t!.id))[0]!) }, 201);
}));
businessTabsRoutes.patch("/tables/:id", async (c) => run(c, async () => {
  const id = uuid.safeParse(c.req.param("id"));
  const b = z.object({ name: name.optional(), active: z.boolean().optional(), served_by: servedBy }).safeParse(await c.req.json().catch(() => ({})));
  if (!id.success || !b.success) return c.json({ error: "invalid_request" }, 400);
  const sql = c.get("sql"), merchant = c.get("auth").accountId;
  await checkServer(sql, merchant, b.data.served_by);
  const [t] = await sql<{ id: string }[]>`
    update venue_tables set name = coalesce(${b.data.name ?? null}, name), active = coalesce(${b.data.active ?? null}, active),
           served_by = case when ${"served_by" in b.data} then ${b.data.served_by ?? null}::uuid else served_by end
     where id = ${id.data} and account_id = ${merchant} returning id`;
  if (!t) return c.json({ error: "table_not_found" }, 404);
  await customerLog(c, merchant, null, "tab.table_updated", { table_id: id.data });
  return c.json({ table: tableJson((await TABLE_SELECT(sql, merchant, id.data))[0]!) });
}));
businessTabsRoutes.post("/tables/:id/rotate-code", async (c) => run(c, async () => {
  const id = uuid.safeParse(c.req.param("id"));
  if (!id.success) return c.json({ error: "invalid_request" }, 400);
  const sql = c.get("sql"), merchant = c.get("auth").accountId;
  const [t] = await sql<{ id: string }[]>`update venue_tables set code = ${newCode()} where id = ${id.data} and account_id = ${merchant} returning id`;
  if (!t) return c.json({ error: "table_not_found" }, 404);
  await customerLog(c, merchant, null, "tab.table_code_rotated", { table_id: id.data });
  return c.json({ table: tableJson((await TABLE_SELECT(sql, merchant, id.data))[0]!) });
}));
businessTabsRoutes.delete("/tables/:id", async (c) => run(c, async () => {
  const id = uuid.safeParse(c.req.param("id"));
  if (!id.success) return c.json({ error: "invalid_request" }, 400);
  const sql = c.get("sql"), merchant = c.get("auth").accountId;
  const [used] = await sql<{ n: number }[]>`select count(*)::int as n from tabs where table_id = ${id.data}`;
  if (used!.n > 0) return c.json({ error: "table_in_use" }, 409);       // a table with history is deactivated, not deleted
  const r = await sql`delete from venue_tables where id = ${id.data} and account_id = ${merchant} returning id`;
  if (r.length === 0) return c.json({ error: "table_not_found" }, 404);
  await customerLog(c, merchant, null, "tab.table_deleted", { table_id: id.data });
  return c.body(null, 204);
}));

// ---- tabs
const STATUS = z.enum(["open", "paying", "unpaid", "closed", "canceled", "expired"]);
businessTabsRoutes.get("/tabs", async (c) => {
  const s = STATUS.safeParse(c.req.query("status"));
  const rows = await businessTabs(c.get("sql"), c.get("auth").accountId, s.success ? s.data : null);
  return c.json({ tabs: rows.map((r) => ({ id: r.id, status: r.status, mode: r.mode, table: r.table_name, members: r.members, items: n(r.items), opened_at: r.opened_at, closed_at: r.closed_at, unpaid_at: r.unpaid_at })) });
});
const tabId = (c: import("hono").Context<AppContext>) => { const id = uuid.safeParse(c.req.param("id")); if (!id.success) throw new TabError(400, "invalid_request"); return id.data; };
const staff = (c: import("hono").Context<AppContext>) => ({ kind: "staff" as const, accountId: c.get("auth").accountId });
const view = (c: import("hono").Context<AppContext>, id: string) => tabView(c.get("sql"), id, { kind: "staff" });

businessTabsRoutes.get("/tabs/:id", async (c) => run(c, async () => {
  const id = tabId(c);
  const [t] = await c.get("sql")<{ account_id: string }[]>`select account_id from tabs where id = ${id}`;
  if (!t || t.account_id !== c.get("auth").accountId) return c.json({ error: "tab_not_found" }, 404);
  return { tab: await view(c, id) };
}));
businessTabsRoutes.post("/tabs/:id/items", async (c) => run(c, async () => {
  const id = tabId(c);
  const b = z.object({ product_id: uuid, quantity: z.number().int().min(1).max(1000), note: z.string().trim().max(80).optional(), wallet_id: uuid.optional(), table: z.boolean().optional() }).safeParse(await c.req.json().catch(() => ({})));
  if (!b.success) return c.json({ error: "invalid_request" }, 400);
  if ((b.data.wallet_id === undefined) === (b.data.table !== true)) return c.json({ error: "invalid_request" }, 400);   // exactly one: a member or the Table
  const r = await addItem(c.get("sql"), staff(c), id, b.data);
  await customerLog(c, c.get("auth").accountId, null, "tab.item_added_by_staff", { tab_id: id, item_id: r.id, wallet_id: b.data.wallet_id ?? "table" });
  return c.json({ item_id: r.id, tab: await view(c, id) }, 201);
}));
businessTabsRoutes.post("/tabs/:id/items/:itemId/void", async (c) => run(c, async () => {
  const id = tabId(c);
  const item = uuid.safeParse(c.req.param("itemId"));
  if (!item.success) return c.json({ error: "invalid_request" }, 400);
  await voidItem(c.get("sql"), staff(c), id, item.data);
  await customerLog(c, c.get("auth").accountId, null, "tab.item_voided_by_staff", { tab_id: id, item_id: item.data });
  return { tab: await view(c, id) };
}));
businessTabsRoutes.post("/tabs/:id/members/:wallet/remove", async (c) => run(c, async () => {
  const id = tabId(c);
  const w = uuid.safeParse(c.req.param("wallet"));
  if (!w.success) return c.json({ error: "invalid_request" }, 400);
  await removeMember(c.get("sql"), c.get("auth").accountId, id, w.data);
  await customerLog(c, c.get("auth").accountId, null, "tab.member_removed", { tab_id: id, wallet_id: w.data });
  return { tab: await view(c, id) };
}));
businessTabsRoutes.post("/tabs/:id/lock", async (c) => run(c, async () => {
  const id = tabId(c);
  const b = z.object({ locked: z.boolean() }).safeParse(await c.req.json().catch(() => ({})));
  if (!b.success) return c.json({ error: "invalid_request" }, 400);
  await setLocked(c.get("sql"), staff(c), id, b.data.locked);
  await customerLog(c, c.get("auth").accountId, null, "tab.lock", { tab_id: id, locked: b.data.locked });
  return { tab: await view(c, id) };
}));
businessTabsRoutes.post("/tabs/:id/server", async (c) => run(c, async () => {
  const id = tabId(c);
  const b = z.object({ staff_account_id: uuid.nullable() }).safeParse(await c.req.json().catch(() => ({})));
  if (!b.success) return c.json({ error: "invalid_request" }, 400);
  await setServer(c.get("sql"), c.get("auth").accountId, id, b.data.staff_account_id);
  await customerLog(c, c.get("auth").accountId, null, "tab.server_set", { tab_id: id, staff_account_id: b.data.staff_account_id });
  return { tab: await view(c, id) };
}));
businessTabsRoutes.post("/tabs/:id/host", async (c) => run(c, async () => {
  const id = tabId(c);
  const b = z.object({ wallet_id: uuid }).safeParse(await c.req.json().catch(() => ({})));
  if (!b.success) return c.json({ error: "invalid_request" }, 400);
  await setHost(c.get("sql"), staff(c), id, b.data.wallet_id);
  await customerLog(c, c.get("auth").accountId, null, "tab.host_set", { tab_id: id, wallet_id: b.data.wallet_id });
  return { tab: await view(c, id) };
}));
businessTabsRoutes.post("/tabs/:id/pay", async (c) => run(c, async () => {
  const id = tabId(c);
  const b = payBody.pick({ version: true }).safeParse(await c.req.json().catch(() => ({})));
  if (!b.success) return c.json({ error: "invalid_request" }, 400);
  const r = await payTab(c.get("sql"), staff(c), id, b.data.version);
  await customerLog(c, c.get("auth").accountId, null, "tab.closed_by_staff", { tab_id: id, payments: r.payments.length });
  return { payments: await paymentsJson(c, r), tab: await view(c, id) };
}));
businessTabsRoutes.post("/tabs/:id/clear", async (c) => run(c, async () => {
  const id = tabId(c);
  try {
    const r = await clearTable(c.get("sql"), c.get("auth").accountId, id);
    await customerLog(c, c.get("auth").accountId, null, "tab.cleared", { tab_id: id, result: r.status });
    return { status: r.status, tab: await view(c, id) };
  } catch (e) {
    // a shortfall still frees the table: the tab is now unpaid
    if (e instanceof TabError && e.code === "shortfall") {
      await customerLog(c, c.get("auth").accountId, null, "tab.cleared", { tab_id: id, result: "unpaid" });
      return { status: "unpaid", short: e.extra.short, tab: await view(c, id) };
    }
    throw e;
  }
}));
businessTabsRoutes.post("/tabs/:id/cancel", async (c) => run(c, async () => {
  const id = tabId(c);
  const r = await cancelTab(c.get("sql"), c.get("auth").accountId, id);
  await customerLog(c, c.get("auth").accountId, null, "tab.canceled", { tab_id: id });
  return { status: r.status, tab: await view(c, id) };
}));
