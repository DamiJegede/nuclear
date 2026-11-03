import { randomBytes } from "node:crypto";
import type { TransactionSql } from "postgres";
import type { Sql } from "../db";
import { imageUrl } from "./images";
import { callMoney, isUniqueViolation } from "./txn";
import { ceilingFor, quoteTab, type Quote, type QInput, type TabMode } from "./tabQuote";

/**
 * Shared tabs (docs/TABS.md). Ordering, joining and the other order state are plain TypeScript; the three SQL functions touch money (app_tab_settle holds a member's funds,
 * app_tab_release gives holds back, app_close_tab pays). The allocation of the bill to paying wallets is lib/tabQuote.ts (pure); app_close_tab checks the tab's version
 * under its lock, so what people saw is what is charged. A function here throws a TabError to refuse (inside a transaction that rolls everything back).
 */
type Tx = TransactionSql<{ bigint: bigint }>;
const n = (v: bigint | number) => Number(v);
type Q = Sql | Tx;

export class TabError extends Error {
  constructor(public status: number, public code: string, public extra: Record<string, unknown> = {}) { super(code); }
}
const fail = (status: number, code: string, extra: Record<string, unknown> = {}): never => { throw new TabError(status, code, extra); };

export const newCode = () => randomBytes(18).toString("base64url");
export const TAB_IDLE_HOURS = 12;
const MODES: TabMode[] = ["own", "pitch", "equal", "host"];
export const isMode = (m: unknown): m is TabMode => MODES.includes(m as TabMode);

type TabRow = {
  id: string; account_id: string; table_id: string | null; host_wallet_id: string; status: string; split_mode: TabMode; cover_cap: bigint | null; version: number;
  invite_code: string; locked: boolean; served_by: string | null; tip_mode: "none" | "percent" | "amount"; tip_value: bigint; opened_at: Date; review_at: Date | null;
  closed_at: Date | null; unpaid_at: Date | null; last_activity_at: Date;
};
type MemberRow = {
  wallet_id: string; account_id: string; joined_at: Date; max_tip_bps: number; settled_at: Date | null; away_at: Date | null; removed_at: Date | null; removed_by: string | null;
  name: string; photo: string | null; hold: bigint; wallet_type: string;
};
type ItemRow = {
  id: string; wallet_id: string | null; account_id: string | null; added_by: string | null; product_id: string | null; name: string; unit_price: bigint; discount: bigint;
  taxable: boolean; quantity: number; note: string | null; status: string; created_at: Date;
};
type CoverRow = { id: string; covered_wallet_id: string | null; payer_wallet_id: string; cap: bigint | null; created_at: Date };

export type TabState = {
  tab: TabRow; members: MemberRow[]; items: ItemRow[]; covers: CoverRow[]; table: { id: string; name: string } | null;
  tax: { rate: number; included: boolean }; merchant: { id: string; name: string; photo: string | null }; tableServedBy: string | null;
};

const TAB_COLS = `id, account_id, table_id, host_wallet_id, status, split_mode, cover_cap, version, invite_code, locked, served_by, tip_mode, tip_value, opened_at, review_at, closed_at, unpaid_at, last_activity_at`;

export async function lockTab(q: Q, id: string): Promise<TabRow> {
  const [t] = await q<TabRow[]>`select ${q.unsafe(TAB_COLS)} from tabs where id = ${id} for no key update`;
  if (!t) return fail(404, "tab_not_found");
  return t;
}
export const touch = (q: Q, id: string) => q`update tabs set version = version + 1, last_activity_at = now() where id = ${id}`;

export async function loadState(q: Q, id: string): Promise<TabState> {
  const [tab] = await q<TabRow[]>`select ${q.unsafe(TAB_COLS)} from tabs where id = ${id}`;
  if (!tab) return fail(404, "tab_not_found");
  const [members, items, covers, [table], [tax], [merchant]] = await Promise.all([
    q<MemberRow[]>`
      select m.wallet_id, m.account_id, m.joined_at, m.max_tip_bps, m.settled_at, m.away_at, m.removed_at, m.removed_by,
             coalesce(nullif(w.display_name, ''), a.name) as name, coalesce(w.photo, a.photo) as photo, w.type as wallet_type,
             coalesce((select h.amount from fund_holds h where h.tab_id = m.tab_id and h.wallet_id = m.wallet_id and h.status = 'active'), 0)::bigint as hold
        from tab_members m join wallets w on w.id = m.wallet_id join accounts a on a.id = m.account_id
       where m.tab_id = ${id} order by m.joined_at, m.wallet_id`,
    q<ItemRow[]>`select id, wallet_id, account_id, added_by, product_id, name, unit_price, discount, taxable, quantity, note, status, created_at from tab_items where tab_id = ${id} order by created_at, id`,
    q<CoverRow[]>`select id, covered_wallet_id, payer_wallet_id, cap, created_at from tab_covers where tab_id = ${id} and declined_at is null and ended_at is null order by created_at, id`,
    tab.table_id ? q<{ id: string; name: string; served_by: string | null }[]>`select id, name, served_by from venue_tables where id = ${tab.table_id}` : Promise.resolve([] as { id: string; name: string; served_by: string | null }[]),
    q<{ rate: number; included: boolean }[]>`select coalesce(tax_rate, 0) as rate, coalesce(tax_included, false) as included from businesses where account_id = ${tab.account_id}`,
    q<{ id: string; name: string; photo: string | null }[]>`select id, name, photo from accounts where id = ${tab.account_id}`,
  ]);
  return {
    tab, members, items, covers, table: table ? { id: table.id, name: table.name } : null, tableServedBy: table?.served_by ?? null,
    tax: tax ?? { rate: 0, included: false }, merchant: merchant!,
  };
}

/** The allocation of the bill to paying wallets, with the tax from app_tax over every non-void line (one rounding for the table). */
export async function buildQuote(q: Q, st: TabState): Promise<Quote> {
  const live = st.items.filter((i) => i.status === "ordered");
  let taxed: { tax: number; tax_rate: number; tax_included: boolean }[] = live.map(() => ({ tax: 0, tax_rate: 0, tax_included: st.tax.included }));
  if (live.length > 0) {
    const lines = JSON.stringify(live.map((i) => ({ unit_price: n(i.unit_price), discount: n(i.discount), quantity: i.quantity, taxable: i.taxable })));
    const [r] = await q<{ t: { lines: { tax: number; tax_rate: number; tax_included: boolean }[] } }[]>`select public.app_tax(${st.tab.account_id}::uuid, ${lines}::text::jsonb) as t`;
    taxed = r!.t.lines;
  }
  const inp: QInput = {
    mode: st.tab.split_mode, cover_cap: st.tab.cover_cap === null ? null : n(st.tab.cover_cap), host_wallet_id: st.tab.host_wallet_id,
    tax_included: st.tax.included, tax_rate: st.tax.rate, tip: { mode: st.tab.tip_mode, value: n(st.tab.tip_value) },
    served_by: st.tab.served_by ?? st.tableServedBy, table_name: st.table?.name ?? null,
    items: live.map((i, k) => ({
      id: i.id, wallet_id: i.wallet_id, product_id: i.product_id, name: i.name, unit_price: n(i.unit_price), discount: n(i.discount), quantity: i.quantity,
      taxable: i.taxable, tax: taxed[k]!.tax, tax_rate: taxed[k]!.tax_rate, tax_included: taxed[k]!.tax_included,
    })),
    members: st.members.map((m) => ({ wallet_id: m.wallet_id, account_id: m.account_id, max_tip_bps: m.max_tip_bps, hold: n(m.hold), removed: m.removed_at !== null })),
    covers: st.covers.map((c) => ({ covered_wallet_id: c.covered_wallet_id, payer_wallet_id: c.payer_wallet_id, cap: c.cap === null ? null : n(c.cap) })),
  };
  return quoteTab(inp);
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// The view every member (and the merchant) sees.

export type Viewer = { kind: "member"; walletIds: string[] } | { kind: "staff" };

export async function tabView(q: Q, id: string, viewer: Viewer) {
  const st = await loadState(q, id);
  const quote = await buildQuote(q, st);
  const byId = new Map(st.members.map((m) => [m.wallet_id, m] as const));
  const face = (w: string | null) => { const m = w ? byId.get(w) : undefined; return m ? { wallet_id: m.wallet_id, name: m.name, photo: imageUrl(m.photo) } : null; };
  const live = st.members.filter((m) => m.removed_at === null);
  const hostMode = st.tab.split_mode === "host";
  const coveredBy = (w: string | null) => {
    if (hostMode) return w !== st.tab.host_wallet_id ? { ...face(st.tab.host_wallet_id), cap: st.tab.cover_cap === null ? null : n(st.tab.cover_cap), carried: true } : null;
    const c = st.covers.find((x) => x.covered_wallet_id === w);
    return c ? { ...face(c.payer_wallet_id), cap: c.cap === null ? null : n(c.cap), carried: false } : w === null ? { ...face(st.tab.host_wallet_id), cap: null, carried: false, default: true } : null;
  };
  const mine = viewer.kind === "member" ? viewer.walletIds.filter((w) => byId.has(w) && byId.get(w)!.removed_at === null) : [];
  const orderers = new Map<string, number>();
  for (const i of st.items) if (i.status === "ordered") orderers.set(i.wallet_id ?? "table", (orderers.get(i.wallet_id ?? "table") ?? 0) + (n(i.unit_price) - n(i.discount)) * i.quantity);
  return {
    id: st.tab.id, status: st.tab.status, mode: st.tab.split_mode, version: st.tab.version, locked: st.tab.locked, host_wallet_id: st.tab.host_wallet_id, cover_cap: st.tab.cover_cap === null ? null : n(st.tab.cover_cap),
    ...(viewer.kind === "staff" || mine.length > 0 ? { invite_code: st.tab.invite_code } : {}),
    table: st.table, merchant: { id: st.merchant.id, name: st.merchant.name, photo: imageUrl(st.merchant.photo) },
    tip: { mode: st.tab.tip_mode, value: n(st.tab.tip_value) }, served_by: st.tab.served_by ?? st.tableServedBy,
    opened_at: st.tab.opened_at, unpaid_at: st.tab.unpaid_at,
    members: live.map((m) => ({
      wallet_id: m.wallet_id, name: m.name, photo: imageUrl(m.photo), host: m.wallet_id === st.tab.host_wallet_id, position_closed: m.settled_at !== null, away: m.away_at !== null,
      subtotal: orderers.get(m.wallet_id) ?? 0, covered_by: coveredBy(m.wallet_id),
      covering: hostMode ? (m.wallet_id === st.tab.host_wallet_id ? live.filter((x) => x.wallet_id !== m.wallet_id).map((x) => x.wallet_id) : []) : st.covers.filter((c) => c.payer_wallet_id === m.wallet_id).map((c) => c.covered_wallet_id ?? "table"),
    })),
    table_bill: { subtotal: orderers.get("table") ?? 0, covered_by: coveredBy(null) },
    items: st.items.map((i) => ({
      id: i.id, wallet_id: i.wallet_id, name: i.name, quantity: i.quantity, unit_price: n(i.unit_price), discount: n(i.discount), taxable: i.taxable, note: i.note,
      status: i.status, by_staff: i.added_by !== null && i.added_by !== i.account_id, created_at: i.created_at,
    })),
    pays: quote.payers.map((p) => ({ wallet_id: p.wallet_id, name: byId.get(p.wallet_id)?.name ?? null, photo: imageUrl(byId.get(p.wallet_id)?.photo ?? null), amount: p.amount, total: p.total, tip: p.tip, tip_clipped: p.tip_clipped, for: p.for })),
    bill: { items: quote.items, tax: quote.tax, tip: quote.tip, total: quote.bill },
    short: quote.short.map((s) => ({ ...s, ...(s.wallet_id ? { name: byId.get(s.wallet_id)?.name ?? null } : {}) })), short_total: quote.short_total,
    ...(mine.length > 0 ? {
      me: mine.map((w) => {
        const m = byId.get(w)!;
        const p = quote.payers.find((x) => x.wallet_id === w);
        return { wallet_id: w, host: w === st.tab.host_wallet_id, max_tip_bps: m.max_tip_bps, position_closed: m.settled_at !== null, hold: n(m.hold), amount: p?.amount ?? 0, covered_by: coveredBy(w), pays_for: p?.for ?? [] };
      }),
    } : {}),
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// Who is acting.

export type Actor =
  | { kind: "member"; accountId: string; walletId: string | null; sessionKind: "owner" | "wallet" }
  | { kind: "staff"; accountId: string };       // the business owner or a manager acting for the merchant

/** The wallet a person acts with: the delegated session's own wallet, or one of the owner's own active wallets (the default if none is named). */
export async function actingWallet(q: Q, a: { accountId: string; walletId: string | null; sessionKind: "owner" | "wallet" }, named?: string | null): Promise<{ id: string; type: string }> {
  const want = a.sessionKind === "wallet" ? a.walletId : named ?? null;
  if (a.sessionKind === "wallet" && named && named !== a.walletId) return fail(403, "forbidden");
  const [w] = want
    ? await q<{ id: string; type: string; status: string }[]>`select id, type, status from wallets where id = ${want} and account_id = ${a.accountId}`
    : await q<{ id: string; type: string; status: string }[]>`select id, type, status from wallets where account_id = ${a.accountId} and type = 'default'`;
  if (!w) return fail(404, "wallet_not_found");
  if (w.status !== "active") return fail(422, "wallet_unavailable");
  if (w.type === "agent" || w.type === "escrow" || w.type === "system") return fail(403, "wallet_cannot_join_tabs");
  return w;
}

/** The member row for a person on a tab: the named wallet, or the only one of theirs on it. */
export async function memberOf(q: Q, tabId: string, a: { accountId: string; walletId: string | null; sessionKind: "owner" | "wallet" }, named?: string | null): Promise<MemberRow> {
  const want = a.sessionKind === "wallet" ? a.walletId : named ?? null;
  const rows = await q<MemberRow[]>`
    select m.wallet_id, m.account_id, m.joined_at, m.max_tip_bps, m.settled_at, m.away_at, m.removed_at, m.removed_by, '' as name, null as photo, w.type as wallet_type,
           coalesce((select h.amount from fund_holds h where h.tab_id = m.tab_id and h.wallet_id = m.wallet_id and h.status = 'active'), 0)::bigint as hold
      from tab_members m join wallets w on w.id = m.wallet_id
     where m.tab_id = ${tabId} and m.account_id = ${a.accountId} and m.removed_at is null ${want ? q`and m.wallet_id = ${want}` : q``}`;
  if (rows.length === 0) return fail(404, "not_a_member");
  if (rows.length > 1) return fail(400, "wallet_required");
  return rows[0]!;
}

const isHost = (t: TabRow, wallet: string) => t.host_wallet_id === wallet;

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// Opening and joining.

async function joinInside(tx: Tx, tab: TabRow, wallet: { id: string }, accountId: string, maxTipBps: number | undefined) {
  if (tab.status !== "open") return fail(409, "tab_not_open", { status: tab.status });
  const [m] = await tx<{ removed_at: Date | null; removed_by: string | null }[]>`select removed_at, removed_by from tab_members where tab_id = ${tab.id} and wallet_id = ${wallet.id}`;
  if (m && m.removed_at === null) return;                                  // already on it
  if (m && m.removed_by !== null) return fail(403, "removed_from_tab");    // staff removed this wallet
  if (tab.locked) return fail(403, "tab_locked");
  if (m) await tx`update tab_members set removed_at = null, away_at = null, settled_at = null, max_tip_bps = ${maxTipBps ?? 2500} where tab_id = ${tab.id} and wallet_id = ${wallet.id}`;
  else await tx`insert into tab_members (tab_id, wallet_id, account_id, max_tip_bps) values (${tab.id}, ${wallet.id}, ${accountId}, ${maxTipBps ?? 2500})`;
  await touch(tx, tab.id);
}

/** A table's code: the table and its open (or paying) tab with the faces on it, or none. Never joins. */
export async function tableByCode(q: Q, code: string) {
  const [t] = await q<{ id: string; account_id: string; name: string; served_by: string | null }[]>`
    select v.id, v.account_id, v.name, v.served_by from venue_tables v join accounts a on a.id = v.account_id and a.status = 'active' and a.type = 'B' where v.code = ${code} and v.active`;
  return t ?? null;
}

export async function openOrJoinByCode(sql: Sql, a: { accountId: string; walletId: string | null; sessionKind: "owner" | "wallet" }, code: string, o: { wallet_id?: string | null; max_tip_bps?: number }) {
  const table = await tableByCode(sql, code);
  if (!table) return fail(404, "table_not_found");
  const wallet = await actingWallet(sql, a, o.wallet_id);
  const [acct] = await sql<{ type: string }[]>`select type from accounts where id = ${a.accountId}`;
  if (acct?.type !== "C") return fail(403, "consumer_account_required");
  // an idle tab expires on the spot, so a stale one never blocks the table
  const idle = await sql<{ id: string }[]>`select id from tabs where table_id = ${table.id} and status in ('open', 'paying') and last_activity_at < now() - make_interval(hours => ${TAB_IDLE_HOURS})`;
  for (const t of idle) await cancelTab(sql, table.account_id, t.id, "expired").catch(() => undefined);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await sql.begin(async (tx) => {
        const [open] = await tx<TabRow[]>`select ${tx.unsafe(TAB_COLS)} from tabs where table_id = ${table.id} and status in ('open', 'paying') for no key update`;
        if (open) { await joinInside(tx, open, wallet, a.accountId, o.max_tip_bps); return { id: open.id, created: false }; }
        const [t] = await tx<{ id: string }[]>`
          insert into tabs (account_id, table_id, host_wallet_id, invite_code, served_by) values (${table.account_id}, ${table.id}, ${wallet.id}, ${newCode()}, ${table.served_by}) returning id`;
        await tx`insert into tab_members (tab_id, wallet_id, account_id, max_tip_bps) values (${t!.id}, ${wallet.id}, ${a.accountId}, ${o.max_tip_bps ?? 2500})`;
        return { id: t!.id, created: true };
      });
    } catch (e) { if (!isUniqueViolation(e) || attempt === 1) throw e; }
  }
  return fail(409, "tab_conflict");
}

export async function joinByInvite(sql: Sql, a: { accountId: string; walletId: string | null; sessionKind: "owner" | "wallet" }, invite: string, o: { wallet_id?: string | null; max_tip_bps?: number }) {
  const wallet = await actingWallet(sql, a, o.wallet_id);
  const [acct] = await sql<{ type: string }[]>`select type from accounts where id = ${a.accountId}`;
  if (acct?.type !== "C") return fail(403, "consumer_account_required");
  return sql.begin(async (tx) => {
    const [tab] = await tx<TabRow[]>`select ${tx.unsafe(TAB_COLS)} from tabs where invite_code = ${invite} for no key update`;
    if (!tab) return fail(404, "tab_not_found");
    await joinInside(tx, tab, wallet, a.accountId, o.max_tip_bps);
    return { id: tab.id, created: false };
  });
}

/** A tab with no table (counter, bar, takeaway). */
export async function openFree(sql: Sql, a: { accountId: string; walletId: string | null; sessionKind: "owner" | "wallet" }, merchantId: string, o: { wallet_id?: string | null; max_tip_bps?: number }) {
  const wallet = await actingWallet(sql, a, o.wallet_id);
  const [m] = await sql<{ id: string }[]>`select id from accounts where id = ${merchantId} and type = 'B' and status = 'active'`;
  if (!m) return fail(404, "merchant_not_found");
  return sql.begin(async (tx) => {
    const [t] = await tx<{ id: string }[]>`insert into tabs (account_id, host_wallet_id, invite_code) values (${merchantId}, ${wallet.id}, ${newCode()}) returning id`;
    await tx`insert into tab_members (tab_id, wallet_id, account_id, max_tip_bps) values (${t!.id}, ${wallet.id}, ${a.accountId}, ${o.max_tip_bps ?? 2500})`;
    return { id: t!.id, created: true };
  });
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// Items: no funds are checked and nothing is held.

export async function addItem(sql: Sql, actor: Actor & { sessionKind?: "owner" | "wallet" }, tabId: string, o: { product_id: string; quantity: number; note?: string | null; wallet_id?: string | null; table?: boolean }) {
  return sql.begin(async (tx) => {
    const tab = await lockTab(tx, tabId);
    if (tab.status !== "open") return fail(409, "tab_not_open", { status: tab.status });
    if (actor.kind === "staff" && tab.account_id !== actor.accountId) return fail(404, "tab_not_found");
    let target: string | null;
    if (actor.kind === "member") {
      const m = await memberOf(tx, tabId, { accountId: actor.accountId, walletId: actor.walletId, sessionKind: actor.sessionKind }, o.wallet_id);
      if (m.settled_at !== null) return fail(409, "position_closed");
      target = m.wallet_id;
    } else if (o.table) target = null;
    else {
      if (!o.wallet_id) return fail(400, "wallet_required");
      target = o.wallet_id;
    }
    let account: string | null = null;
    if (target) {
      const [m] = await tx<{ account_id: string; settled_at: Date | null; removed_at: Date | null }[]>`select account_id, settled_at, removed_at from tab_members where tab_id = ${tabId} and wallet_id = ${target}`;
      if (!m || m.removed_at !== null) return fail(404, "not_a_member");
      if (m.settled_at !== null) return fail(409, "position_closed");
      account = m.account_id;
    } else {
      // The Table's bill is paid by whoever covers it, else the host: whoever it is, their position must still be open.
      const [cv] = await tx<{ payer_wallet_id: string }[]>`select payer_wallet_id from tab_covers where tab_id = ${tabId} and covered_wallet_id is null and declined_at is null and ended_at is null`;
      const payer = cv?.payer_wallet_id ?? tab.host_wallet_id;
      const [pm] = await tx<{ settled_at: Date | null }[]>`select settled_at from tab_members where tab_id = ${tabId} and wallet_id = ${payer}`;
      if (pm?.settled_at) return fail(409, "position_closed", { payer_wallet_id: payer });
    }
    const [p] = await tx<{ id: string; name: string; price: bigint; discount: bigint; taxable: boolean; blocker: string | null }[]>`
      select p.id, p.name, p.price, p.discount, p.taxable, public.product_blocker(p, ${o.quantity}) as blocker
        from products p where p.id = ${o.product_id} and p.account_id = ${tab.account_id} and p.active`;
    if (!p) return fail(404, "product_not_found");
    if (p.blocker) return fail(422, "item_unavailable", { reason: p.blocker });
    const [it] = await tx<{ id: string }[]>`
      insert into tab_items (tab_id, wallet_id, account_id, added_by, product_id, name, unit_price, discount, taxable, quantity, note)
      values (${tabId}, ${target}, ${account}, ${actor.accountId}, ${p.id}, ${p.name}, ${p.price.toString()}, ${p.discount.toString()}, ${p.taxable}, ${o.quantity}, ${o.note?.trim() || null}) returning id`;
    await touch(tx, tabId);
    return { id: it!.id };
  });
}

export async function voidItem(sql: Sql, actor: Actor & { sessionKind?: "owner" | "wallet" }, tabId: string, itemId: string, named?: string | null) {
  return sql.begin(async (tx) => {
    const tab = await lockTab(tx, tabId);
    const [it] = await tx<{ id: string; wallet_id: string | null; status: string }[]>`select id, wallet_id, status from tab_items where id = ${itemId} and tab_id = ${tabId} for no key update`;
    if (!it) return fail(404, "item_not_found");
    if (it.status === "void") return { id: it.id, replayed: true };
    if (actor.kind === "staff") {
      if (tab.account_id !== actor.accountId) return fail(404, "tab_not_found");
      if (!["open", "paying", "unpaid"].includes(tab.status)) return fail(409, "tab_closed");
    } else {
      if (tab.status !== "open") return fail(409, "tab_not_open", { status: tab.status });
      const m = await memberOf(tx, tabId, { accountId: actor.accountId, walletId: actor.walletId, sessionKind: actor.sessionKind! }, named);
      const mayVoid = it.wallet_id === m.wallet_id || (it.wallet_id === null && isHost(tab, m.wallet_id));
      if (!mayVoid) return fail(403, "forbidden");
      if (m.settled_at !== null) return fail(409, "position_closed");
    }
    await tx`update tab_items set status = 'void', voided_at = now(), voided_by = ${actor.accountId} where id = ${itemId}`;
    await touch(tx, tabId);
    return { id: it.id, replayed: false };
  });
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// Settings: the mode, covers, the tip, the host and the lock.

const release = (q: Q, arg: Record<string, unknown>) => callMoney<{ released: number }>(q, "app_tab_release", arg);

export async function setMode(sql: Sql, actor: Actor & { sessionKind?: "owner" | "wallet" }, tabId: string, o: { mode: TabMode; cover_cap?: number | null; wallet_id?: string | null }) {
  return sql.begin(async (tx) => {
    const tab = await lockTab(tx, tabId);
    await requireHostOrStaff(tx, tab, actor, o.wallet_id);
    if (tab.status !== "open") return fail(409, "tab_not_open", { status: tab.status });
    if (o.mode === tab.split_mode && (o.cover_cap ?? null) === (tab.cover_cap === null ? null : n(tab.cover_cap))) return { mode: o.mode, changed: false };
    // changing the mode changes who pays what: every hold is released and every position reopens
    await release(tx, { tab_id: tabId, reason: "mode_changed" });
    if (o.mode === "pitch" || o.mode === "host") await tx`update tab_covers set ended_at = now() where tab_id = ${tabId} and declined_at is null and ended_at is null`;
    await tx`update tabs set split_mode = ${o.mode}, cover_cap = ${o.mode === "host" ? o.cover_cap ?? null : null} where id = ${tabId}`;
    await touch(tx, tabId);
    return { mode: o.mode, changed: true };
  });
}

async function requireHostOrStaff(q: Q, tab: TabRow, actor: Actor & { sessionKind?: "owner" | "wallet" }, named?: string | null) {
  if (actor.kind === "staff") { if (tab.account_id !== actor.accountId) fail(404, "tab_not_found"); return; }
  const m = await memberOf(q, tab.id, { accountId: actor.accountId, walletId: actor.walletId, sessionKind: actor.sessionKind! }, named);
  if (!isHost(tab, m.wallet_id)) fail(403, "host_only");
}

export async function addCovers(sql: Sql, a: { accountId: string; walletId: string | null; sessionKind: "owner" | "wallet" }, tabId: string, o: { wallet_ids?: string[]; table?: boolean; cap?: number | null; wallet_id?: string | null }) {
  return sql.begin(async (tx) => {
    const tab = await lockTab(tx, tabId);
    if (tab.status !== "open") return fail(409, "tab_not_open", { status: tab.status });
    if (tab.split_mode !== "own" && tab.split_mode !== "equal") return fail(422, "cover_not_available", { mode: tab.split_mode });
    const me = await memberOf(tx, tabId, a, o.wallet_id);
    const targets: (string | null)[] = [...(o.wallet_ids ?? []), ...(o.table ? [null] : [])];
    if (targets.length === 0) return fail(400, "invalid_request");
    if (tab.split_mode === "equal" && o.table) return fail(422, "cover_not_available", { mode: tab.split_mode });
    const active = await tx<{ covered_wallet_id: string | null; payer_wallet_id: string }[]>`select covered_wallet_id, payer_wallet_id from tab_covers where tab_id = ${tabId} and declined_at is null and ended_at is null`;
    if (active.some((c) => c.covered_wallet_id === me.wallet_id)) return fail(422, "cover_chain");   // someone who is covered cannot cover
    for (const t of targets) {
      if (t === me.wallet_id) return fail(422, "cannot_cover_yourself");
      if (t !== null) {
        const [m] = await tx<{ removed_at: Date | null }[]>`select removed_at from tab_members where tab_id = ${tabId} and wallet_id = ${t}`;
        if (!m || m.removed_at !== null) return fail(404, "not_a_member", { wallet_id: t });
        if (active.some((c) => c.payer_wallet_id === t)) return fail(422, "cover_chain");           // someone who covers cannot be covered
      }
      if (active.some((c) => c.covered_wallet_id === t)) return fail(409, "already_covered", { wallet_id: t });
    }
    for (const t of targets) {
      try { await tx`insert into tab_covers (tab_id, covered_wallet_id, payer_wallet_id, cap) values (${tabId}, ${t}, ${me.wallet_id}, ${o.cap ? o.cap.toString() : null})`; }
      catch (e) { if (isUniqueViolation(e)) return fail(409, "already_covered"); throw e; }
      // a cover changes who pays what: the positions it touches reopen
      if (t) await release(tx, { tab_id: tabId, wallet_id: t, reason: "reopened" });
    }
    await release(tx, { tab_id: tabId, wallet_id: me.wallet_id, reason: "reopened" });
    await touch(tx, tabId);
    return { covered: targets.length };
  });
}

async function endCover(sql: Sql, tabId: string, covered: string | null, how: "ended" | "declined", who: (tab: TabRow, c: { payer_wallet_id: string }, tx: Tx) => Promise<void>) {
  return sql.begin(async (tx) => {
    const tab = await lockTab(tx, tabId);
    if (!["open", "paying"].includes(tab.status)) return fail(409, "tab_not_open", { status: tab.status });
    const [c] = await tx<{ id: string; payer_wallet_id: string }[]>`
      select id, payer_wallet_id from tab_covers where tab_id = ${tabId} and covered_wallet_id is not distinct from ${covered} and declined_at is null and ended_at is null for no key update`;
    if (!c) return fail(404, "cover_not_found");
    await who(tab, c, tx);
    if (how === "declined") await tx`update tab_covers set declined_at = now() where id = ${c.id}`;
    else await tx`update tab_covers set ended_at = now() where id = ${c.id}`;
    if (covered) await release(tx, { tab_id: tabId, wallet_id: covered, reason: "reopened" });
    await release(tx, { tab_id: tabId, wallet_id: c.payer_wallet_id, reason: "reopened" });
    await touch(tx, tabId);
    return { ok: true };
  });
}
export const stopCover = (sql: Sql, a: { accountId: string; walletId: string | null; sessionKind: "owner" | "wallet" } | { staff: string }, tabId: string, covered: string | null, named?: string | null) =>
  endCover(sql, tabId, covered, "ended", async (tab, c, tx) => {
    if ("staff" in a) { if (tab.account_id !== a.staff) fail(404, "tab_not_found"); return; }
    const m = await memberOf(tx, tabId, a, named);
    if (m.wallet_id !== c.payer_wallet_id) fail(403, "forbidden");
  });
export const declineCover = (sql: Sql, a: { accountId: string; walletId: string | null; sessionKind: "owner" | "wallet" }, tabId: string, named?: string | null) =>
  sql.begin(async (tx) => (await memberOf(tx, tabId, a, named)).wallet_id).then((me) => endCover(sql, tabId, me, "declined", async () => {}));

export async function setTip(sql: Sql, actor: Actor & { sessionKind?: "owner" | "wallet" }, tabId: string, o: { mode: "none" | "percent" | "amount"; value?: number; wallet_id?: string | null }) {
  return sql.begin(async (tx) => {
    const tab = await lockTab(tx, tabId);
    if (!["open", "paying"].includes(tab.status)) return fail(409, "tab_not_open", { status: tab.status });
    if (actor.kind === "staff") { if (tab.account_id !== actor.accountId) return fail(404, "tab_not_found"); }
    else await memberOf(tx, tabId, { accountId: actor.accountId, walletId: actor.walletId, sessionKind: actor.sessionKind! }, o.wallet_id);
    const v = o.mode === "none" ? 0 : o.value ?? 0;
    if (o.mode === "percent" && (v < 0 || v > 10000)) return fail(400, "invalid_request");
    if (o.mode === "amount" && (v < 0 || v > 1_000_000_000)) return fail(400, "invalid_request");
    await tx`update tabs set tip_mode = ${o.mode}, tip_value = ${v.toString()} where id = ${tabId}`;
    await touch(tx, tabId);
    return { tip: { mode: o.mode, value: v } };
  });
}

export async function setLocked(sql: Sql, actor: Actor & { sessionKind?: "owner" | "wallet" }, tabId: string, locked: boolean, named?: string | null) {
  return sql.begin(async (tx) => {
    const tab = await lockTab(tx, tabId);
    if (actor.kind === "staff") { if (tab.account_id !== actor.accountId) return fail(404, "tab_not_found"); }
    else await memberOf(tx, tabId, { accountId: actor.accountId, walletId: actor.walletId, sessionKind: actor.sessionKind! }, named);
    await tx`update tabs set locked = ${locked} where id = ${tabId}`;
    await touch(tx, tabId);
    return { locked };
  });
}

export async function setHost(sql: Sql, actor: Actor & { sessionKind?: "owner" | "wallet" }, tabId: string, wallet: string, named?: string | null) {
  return sql.begin(async (tx) => {
    const tab = await lockTab(tx, tabId);
    if (!["open", "paying", "unpaid"].includes(tab.status)) return fail(409, "tab_closed");
    await requireHostOrStaff(tx, tab, actor, named);
    const [m] = await tx<{ removed_at: Date | null }[]>`select removed_at from tab_members where tab_id = ${tabId} and wallet_id = ${wallet}`;
    if (!m || m.removed_at !== null) return fail(404, "not_a_member");
    await tx`update tabs set host_wallet_id = ${wallet} where id = ${tabId}`;
    await touch(tx, tabId);
    return { host_wallet_id: wallet };
  });
}

export async function setServer(sql: Sql, merchant: string, tabId: string, staff: string | null) {
  return sql.begin(async (tx) => {
    const tab = await lockTab(tx, tabId);
    if (tab.account_id !== merchant) return fail(404, "tab_not_found");
    if (staff) {
      const [s] = await tx<{ id: string }[]>`select staff_account_id as id from staff where account_id = ${merchant} and staff_account_id = ${staff}`;
      if (!s && staff !== merchant) return fail(404, "staff_not_found");
    }
    await tx`update tabs set served_by = ${staff} where id = ${tabId}`;
    await touch(tx, tabId);
    return { served_by: staff };
  });
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// Positions: Close My Tab holds a member's funds so they can leave early and still be charged.

class Rollback extends Error { constructor(public result: unknown) { super("rollback"); } }

export async function closeMyTab(sql: Sql, a: { accountId: string; walletId: string | null; sessionKind: "owner" | "wallet" }, tabId: string, o: { amount?: number; wallet_id?: string | null }) {
  try {
    return await sql.begin(async (tx) => {
      const tab = await lockTab(tx, tabId);
      if (!["open", "paying"].includes(tab.status)) return fail(409, "tab_not_open", { status: tab.status });
      const me = await memberOf(tx, tabId, a, o.wallet_id);
      if (me.settled_at !== null) return fail(409, "already_closed");
      if (tab.split_mode === "host" && !isHost(tab, me.wallet_id)) return fail(422, "not_needed", { mode: "host" });
      let amount: number;
      if (tab.split_mode === "pitch" || tab.split_mode === "equal") {
        if (!o.amount || o.amount <= 0) return fail(400, "amount_required");
        amount = o.amount;
      } else {
        // an unlimited cover by this member becomes a limit equal to what it covers right now: later orders by that person are their own
        let st = await loadState(tx, tabId);
        let quote = await buildQuote(tx, st);
        const mine = st.covers.filter((c) => c.payer_wallet_id === me.wallet_id && c.cap === null);
        for (const c of mine) {
          const bill = quote.bills[c.covered_wallet_id ?? "table"] ?? 0;
          if (bill > 0) await tx`update tab_covers set cap = ${bill.toString()} where id = ${c.id}`;
        }
        if (mine.length > 0) { st = await loadState(tx, tabId); quote = await buildQuote(tx, st); }
        amount = ceilingFor(quote, me.wallet_id, me.max_tip_bps);
        if (amount <= 0) return fail(422, "nothing_to_hold");
      }
      const r = await callMoney<{ kind: string; error?: string; status?: number; missing?: number; hold_id?: string }>(tx, "app_tab_settle", { tab_id: tabId, wallet_id: me.wallet_id, amount });
      if (r.kind !== "ok") throw new Rollback(r);
      return { hold_id: r.hold_id!, amount };
    });
  } catch (e) {
    if (e instanceof Rollback) {
      const r = e.result as { error: string; status: number; missing?: number };
      return fail(r.status, r.error, r.missing !== undefined ? { missing: r.missing } : {});
    }
    throw e;
  }
}

export async function reopenPosition(sql: Sql, a: { accountId: string; walletId: string | null; sessionKind: "owner" | "wallet" }, tabId: string, named?: string | null) {
  return sql.begin(async (tx) => {
    const tab = await lockTab(tx, tabId);
    if (!["open", "paying", "unpaid"].includes(tab.status)) return fail(409, "tab_closed");
    const me = await memberOf(tx, tabId, a, named);
    await release(tx, { tab_id: tabId, wallet_id: me.wallet_id, reason: "reopened" });
    await tx`update tab_members set settled_at = null, away_at = null where tab_id = ${tabId} and wallet_id = ${me.wallet_id}`;
    await touch(tx, tabId);
    return { ok: true };
  });
}

export async function setTipLimit(sql: Sql, a: { accountId: string; walletId: string | null; sessionKind: "owner" | "wallet" }, tabId: string, bps: number, named?: string | null) {
  return sql.begin(async (tx) => {
    await lockTab(tx, tabId);
    const me = await memberOf(tx, tabId, a, named);
    if (me.settled_at !== null) return fail(409, "position_closed");
    await tx`update tab_members set max_tip_bps = ${bps} where tab_id = ${tabId} and wallet_id = ${me.wallet_id}`;
    await touch(tx, tabId);
    return { max_tip_bps: bps };
  });
}

export async function leave(sql: Sql, a: { accountId: string; walletId: string | null; sessionKind: "owner" | "wallet" }, tabId: string, named?: string | null) {
  return sql.begin(async (tx) => {
    const tab = await lockTab(tx, tabId);
    if (!["open", "paying"].includes(tab.status)) return fail(409, "tab_closed");
    const me = await memberOf(tx, tabId, a, named);
    if (isHost(tab, me.wallet_id)) return fail(409, "host_cannot_leave");
    const [c] = await tx<{ items: number; covers: number }[]>`
      select (select count(*) from tab_items where tab_id = ${tabId} and wallet_id = ${me.wallet_id} and status = 'ordered')::int as items,
             (select count(*) from tab_covers where tab_id = ${tabId} and (payer_wallet_id = ${me.wallet_id} or covered_wallet_id = ${me.wallet_id}) and declined_at is null and ended_at is null)::int as covers`;
    if (c!.items > 0 || c!.covers > 0) {
      if (me.settled_at === null) return fail(409, "close_position_first");
      await tx`update tab_members set away_at = now() where tab_id = ${tabId} and wallet_id = ${me.wallet_id}`;
    } else {
      await release(tx, { tab_id: tabId, wallet_id: me.wallet_id, reason: "left" });
      await tx`update tab_members set removed_at = now() where tab_id = ${tabId} and wallet_id = ${me.wallet_id}`;
    }
    await touch(tx, tabId);
    return { left: true, away: c!.items > 0 || c!.covers > 0 };
  });
}

export async function removeMember(sql: Sql, merchant: string, tabId: string, wallet: string) {
  return sql.begin(async (tx) => {
    const tab = await lockTab(tx, tabId);
    if (tab.account_id !== merchant) return fail(404, "tab_not_found");
    if (!["open", "paying"].includes(tab.status)) return fail(409, "tab_closed");
    if (isHost(tab, wallet)) return fail(409, "host_cannot_leave");
    const [c] = await tx<{ items: number }[]>`select count(*)::int as items from tab_items where tab_id = ${tabId} and wallet_id = ${wallet} and status = 'ordered'`;
    if (c!.items > 0) return fail(409, "member_has_items");
    await release(tx, { tab_id: tabId, wallet_id: wallet, reason: "removed" });
    await tx`update tab_covers set ended_at = now() where tab_id = ${tabId} and (payer_wallet_id = ${wallet} or covered_wallet_id = ${wallet}) and declined_at is null and ended_at is null`;
    const r = await tx`update tab_members set removed_at = now(), removed_by = ${merchant} where tab_id = ${tabId} and wallet_id = ${wallet} and removed_at is null returning wallet_id`;
    if (r.length === 0) return fail(404, "not_a_member");
    await touch(tx, tabId);
    return { removed: true };
  });
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// Ready, back to ordering, Pay, Clear Table, cancel, expiry.

export async function ready(sql: Sql, actor: Actor & { sessionKind?: "owner" | "wallet" }, tabId: string, named?: string | null) {
  return sql.begin(async (tx) => {
    const tab = await lockTab(tx, tabId);
    if (tab.status !== "open") return fail(409, "tab_not_open", { status: tab.status });
    if (actor.kind === "staff") { if (tab.account_id !== actor.accountId) return fail(404, "tab_not_found"); }
    else await memberOf(tx, tabId, { accountId: actor.accountId, walletId: actor.walletId, sessionKind: actor.sessionKind! }, named);
    const st = await loadState(tx, tabId);
    const quote = await buildQuote(tx, st);
    if (quote.items <= 0) return fail(422, "empty_tab");
    if (quote.tip_needs_server) return fail(422, "tip_needs_server");
    await tx`update tabs set status = 'paying', review_at = now() where id = ${tabId}`;
    await touch(tx, tabId);
    return { status: "paying" };
  });
}

export async function reopenTab(sql: Sql, actor: Actor & { sessionKind?: "owner" | "wallet" }, tabId: string, named?: string | null) {
  return sql.begin(async (tx) => {
    const tab = await lockTab(tx, tabId);
    if (tab.status !== "paying") return fail(409, "not_ready", { status: tab.status });
    if (actor.kind === "staff") { if (tab.account_id !== actor.accountId) return fail(404, "tab_not_found"); }
    else await memberOf(tx, tabId, { accountId: actor.accountId, walletId: actor.walletId, sessionKind: actor.sessionKind! }, named);
    await tx`update tabs set status = 'open', review_at = null where id = ${tabId}`;
    await touch(tx, tabId);
    return { status: "open" };
  });
}

export type PayResult = { payments: { wallet_id: string; transaction_id: string; checkout_id: string; amount: number }[]; replayed: boolean };

/** Pay: the host (or staff for a host who has gone). Refuses with a shortfall and writes nothing when anyone cannot pay; the table is freed when the tab closes. */
export async function payTab(sql: Sql, actor: Actor & { sessionKind?: "owner" | "wallet" }, tabId: string, version: number, o: { wallet_id?: string | null; clear?: boolean } = {}): Promise<PayResult> {
  const st0 = await loadState(sql, tabId);
  if (actor.kind === "staff") { if (st0.tab.account_id !== actor.accountId) return fail(404, "tab_not_found"); }
  else {
    const m = await memberOf(sql, tabId, { accountId: actor.accountId, walletId: actor.walletId, sessionKind: actor.sessionKind! }, o.wallet_id);
    if (!isHost(st0.tab, m.wallet_id)) return fail(403, "host_only");
  }
  if (st0.tab.status === "closed") return call(sql, st0, version, actor, await buildQuote(sql, st0), o.clear);
  if (!["paying", "unpaid"].includes(st0.tab.status)) return fail(409, "not_ready", { status: st0.tab.status });
  if (st0.tab.version !== version) return fail(409, "stale_version", { version: st0.tab.version });
  const quote = await buildQuote(sql, st0);
  return call(sql, st0, version, actor, quote, o.clear);
}

async function call(sql: Sql, st: TabState, version: number, actor: Actor, quote: Quote, clear?: boolean): Promise<PayResult> {
  if (st.tab.status === "closed") {
    const r = await callMoney<{ kind: string; payments: PayResult["payments"] }>(sql, "app_close_tab", { tab_id: st.tab.id, version: st.tab.version, payers: [{ x: 1 }] });
    return { payments: r.payments, replayed: true };
  }
  const byWallet = new Map(st.members.map((m) => [m.wallet_id, m] as const));
  const shortKnown = quote.short.length > 0;
  const tipNeedsServer = quote.tip_needs_server;
  const unpaid = async (short: unknown) => {
    if (clear) await sql`update tabs set status = 'unpaid', unpaid_at = coalesce(unpaid_at, now()), version = version + 1, last_activity_at = now() where id = ${st.tab.id} and status in ('open', 'paying')`;
    return fail(422, "shortfall", { short, cleared: !!clear });
  };
  if (tipNeedsServer) return fail(422, "tip_needs_server");
  if (quote.payers.length === 0) return fail(422, "nothing_to_pay");
  if (shortKnown) return unpaid(quote.short.map((s) => ({ ...s, name: s.wallet_id ? byWallet.get(s.wallet_id)?.name ?? null : null })));
  const r = await callMoney<{ kind: string; error?: string; status?: number; short?: { wallet_id: string; amount: number; code: string }[]; payments?: PayResult["payments"]; replayed?: boolean }>(sql, "app_close_tab", {
    tab_id: st.tab.id, version, actor: actor.accountId, closed_reason: actor.kind === "staff" ? "staff" : "host", reference: st.table?.name ?? null,
    served_by: st.tab.served_by ?? st.tableServedBy,
    payers: quote.payers.map((p) => ({ wallet_id: p.wallet_id, account_id: p.account_id, amount: p.amount, total: p.total, sales_tax: p.sales_tax, tip: p.tip, lines: p.lines, tips: p.tips, for: p.for })),
  });
  if (r.kind === "short") return unpaid(r.short!.map((s) => ({ wallet_id: s.wallet_id, amount: s.amount, name: byWallet.get(s.wallet_id)?.name ?? null })));
  if (r.kind === "error") return fail(r.status ?? 422, r.error!);
  return { payments: r.payments!, replayed: !!r.replayed };
}

/** Clear Table (merchant): the party has gone. Try to Pay with the standing holds; whatever the outcome the tab leaves the table. */
export async function clearTable(sql: Sql, merchant: string, tabId: string) {
  const st = await loadState(sql, tabId);
  if (st.tab.account_id !== merchant) return fail(404, "tab_not_found");
  if (!["open", "paying"].includes(st.tab.status)) return fail(409, "tab_closed", { status: st.tab.status });
  const quote = await buildQuote(sql, st);
  if (quote.items <= 0) { await cancelTab(sql, merchant, tabId); return { status: "canceled", payments: [] }; }
  if (st.tab.status === "open") {
    await sql.begin(async (tx) => { await lockTab(tx, tabId); await tx`update tabs set status = 'paying', review_at = now() where id = ${tabId} and status = 'open'`; await touch(tx, tabId); });
  }
  const fresh = await loadState(sql, tabId);
  const result = await payTab(sql, { kind: "staff", accountId: merchant }, tabId, fresh.tab.version, { clear: true });
  return { status: "closed", payments: result.payments };
}

export async function cancelTab(sql: Sql, merchant: string, tabId: string, reason: "canceled" | "expired" = "canceled") {
  return sql.begin(async (tx) => {
    const tab = await lockTab(tx, tabId);
    if (merchant && tab.account_id !== merchant) return fail(404, "tab_not_found");
    if (!["open", "paying", "unpaid"].includes(tab.status)) return fail(409, "tab_closed", { status: tab.status });
    await release(tx, { tab_id: tabId, reason });
    await tx`update tabs set status = ${reason}, closed_at = now(), closed_by = ${reason === "canceled" ? merchant : null}, closed_reason = ${reason}, version = version + 1, last_activity_at = now() where id = ${tabId}`;
    return { status: reason };
  });
}

/** Open or paying tabs idle for 12 hours, and unpaid tabs 12 hours after they went unpaid, expire: every hold is released and nothing is charged. */
export async function expireTabs(sql: Sql): Promise<number> {
  const rows = await sql<{ id: string; account_id: string }[]>`
    select id, account_id from tabs
     where (status in ('open', 'paying') and last_activity_at < now() - make_interval(hours => ${TAB_IDLE_HOURS}))
        or (status = 'unpaid' and unpaid_at < now() - make_interval(hours => ${TAB_IDLE_HOURS}))
     order by last_activity_at limit 200`;
  let done = 0;
  for (const r of rows) {
    try { await cancelTab(sql, r.account_id, r.id, "expired"); done++; } catch (e) { if (!(e instanceof TabError)) throw e; }
  }
  return done;
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// Holds that something unbacked: released at the moment it happens, so the tab shows a shortfall instead of a surprise at Pay.

export const releaseHoldsOfWallet = (q: Q, walletId: string) => release(q, { wallet_id: walletId, reason: "withdrawn_by_system" });
export const releaseHoldsOfAccount = (q: Q, accountId: string) => release(q, { account_id: accountId, reason: "withdrawn_by_system" });

/** After a fund return (or any drop in the balance): release the newest holds of the account until what is held is backed again. */
export async function fitHolds(sql: Sql, accountId: string): Promise<number> {
  let released = 0;
  for (let guard = 0; guard < 50; guard++) {
    const [r] = await sql<{ over: bigint; hold_id: string | null }[]>`
      select ((select balance from balances where account_id = ${accountId})
              - (select coalesce(sum(case when balance is not null then balance else held end), 0) from wallets where account_id = ${accountId})) as over,
             (select h.id from fund_holds h where h.account_id = ${accountId} and h.status = 'active' order by h.created_at desc, h.id desc limit 1) as hold_id`;
    const [e] = await sql<{ bad: boolean }[]>`select exists (select 1 from wallets where account_id = ${accountId} and balance is not null and held > balance) as bad`;
    if (!r?.hold_id || (r.over >= 0n && !e!.bad)) break;
    await release(sql, { hold_id: r.hold_id, reason: "withdrawn_by_system" });
    released++;
  }
  return released;
}

/** The merchant changed its tax rate: every closed position on its open tabs reopens (the amounts moved). */
export async function releaseHoldsOfMerchant(sql: Sql, merchantId: string) {
  const tabs = await sql<{ id: string }[]>`select id from tabs where account_id = ${merchantId} and status in ('open', 'paying', 'unpaid')`;
  for (const t of tabs) await release(sql, { tab_id: t.id, reason: "withdrawn_by_system" });
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// Lists.

export async function myTabs(sql: Sql, accountId: string, limit = 20) {
  const rows = await sql<{ id: string; status: string; mode: string; merchant_name: string; table_name: string | null; opened_at: Date; closed_at: Date | null; wallet_id: string }[]>`
    select t.id, t.status, t.split_mode as mode, a.name as merchant_name, v.name as table_name, t.opened_at, t.closed_at, m.wallet_id
      from tab_members m join tabs t on t.id = m.tab_id join accounts a on a.id = t.account_id left join venue_tables v on v.id = t.table_id
     where m.account_id = ${accountId} and m.removed_at is null order by t.opened_at desc, t.id desc limit ${limit}`;
  return rows;
}

export async function businessTabs(sql: Sql, merchant: string, status: string | null, limit = 50) {
  return sql<{ id: string; status: string; mode: string; table_name: string | null; opened_at: Date; closed_at: Date | null; unpaid_at: Date | null; members: number; items: bigint }[]>`
    select t.id, t.status, t.split_mode as mode, v.name as table_name, t.opened_at, t.closed_at, t.unpaid_at,
           (select count(*) from tab_members m where m.tab_id = t.id and m.removed_at is null)::int as members,
           (select coalesce(sum((i.unit_price - i.discount) * i.quantity), 0) from tab_items i where i.tab_id = t.id and i.status = 'ordered')::bigint as items
      from tabs t left join venue_tables v on v.id = t.table_id
     where t.account_id = ${merchant} and (${status}::text is null or t.status = ${status}) order by t.opened_at desc, t.id desc limit ${limit}`;
}
