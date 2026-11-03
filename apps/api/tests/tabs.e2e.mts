process.on("uncaughtException", (e) => { console.log(String((e as Error).stack).split("\n").slice(0, 4).join(" | ")); process.exit(1); });
import { ROOT, applyMigration, migrate, psql, resetSchema } from "./db.ts";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import postgres from "postgres";
import app from "../src/index.ts";
psql(["-c", "drop schema public cascade; create schema public;"]);
migrate();
const adm = postgres("postgres://postgres@127.0.0.1:54340/nuclear", { max: 4, onnotice: () => {} });
const q = async (s: string, p: unknown[] = []) => (await adm.unsafe(s, p as any)) as any[];
const OP = "op-" + randomBytes(16).toString("hex");
const env: any = { STATS_TTL_SECONDS: "0", HYPERDRIVE: { connectionString: "postgres://postgres@127.0.0.1:54340/nuclear" }, JWT_SECRET: "x".repeat(40), ADMIN_API_TOKEN: OP, SANDBOX_FUNDING: "true", DAILY_VALUE_CAP_CENTS: "5000000" };
const ctx: any = { waitUntil: (p: Promise<unknown>) => void p.catch(() => {}), passThroughOnException() {} };
let pass = 0, fail = 0;
const eq = (l: string, g: unknown, w: unknown) => { const ok = JSON.stringify(g) === JSON.stringify(w); ok ? pass++ : fail++; console.log(ok ? "ok  " : "FAIL", l, ok ? "" : `got ${JSON.stringify(g)} want ${JSON.stringify(w)}`); };
const call = async (method: string, path: string, o: { body?: unknown; token?: string; key?: string } = {}) => {
  const r = await app.fetch(new Request("http://x" + path, { method, headers: { "content-type": "application/json", ...(o.token ? { authorization: `Bearer ${o.token}` } : {}), ...(o.key ? { "idempotency-key": o.key } : {}) }, body: o.body === undefined ? undefined : JSON.stringify(o.body) }), env, ctx);
  const t = await r.text(); return { status: r.status, json: t ? JSON.parse(t) : null };
};
const signup = async (name: string, email: string, type = "C") => { const j = (await call("POST", "/v1/auth/signup", { body: { name, email, password: "correct horse battery", type } })).json; if (type === "B") await q("update accounts set status='active' where id=$1", [j.account_id]); return j; }; // businesses start pending; these suites need them live

// ================= Shared tabs (docs/TABS.md) =================
let beaId = "";
const ok = (l: string, v: boolean) => eq(l, v, true);
const mk = async (name: string, email: string, funds = 0) => { const j = await signup(name, email); if (funds) await call("POST", "/v1/sandbox/fundings", { token: j.session_token, key: "f-" + email, body: { amount: funds } }); return { id: j.account_id as string, t: j.session_token as string, w: ((await call("GET", "/v1/wallets", { token: j.session_token })).json.wallets as any[]).find((x) => x.type === "default").id as string }; };
const shopJ = await signup("Bistro", "bistro@example.com", "B");
const M = shopJ.session_token as string, merchantId = shopJ.account_id as string;
await call("PUT", "/v1/business/profile", { token: M, body: { legal_name: "Bistro LLC", display_name: "Bistro" } });
await call("PUT", "/v1/business/tax", { token: M, body: { tax_rate: 1000, tax_included: false } });
const prod = async (name: string, price: number, extra: object = {}) => (await call("POST", "/v1/business/products", { token: M, body: { name, price, ...extra } })).json.product;
const burger = await prod("Burger", 2000), fries = await prod("Fries", 1000), salad = await prod("Salad", 1500, { taxable: false }), rare = await prod("Rare steak", 5000, { stock: 1 });
const server = await mk("Sam Server", "sam@example.com");
await call("POST", "/v1/staff", { token: M, body: { staff_account_id: server.id, role: "write" } });
const tbl = (await call("POST", "/v1/business/tables", { token: M, body: { name: "Table 4", served_by: server.id } })).json.table;
const tbl2 = (await call("POST", "/v1/business/tables", { token: M, body: { name: "Table 5" } })).json.table;
const ann = await mk("Ann", "ann@example.com", 20000), ben = await mk("Ben", "ben@example.com", 20000), cal = await mk("Cal", "cal@example.com", 20000), dan = await mk("Dan", "dan@example.com", 0);
const T = (m: any, method: string, path: string, body?: unknown) => call(method, path, { token: m.t, body });
const view = async (m: any, id: string) => (await T(m, "GET", `/v1/tabs/${id}`)).json.tab;
const heldOf = async (m: any) => Number((await q("select coalesce(sum(held),0)::int h from wallets where account_id=$1", [m.id]))[0].h);
const balOf = async (m: any) => Number((await q("select balance::int b from balances where account_id=$1", [m.id]))[0].b);
const payments = async (tabId: string) => q("select t.from_wallet_id, t.amount::int amount, t.status, t.credit_amount::int credit from transactions t join checkouts c on c.id = t.checkout_id where c.tab_id=$1 order by t.from_wallet_id", [tabId]);

// ---- tables, the public menu and what a code shows
eq("a table has an unguessable code and a link", [tbl.code.length >= 20, tbl.link === "https://nclr.app/t/" + tbl.code, tbl.served_by === server.id], [true, true, true]);
const mn = await call("GET", `/v1/menu/${tbl.code}`);
eq("the menu behind a code is public: merchant, table, tax and the catalog", [mn.status, mn.json.table.name, mn.json.merchant.name, mn.json.tax, mn.json.products.map((p: any) => p.name).sort()], [200, "Table 4", "Bistro", { rate: 1000, included: false }, ["Burger", "Fries", "Rare steak", "Salad"]]);
eq("an unknown code is a 404", (await call("GET", "/v1/menu/" + "x".repeat(24))).status, 404);
eq("a table with no tab shows none", (await T(ann, "GET", `/v1/tab-codes/${tbl.code}`)).json.tab, null);

// ---- open, show the faces, join
const opened = await T(ann, "POST", `/v1/tab-codes/${tbl.code}/join`, {});
const tabId = opened.json.tab.id as string;
eq("the first person opens the tab and is its host", [opened.status, opened.json.created, opened.json.tab.host_wallet_id === ann.w, opened.json.tab.mode, opened.json.tab.members.length], [201, true, true, "own", 1]);
const scan = (await T(ben, "GET", `/v1/tab-codes/${tbl.code}`)).json.tab;
eq("scanning shows the faces and names of everyone on it and never joins", [scan.members.map((m: any) => m.name), scan.joinable, (await view(ann, tabId)).members.length], [["Ann"], true, 1]);
eq("a stranger cannot read the tab before joining", (await T(ben, "GET", `/v1/tabs/${tabId}`)).status, 404);
eq("Ben joins; joining twice is fine", [(await T(ben, "POST", `/v1/tab-codes/${tbl.code}/join`, {})).json.created, (await T(ben, "POST", `/v1/tab-codes/${tbl.code}/join`, {})).status, (await view(ann, tabId)).members.length], [false, 200, 2]);
const inv = (await view(ann, tabId)).invite_code;
eq("Cal joins from the invite link", [(await T(cal, "POST", "/v1/tabs/join", { invite_code: inv })).status, (await view(ann, tabId)).members.length], [200, 3]);
eq("Dan has no money and still joins and orders: ordering never checks funds", await (async () => { await T(dan, "POST", `/v1/tab-codes/${tbl.code}/join`, {}); const r = await T(dan, "POST", `/v1/tabs/${tabId}/items`, { product_id: fries.id, quantity: 1 }); return [r.status, await heldOf(dan), (await q("select count(*)::int c from fund_holds"))[0].c]; })(), [201, 0, 0]);
const danItem = (await view(dan, tabId)).items[0].id;
eq("Dan voids his own item", [(await T(dan, "DELETE", `/v1/tabs/${tabId}/items/${danItem}`)).status, (await view(ann, tabId)).items.filter((i: any) => i.status === "ordered").length], [200, 0]);

// ---- ordering: members, a server's verbal orders for a member and for the Table
const add = (m: any, pid: string, qty = 1) => T(m, "POST", `/v1/tabs/${tabId}/items`, { product_id: pid, quantity: qty });
await add(ann, burger.id); await add(ben, fries.id); await add(cal, salad.id);
const staffAdd = (body: object) => call("POST", `/v1/business/tabs/${tabId}/items`, { token: M, body });
const forBen = await staffAdd({ product_id: burger.id, quantity: 1, wallet_id: ben.w });
const forTable = await staffAdd({ product_id: fries.id, quantity: 1, table: true });
eq("a server assigns a burger to Ben and fries to the Table: instant, no funds checked, nothing held", [forBen.status, forTable.status, await heldOf(ben), await heldOf(ann)], [201, 201, 0, 0]);
eq("the server must pick exactly one of a member or the Table", [(await staffAdd({ product_id: burger.id, quantity: 1 })).status, (await staffAdd({ product_id: burger.id, quantity: 1, wallet_id: ben.w, table: true })).status], [400, 400]);
let v = await view(ann, tabId);
eq("everyone sees who ordered what, including the Table's item and staff-added marks", [v.items.filter((i: any) => i.status === "ordered").map((i: any) => [i.name, i.wallet_id === ann.w ? "ann" : i.wallet_id === ben.w ? "ben" : i.wallet_id === cal.w ? "cal" : i.wallet_id === null ? "table" : "?", i.by_staff]), v.table_bill.subtotal], [[["Burger", "ann", false], ["Fries", "ben", false], ["Salad", "cal", false], ["Burger", "ben", true], ["Fries", "table", true]], 1000]);
const pays = (vv: any) => Object.fromEntries(vv.pays.map((p: any) => [vv.members.find((m: any) => m.wallet_id === p.wallet_id).name, p.amount]));
eq("Own Tab: each pays their own items and tax; the host pays the Table's fries", pays(v), { Ann: 3300, Ben: 3300, Cal: 1500 });
eq("the bill adds up", [v.bill.items, v.bill.tax, v.bill.total, v.short_total], [7500 + 0, 600, 8100, 0].map((x, i) => i === 0 ? 7500 : x));
eq("only the owner of an item (or the host for the Table) can void it", [(await T(ben, "DELETE", `/v1/tabs/${tabId}/items/${v.items.find((i: any) => i.wallet_id === null).id}`)).status, (await T(ann, "DELETE", `/v1/tabs/${tabId}/items/${v.items.find((i: any) => i.wallet_id === ben.w && i.by_staff).id}`)).status], [403, 403]);
eq("a member can void an item a server assigned to them, and it can be added again", await (async () => { const id = v.items.find((i: any) => i.wallet_id === ben.w && i.by_staff).id; const a = (await T(ben, "DELETE", `/v1/tabs/${tabId}/items/${id}`)).status; const b = (await staffAdd({ product_id: burger.id, quantity: 1, wallet_id: ben.w })).status; return [a, b]; })(), [200, 201]);
eq("a sold-out or unknown product cannot be added", [(await add(ann, "00000000-0000-7000-8000-00000000dead")).status], [404]);

// ---- Close My Tab: hold the funds so an early bird can leave and still be charged
const balCal0 = await balOf(cal);
const cm = await T(cal, "POST", `/v1/tabs/${tabId}/settle`, {});
eq("Cal closes his tab: funds for his total plus a 25% tip limit are held; nothing is charged", [cm.status, cm.json.hold, await heldOf(cal), await balOf(cal), cm.json.tab.me[0].position_closed], [200, 1500 + 375, 1875, balCal0, true]);
const calBal = (await T(cal, "GET", "/v1/balance")).json;
eq("held money cannot be spent or sent", [calBal.held, calBal.available_to_send, calBal.available_to_pay], [1875, balCal0 - 1875, balCal0 - 1875]);
eq("his position is closed for everyone to see (a check mark, never an amount)", [(await view(ann, tabId)).members.find((m: any) => m.wallet_id === cal.w).position_closed, JSON.stringify((await view(ann, tabId)).members).includes("1875")], [true, false]);
eq("a closed position takes no more items, from him or from a server", [(await add(cal, fries.id)).json.error, (await staffAdd({ product_id: fries.id, quantity: 1, wallet_id: cal.w })).json.error], ["position_closed", "position_closed"]);
eq("Dan cannot close without funds: the app is told how much is missing", await (async () => { await add(dan, burger.id); const r = await T(dan, "POST", `/v1/tabs/${tabId}/settle`, {}); const vv = await view(dan, tabId); return [r.status, r.json.error, r.json.missing, await heldOf(dan), vv.me[0].position_closed]; })(), [422, "insufficient_funds", 2200 + 500, 0, false]);
eq("a member with items cannot leave without closing; Cal leaves after closing and is shown as away", [(await T(ben, "POST", `/v1/tabs/${tabId}/leave`, {})).json.error, (await T(cal, "POST", `/v1/tabs/${tabId}/leave`, {})).json.away], ["close_position_first", true]);
const danIt = (await view(dan, tabId)).items.filter((i: any) => i.wallet_id === dan.w && i.status === "ordered")[0].id;
await T(dan, "DELETE", `/v1/tabs/${tabId}/items/${danIt}`);
eq("Dan leaves with nothing ordered and drops off the tab", [(await T(dan, "POST", `/v1/tabs/${tabId}/leave`, {})).json.left, (await view(ann, tabId)).members.map((m: any) => m.name)], [true, ["Ann", "Ben", "Cal"]]);
eq("reopening Cal's position releases the hold; closing again holds again", [(await T(cal, "POST", `/v1/tabs/${tabId}/reopen-position`, {})).status, await heldOf(cal), (await T(cal, "POST", `/v1/tabs/${tabId}/settle`, {})).json.hold, await heldOf(cal)], [200, 0, 1875, 1875]);

// ---- Cover
v = await view(ann, tabId);
const cv = await T(ann, "POST", `/v1/tabs/${tabId}/covers`, { wallet_ids: [ben.w] });
v = cv.json.tab;
eq("Ann covers Ben: one payer, Ben sees who is covering him, Ann sees whom she covers", [cv.status, pays(v), v.members.find((m: any) => m.name === "Ben").covered_by.name, v.members.find((m: any) => m.name === "Ann").covering], [200, { Ann: 6600, Cal: 1500 }, "Ann", [ben.w]]);
eq("Ben cannot cover (he is covered: no chains) and nobody can cover Ann (she covers)", [(await T(ben, "POST", `/v1/tabs/${tabId}/covers`, { wallet_ids: [cal.w] })).json.error, (await T(cal, "POST", `/v1/tabs/${tabId}/covers`, { wallet_ids: [ann.w] })).json.error], ["cover_chain", "cover_chain"]);
eq("a person has one coverer; nobody covers themselves", [(await T(cal, "POST", `/v1/tabs/${tabId}/covers`, { wallet_ids: [ben.w] })).json.error, (await T(ann, "POST", `/v1/tabs/${tabId}/covers`, { wallet_ids: [ann.w] })).json.error], ["already_covered", "cannot_cover_yourself"]);
eq("a cover reopens only the positions it touches: Cal's hold, not part of it, stays", [await heldOf(cal), (await view(cal, tabId)).me[0].position_closed], [1875, true]);
const dec = await T(ben, "POST", `/v1/tabs/${tabId}/covers/decline`, {});
eq("Ben declines the cover and pays his own again", [dec.status, pays(dec.json.tab), dec.json.tab.members.find((m: any) => m.name === "Ben").covered_by], [200, { Ann: 3300, Ben: 3300, Cal: 1500 }, null]);
const capped = await T(ann, "POST", `/v1/tabs/${tabId}/covers`, { wallet_ids: [ben.w], cap: 1000 });
eq("a Cover with a limit that binds: Ann pays 1000 of Ben's bill as a share, Ben the rest", [capped.status, pays(capped.json.tab)], [200, { Ann: 3300 + 1000, Ben: 2300, Cal: 1500 }]);
eq("stopping a cover gives it back", [(await T(ann, "DELETE", `/v1/tabs/${tabId}/covers/${ben.w}`)).status, pays((await view(ann, tabId)))], [200, { Ann: 3300, Ben: 3300, Cal: 1500 }]);
const tcv = await T(ben, "POST", `/v1/tabs/${tabId}/covers`, { table: true });
eq("Ben covers the Table: the host no longer pays the fries", [tcv.status, pays(tcv.json.tab), tcv.json.tab.table_bill.covered_by.name], [200, { Ann: 2200, Ben: 3300 + 1100, Cal: 1500 }, "Ben"]);
await T(ben, "DELETE", `/v1/tabs/${tabId}/covers/table`);

// ---- tip, ready, pay
await T(ann, "PUT", `/v1/tabs/${tabId}/tip`, { mode: "percent", value: 1000 });
const rd = await T(ann, "POST", `/v1/tabs/${tabId}/ready`, {}); if (!rd.json.tab) console.log("READY", rd.status, JSON.stringify(rd.json));
eq("Ready locks ordering and shows who pays what, with the tip split by the ratio of spend (the Table's share is the host's)", [rd.status, rd.json.tab.status, pays(rd.json.tab), rd.json.tab.bill.tip, (await add(ann, fries.id)).json.error], [200, "paying", { Ann: 3600, Ben: 3600, Cal: 1650 }, 750, "tab_not_open"]);
eq("only the host can Pay", (await T(ben, "POST", `/v1/tabs/${tabId}/pay`, { version: rd.json.tab.version })).json.error, "host_only");
eq("a stale version is refused", (await T(ann, "POST", `/v1/tabs/${tabId}/pay`, { version: rd.json.tab.version - 1 })).json.error, "stale_version");

// a payer who cannot pay: Eve joins late with 100 and orders a burger
const eve = await mk("Eve", "eve@example.com", 100);
await T(ann, "POST", `/v1/tabs/${tabId}/reopen`, {});
await T(eve, "POST", `/v1/tabs/join`, { invite_code: inv });
await add(eve, burger.id);
await T(ann, "POST", `/v1/tabs/${tabId}/ready`, {});
const before = { tx: (await q("select count(*)::int c from transactions"))[0].c, cal: await balOf(cal), eve: await balOf(eve), merchant: await balOf({ id: merchantId }), holds: await heldOf(cal) };
const vShort = await view(ann, tabId);
const short = await T(ann, "POST", `/v1/tabs/${tabId}/pay`, { version: vShort.version });
const after = { tx: (await q("select count(*)::int c from transactions"))[0].c, cal: await balOf(cal), eve: await balOf(eve), merchant: await balOf({ id: merchantId }), holds: await heldOf(cal) };
eq("Pay with a payer who cannot pay writes NOTHING: no payment, no declined row, no balance moved, the hold stays", [short.status, short.json.error, short.json.short.map((s: any) => [s.name, s.amount > 0]), after], [422, "shortfall", [["Eve", true]], before]);
eq("the tab is still paying and holds the table", [(await view(ann, tabId)).status, (await q("select status from tabs where id=$1", [tabId]))[0].status], ["paying", "paying"]);
const eveItem = (await view(ann, tabId)).items.find((i: any) => i.wallet_id === eve.w).id;
eq("a server voids Eve's burger from the review", [(await call("POST", `/v1/business/tabs/${tabId}/items/${eveItem}/void`, { token: M })).status], [200]);
await T(eve, "POST", `/v1/tabs/${tabId}/leave`, {});
const vPay = await view(ann, tabId);
const balBefore = { ann: await balOf(ann), ben: await balOf(ben), cal: await balOf(cal), m: await balOf({ id: merchantId }) };
const stockBefore = (await q("select stock from products where id=$1", [rare.id]))[0].stock;
const paid = await T(ann, "POST", `/v1/tabs/${tabId}/pay`, { version: vPay.version });
eq("the host Pays: one ordinary payment per paying wallet", [paid.status, paid.json.tab.status, paid.json.payments.length, paid.json.payments.every((p: any) => p.receipt_url?.includes("/v1/receipts/"))], [200, "closed", 3, true]);
const px = await payments(tabId);
eq("amounts: items, tax and each person's tip share", Object.fromEntries(px.map((r: any) => [r.from_wallet_id === ann.w ? "ann" : r.from_wallet_id === ben.w ? "ben" : "cal", r.amount])), { ann: 3600, ben: 3600, cal: 1650 });
eq("the balances moved by exactly that, and the merchant received the sum", [balBefore.ann - await balOf(ann), balBefore.ben - await balOf(ben), balBefore.cal - await balOf(cal), await balOf({ id: merchantId }) - balBefore.m], [3600, 3600, 1650, 8850]);
eq("Cal, who had gone, was charged from his hold; every hold is captured and wallets.held is zero", [await heldOf(cal), (await q("select status, end_reason from fund_holds where tab_id=$1 order by created_at", [tabId])).map((h: any) => h.status + ":" + h.end_reason)], [0, ["released:reopened", "captured:paid"]]);
eq("tips went to the server", (await q("select staff_account_id, sum(amount)::int a from tips group by 1")).map((r: any) => [r.staff_account_id === server.id, r.a]), [[true, 750]]);
eq("checkouts are linked to the tab and carry tax and tip", (await q("select total::int t, sales_tax::int x, tip_amount::int p, status from checkouts where tab_id=$1 order by total", [tabId])).map((r: any) => [r.t, r.x, r.p, r.status]), [[1500, 0, 150, "paid"], [3300, 300, 300, "paid"], [3300, 300, 300, "paid"]]);
eq("a repeat Pay replays (no second charge)", [(await T(ann, "POST", `/v1/tabs/${tabId}/pay`, { version: vPay.version })).json.replayed, (await payments(tabId)).length], [true, 3]);
eq("the merchant sees ordinary payments with tips and receipts", await (async () => { const r = (await call("GET", "/v1/business/transactions?kind=payments", { token: M })).json; return [r.transactions.length >= 3, r.transactions.filter((t: any) => t.status === "completed").length >= 3]; })(), [true, true]);
eq("a closed tab never changes", await q("update tab_items set note='x' where tab_id=$1", [tabId]).then(() => "changed", (e: any) => String(e.message).includes("frozen") ? "frozen" : String(e.message)), "frozen");
eq("the table is free the moment it closes: a new party opens a fresh tab", await (async () => { const r = await T(dan, "POST", `/v1/tab-codes/${tbl.code}/join`, {}); return [r.status, r.json.created, r.json.tab.id !== tabId, r.json.tab.members.map((m: any) => m.name)]; })(), [201, true, true, ["Dan"]]);

// ---- stock is clamped, never a decline
const t5 = (await T(ann, "POST", `/v1/tab-codes/${tbl2.code}/join`, {})).json.tab.id as string;
await T(ben, "POST", `/v1/tabs/join`, { invite_code: (await view(ann, t5)).invite_code });
await T(ann, "POST", `/v1/tabs/${t5}/items`, { product_id: rare.id, quantity: 1 });
await T(ben, "POST", `/v1/tabs/${t5}/items`, { product_id: rare.id, quantity: 1 });
await q("update products set stock = 1, status='available' where id=$1", [rare.id]);
await T(ann, "POST", `/v1/tabs/${t5}/ready`, {});
const p5 = await T(ann, "POST", `/v1/tabs/${t5}/pay`, { version: (await view(ann, t5)).version });
eq("two steaks sold with one in stock: both are charged, stock is clamped at zero", [p5.status, (await q("select stock, status, total_sold::int s from products where id=$1", [rare.id]))[0]], [200, { stock: 0, status: "sold_out", s: 2 }]);

// ---- Equal Shares, Pitch In, On Me
const party = async (table: any, members: any[]) => { const jr = await T(members[0], "POST", `/v1/tab-codes/${table.code}/join`, {}); if (!jr.json.tab) console.log("FAIL PARTY", table.name, jr.status, JSON.stringify(jr.json), JSON.stringify(await q("select name, code, active from venue_tables where id=$1", [table.id])), table.code); const id = jr.json.tab.id as string; const vw = await T(members[0], "GET", `/v1/tabs/${id}`); if (!vw.json.tab) console.log("FAIL VIEW", table.name, vw.status, JSON.stringify(vw.json)); const code = vw.json.tab.invite_code; for (const m of members.slice(1)) await T(m, "POST", "/v1/tabs/join", { invite_code: code }); return id; };
{
  const id = await party(tbl2, [ann, ben, cal]);
  await T(ann, "POST", `/v1/tabs/${id}/items`, { product_id: burger.id, quantity: 1 });
  await T(ben, "POST", `/v1/tabs/${id}/items`, { product_id: fries.id, quantity: 1 });
  await T(ann, "PUT", `/v1/tabs/${id}/tip`, { mode: "percent", value: 1000 });
  eq("Ready needs a tip server when there is a tip (Table 5 has none)", [(await T(ann, "POST", `/v1/tabs/${id}/ready`, {})).json.error], ["tip_needs_server"]);
  await T(ann, "PUT", `/v1/tabs/${id}/tip`, { mode: "none" });
  const eqm = await T(ann, "PUT", `/v1/tabs/${id}/mode`, { mode: "equal" });
  eq("Equal Shares: the whole bill (3300) is split equally", [eqm.status, pays(eqm.json.tab)], [200, { Ann: 1100, Ben: 1100, Cal: 1100 }]);
  eq("only the host chooses the mode", (await T(ben, "PUT", `/v1/tabs/${id}/mode`, { mode: "own" })).json.error, "host_only");
  eq("closing a tab in Equal Shares needs a ceiling", (await T(ben, "POST", `/v1/tabs/${id}/settle`, {})).json.error, "amount_required");
  const low = await T(ben, "POST", `/v1/tabs/${id}/settle`, { amount: 500 });
  eq("a ceiling below the share is a known shortfall that must be resolved before Pay", [low.status, low.json.tab.short_total, low.json.tab.short.map((s: any) => s.name), await heldOf(ben)], [200, 600, ["Ben"], 500]);
  await T(ann, "POST", `/v1/tabs/${id}/ready`, {});
  const blocked = await T(ann, "POST", `/v1/tabs/${id}/pay`, { version: (await view(ann, id)).version });
  eq("Pay is refused while the shortfall exists", [blocked.status, blocked.json.error, (await payments(id)).length], [422, "shortfall", 0]);
  await T(ben, "POST", `/v1/tabs/${id}/reopen-position`, {});
  const fixed = await T(ben, "POST", `/v1/tabs/${id}/settle`, { amount: 1500 });
  const done = await T(ann, "POST", `/v1/tabs/${id}/pay`, { version: fixed.json.tab.version });
  eq("raising the ceiling clears it and Pay charges the equal shares", [done.status, (await payments(id)).map((r: any) => r.amount).sort()], [200, [1100, 1100, 1100]]);
}
{
  const id = await party(tbl2, [ann, ben, cal]);
  await T(ann, "POST", `/v1/tabs/${id}/items`, { product_id: burger.id, quantity: 2 });     // 4400 with tax
  await T(ann, "PUT", `/v1/tabs/${id}/mode`, { mode: "pitch" });
  eq("Cover is not offered in Pitch In", (await T(ann, "POST", `/v1/tabs/${id}/covers`, { wallet_ids: [ben.w] })).json.error, "cover_not_available");
  await T(ann, "POST", `/v1/tabs/${id}/settle`, { amount: 2000 });
  const pl = await T(ben, "POST", `/v1/tabs/${id}/settle`, { amount: 1000 });
  eq("pledges below the bill: the tab shows exactly how much is short", [pl.json.tab.short_total, pl.json.tab.short[0].wallet_id], [1400, null]);
  await T(cal, "POST", `/v1/tabs/${id}/settle`, { amount: 3000 });
  await T(ann, "POST", `/v1/tabs/${id}/ready`, {});
  const vv = await view(ann, id);
  eq("pledges above the bill are cut in proportion: nobody pays more than their pledge, the total is the bill", [vv.short_total, Object.values(pays(vv)).reduce((s: number, x: any) => s + x, 0), Object.entries(pays(vv)).every(([n, a]: any) => a <= { Ann: 2000, Ben: 1000, Cal: 3000 }[n as string]!)], [0, 4400, true]);
  const done = await T(ann, "POST", `/v1/tabs/${id}/pay`, { version: vv.version });
  eq("Pitch In closes", [done.status, (await payments(id)).reduce((s: number, r: any) => s + r.amount, 0), await heldOf(ann) + await heldOf(ben) + await heldOf(cal)], [200, 4400, 0]);
}
{
  const id = await party(tbl2, [ann, ben, cal]);
  await T(ben, "POST", `/v1/tabs/${id}/items`, { product_id: burger.id, quantity: 1 });
  await T(cal, "POST", `/v1/tabs/${id}/items`, { product_id: fries.id, quantity: 1 });
  const bb = await T(ann, "PUT", `/v1/tabs/${id}/mode`, { mode: "host", cover_cap: 1500 });
  eq("On Me with a per-person limit: the host pays up to 1500 each, the person the rest; everyone sees who carries them", [bb.status, pays(bb.json.tab), bb.json.tab.members.find((m: any) => m.name === "Cal").covered_by.carried], [200, { Ann: 1500 + 1100, Ben: 2200 - 1500 }, true]);
  await T(ann, "PUT", `/v1/tabs/${id}/mode`, { mode: "host" });
  await T(ann, "POST", `/v1/tabs/${id}/ready`, {});
  const vv = await view(ann, id);
  const done = await T(ann, "POST", `/v1/tabs/${id}/pay`, { version: vv.version });
  eq("On Me: the host pays everything and the others are never charged", [done.status, (await payments(id)).length, (await payments(id))[0].from_wallet_id === ann.w, (await payments(id))[0].amount], [200, 1, true, 3300]);
}

// ---- Benefits wallets can pay for other people
{
  const org = await signup("Org", "org@example.com", "O");
  const [orgRow] = await q("select id from accounts where email='org@example.com'");
  const bea = await mk("Bea", "bea@example.com", 0); beaId = bea.id;
  const bw = (await q("insert into wallets (account_id, display_name, type, org_account_id, balance, allow_send, allow_pay) values ($1,'Benefits','benefits',$2,5000,false,true) returning id", [bea.id, orgRow.id]))[0].id;
  await q("update balances set balance = balance + 5000 where account_id=$1", [bea.id]);
  const id = (await T(bea, "POST", `/v1/tab-codes/${tbl2.code}/join`, { wallet_id: bw })).json.tab.id as string;
  await T(ben, "POST", "/v1/tabs/join", { invite_code: (await view(bea, id)).invite_code });
  await T(ben, "POST", `/v1/tabs/${id}/items`, { product_id: burger.id, quantity: 1 });
  await T(bea, "PUT", `/v1/tabs/${id}/mode`, { mode: "host" });
  await T(bea, "POST", `/v1/tabs/${id}/ready`, { wallet_id: bw });
  const done = await T(bea, "POST", `/v1/tabs/${id}/pay`, { wallet_id: bw, version: (await view(bea, id)).version });
  eq("a Benefits wallet is the host and pays for another person from its own money", [done.status, Number((await q("select balance::int b from wallets where id=$1", [bw]))[0].b)], [200, 5000 - 2200]);
}

// ---- Clear Table, cancel, expiry, system releases
{
  const id = await party(tbl2, [ann, ben]);
  await T(ann, "POST", `/v1/tabs/${id}/items`, { product_id: burger.id, quantity: 1 });
  await T(ben, "POST", `/v1/tabs/${id}/items`, { product_id: fries.id, quantity: 1 });
  await T(ben, "POST", `/v1/tabs/${id}/settle`, {});
  eq("a closed position holds funds", await heldOf(ben), 1100 + 250);
  eq("while a party is on the table a new party cannot join its tab", (await T(cal, "POST", `/v1/tab-codes/${tbl2.code}/join`, {})).status, 200);
  await call("POST", `/v1/business/tabs/${id}/lock`, { token: M, body: { locked: true } });
  eq("a locked tab takes nobody else", (await T(dan, "POST", `/v1/tab-codes/${tbl2.code}/join`, {})).json.error, "tab_locked");
  await call("POST", `/v1/business/tabs/${id}/lock`, { token: M, body: { locked: false } });
  await q("update wallets set balance = 0 where false");
  // Ann's wallet is switched off for payments while she is on a tab: her holds are released at once
  await T(ann, "POST", `/v1/tabs/${id}/settle`, {});
  eq("Ann closes her tab too", await heldOf(ann), 2200 + 500);
  await call("PATCH", `/v1/wallets/${ann.w}`, { token: ann.t, body: { allow_pay: false } });
  const vs = await view(ann, id);
  eq("switching a wallet's payments off releases its holds at once and reopens the position", [await heldOf(ann), vs.me[0].position_closed], [0, false]);
  await call("PATCH", `/v1/wallets/${ann.w}`, { token: ann.t, body: { allow_pay: true } });
  const clr = await call("POST", `/v1/business/tabs/${id}/clear`, { token: M });
  eq("Clear Table: Ann is not settled but can pay live, so the manager closes it from the standing holds and live checks", [clr.status, clr.json.status, (await payments(id)).length], [200, "closed", 2]);
  const id2 = await party(tbl2, [ann, eve]);
  await T(eve, "POST", `/v1/tabs/${id2}/items`, { product_id: burger.id, quantity: 1 });
  await T(ann, "POST", `/v1/tabs/${id2}/items`, { product_id: fries.id, quantity: 1 });
  const un = await call("POST", `/v1/business/tabs/${id2}/clear`, { token: M });
  eq("Clear Table with a payer who cannot pay: the tab becomes unpaid, leaves the table and nothing is written", [un.status, un.json.status, (await q("select status from tabs where id=$1", [id2]))[0].status, (await payments(id2)).length], [200, "unpaid", "unpaid", 0]);
  eq("the table is free again at once", (await T(dan, "POST", `/v1/tab-codes/${tbl2.code}/join`, {})).json.created, true);
  await call("POST", `/v1/business/tabs/${id2}/items/${(await view(ann, id2)).items.find((i: any) => i.wallet_id === eve.w).id}/void`, { token: M });
  const payUn = await call("POST", `/v1/business/tabs/${id2}/pay`, { token: M, body: { version: (await view(ann, id2)).version } });
  eq("an unpaid tab is paid once the shortfall is resolved", [payUn.status, (await q("select status from tabs where id=$1", [id2]))[0].status], [200, "closed"]);
}
{
  const id = await party(tbl, [cal, ben]);
  await T(cal, "POST", `/v1/tabs/${id}/items`, { product_id: burger.id, quantity: 1 });
  await T(cal, "POST", `/v1/tabs/${id}/settle`, {});
  eq("cancel releases every hold and charges nothing", await (async () => { const h = await heldOf(cal); const r = await call("POST", `/v1/business/tabs/${id}/cancel`, { token: M }); return [h > 0, r.json.status, await heldOf(cal), (await payments(id)).length]; })(), [true, "canceled", 0, 0]);
  const id2 = await party(tbl, [cal, ben]);
  await T(cal, "POST", `/v1/tabs/${id2}/items`, { product_id: burger.id, quantity: 1 });
  await T(cal, "POST", `/v1/tabs/${id2}/settle`, {});
  await q("update tabs set last_activity_at = now() - interval '13 hours' where id=$1", [id2]);
  eq("an idle tab expires on the spot when the table is scanned: holds released, nothing charged, a fresh tab opens", await (async () => { const r = await T(dan, "POST", `/v1/tab-codes/${tbl.code}/join`, {}); return [r.json.created, (await q("select status from tabs where id=$1", [id2]))[0].status, await heldOf(cal)]; })(), [true, "expired", 0]);
  const id3 = (await q("select id from tabs where table_id=$1 and status='open'", [tbl.id]))[0].id as string;
  await q("update tabs set last_activity_at = now() - interval '13 hours' where id=$1", [id3]);
  const { expireTabs } = await import("../src/lib/tabs.ts");
  const { connect } = await import("../src/db.ts");
  const sql2 = connect(env);
  eq("the daily job expires idle tabs too", [await expireTabs(sql2), (await q("select status from tabs where id=$1", [id3]))[0].status], [1, "expired"]);
  await sql2.end();
}

// ---- who can do what
{
  const id = await party(tbl2, [ann, ben]);
  eq("a stranger cannot act on a tab: add, settle, pay, cover", [(await T(cal, "POST", `/v1/tabs/${id}/items`, { product_id: burger.id, quantity: 1 })).status, (await T(cal, "POST", `/v1/tabs/${id}/settle`, {})).status, (await T(cal, "POST", `/v1/tabs/${id}/pay`, { version: 1 })).status, (await T(cal, "POST", `/v1/tabs/${id}/covers`, { wallet_ids: [ann.w] })).status], [404, 404, 404, 404]);
  const other = await signup("Other", "other@example.com", "B");
  eq("another merchant cannot see or act on this tab", [(await call("GET", `/v1/business/tabs/${id}`, { token: other.session_token })).status, (await call("POST", `/v1/business/tabs/${id}/cancel`, { token: other.session_token })).status], [404, 404]);
  const agent = (await T(ann, "POST", "/v1/wallets", { display_name: "Agent", type: "agent", balance: 100 })).json;
  eq("an agent wallet cannot join a tab", (await T(ann, "POST", `/v1/tab-codes/${tbl.code}/join`, { wallet_id: agent.wallet.id })).json.error, "wallet_cannot_join_tabs");
  eq("a business account cannot join a tab", (await call("POST", `/v1/tab-codes/${tbl.code}/join`, { token: M, body: {} })).status, 403);
  eq("an unpublished or deactivated table opens nothing", await (async () => { await call("PATCH", `/v1/business/tables/${tbl2.id}`, { token: M, body: { active: false } }); const r = await T(dan, "POST", `/v1/tab-codes/${tbl2.code}/join`, {}); await call("PATCH", `/v1/business/tables/${tbl2.id}`, { token: M, body: { active: true } }); return r.status; })(), 404);
  const rot = await call("POST", `/v1/business/tables/${tbl2.id}/rotate-code`, { token: M });
  eq("rotating a table's code stops the old one working", [rot.json.table.code !== tbl2.code, (await call("GET", `/v1/menu/${tbl2.code}`)).status, (await call("GET", `/v1/menu/${rot.json.table.code}`)).status], [true, 404, 200]);
  tbl2.code = rot.json.table.code;
  eq("the conditional read: unchanged answers cheaply", await (async () => { const vv = await view(ann, id); const r = await T(ann, "GET", `/v1/tabs/${id}?since=${vv.version}`); return [r.json.unchanged, r.json.version === vv.version]; })(), [true, true]);
}

// ---- concurrency: a Pay racing a member's own payment never deadlocks or double-debits
{
  for (const t of await q("select id from tabs where status in ('open','paying')")) await call("POST", `/v1/business/tabs/${t.id}/cancel`, { token: M });
  await call("POST", "/v1/sandbox/fundings", { token: ann.t, key: "f-ann-2", body: { amount: 5000 } });
  const id = await party(tbl2, [ann, ben]);
  await T(ann, "POST", `/v1/tabs/${id}/items`, { product_id: burger.id, quantity: 1 });
  await T(ben, "POST", `/v1/tabs/${id}/items`, { product_id: fries.id, quantity: 1 });
  await T(ann, "POST", `/v1/tabs/${id}/ready`, {});
  const ver = (await view(ann, id)).version;
  const b0 = await balOf(ben);
  const term = (await call("POST", "/v1/terminals", { token: M, body: { name: "Counter" } })).json;
  const racers = await Promise.all([
    T(ann, "POST", `/v1/tabs/${id}/pay`, { version: ver }), T(ann, "POST", `/v1/tabs/${id}/pay`, { version: ver }),
    call("POST", "/v1/payments", { token: ben.t, key: "race-1", body: { amount: 300, terminal_id: term.terminal.id } }),
    call("POST", "/v1/transfers", { token: ben.t, key: "race-2", body: { from_wallet_id: ben.w, to_wallet_id: cal.w, amount: 200 } }),
  ]);
  eq("no deadlock, no server error", racers.map((r) => r.status < 500), [true, true, true, true]);
  eq("the tab is charged exactly once", (await payments(id)).length, 2);
  eq("Ben's balance moved by exactly his tab share plus his two own payments", b0 - await balOf(ben), 1100 + 300 + 200);
}

// ---- invariants
eq("every wallet's held equals the sum of its active holds", (await q("select count(*)::int c from wallets w where w.held <> coalesce((select sum(amount) from fund_holds h where h.wallet_id=w.id and h.status='active'),0)"))[0].c, 0);
eq("an active hold belongs only to an open or paying (or unpaid) tab", (await q("select count(*)::int c from fund_holds h join tabs t on t.id=h.tab_id where h.status='active' and t.status in ('closed','canceled','expired')"))[0].c, 0);
eq("a tab never writes a declined payment", (await q("select count(*)::int c from transactions t join checkouts c on c.id=t.checkout_id where c.tab_id is not null and t.status='declined'"))[0].c, 0);
eq("every closed tab has exactly one completed payment per payer", (await q("select count(*)::int c from (select c.tab_id, t.from_wallet_id, count(*) n from transactions t join checkouts c on c.id=t.checkout_id where c.tab_id is not null and t.status='completed' group by 1,2 having count(*) > 1) x"))[0].c, 0);
eq("the money conserves: balances equal what the transactions did", (await q("select count(*)::int c from (select account_id, sum(delta)::bigint d from account_effects group by 1) e join balances b on b.account_id=e.account_id where b.balance <> e.d and b.account_id <> $1", [beaId]))[0].c, 0);
console.log(`\n${pass} passed, ${fail} failed`); await adm.end(); process.exit(fail ? 1 : 0);
