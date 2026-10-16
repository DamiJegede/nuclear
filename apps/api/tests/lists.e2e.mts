import { ROOT, applyMigration, migrate, psql, resetSchema } from "./db.ts";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import postgres from "postgres";
import app from "../src/index.ts";
psql(["-c", "drop schema public cascade; create schema public;"]);
migrate();
const adm = postgres("postgres://postgres@127.0.0.1:54340/nuclear", { max: 3, onnotice: () => {} });
const q = async (s: string, p: unknown[] = []) => (await adm.unsafe(s, p as any)) as any[];
const OP = "op-" + randomBytes(16).toString("hex");
const env: any = { HYPERDRIVE: { connectionString: "postgres://postgres@127.0.0.1:54340/nuclear" }, JWT_SECRET: "x".repeat(40), ADMIN_API_TOKEN: OP, SANDBOX_FUNDING: "true" };
const ctx: any = { waitUntil: (p: Promise<unknown>) => void p.catch(() => {}), passThroughOnException() {} };
let pass = 0, fail = 0;
const eq = (l: string, g: unknown, w: unknown) => { const ok = JSON.stringify(g) === JSON.stringify(w); ok ? pass++ : fail++; console.log(ok ? "ok  " : "FAIL", l, ok ? "" : `got ${JSON.stringify(g)} want ${JSON.stringify(w)}`); };
const call = async (method: string, path: string, o: { body?: unknown; token?: string; key?: string } = {}) => {
  const r = await app.fetch(new Request("http://x" + path, { method, headers: { "content-type": "application/json", ...(o.token ? { authorization: `Bearer ${o.token}` } : {}), ...(o.key ? { "idempotency-key": o.key } : {}) }, body: o.body === undefined ? undefined : JSON.stringify(o.body) }), env, ctx);
  const t = await r.text(); return { status: r.status, json: t ? JSON.parse(t) : null };
};
const op = (p: string) => call("GET", p, { token: OP });
const signup = async (name: string, email: string, type = "C") => (await call("POST", "/v1/auth/signup", { body: { name, email, password: "correct horse battery", type } })).json;

const ada = await signup("Ada Lovelace", "ada@example.com"), bob = await signup("Bob Builder", "bob@example.com");
await signup("Cafe Nero", "cafe@example.com", "B"); await signup("Bakery 100%", "bake@example.com", "B");
const A = ada.session_token;
await call("POST", "/v1/sandbox/fundings", { token: A, key: "f1", body: { amount: 10000 } });
const agent = (await call("POST", "/v1/wallets", { token: A, body: { display_name: "Agent Smith", type: "agent", allow_send: true, balance: 1000 } })).json;
const agentWallet = agent.wallet?.id ?? agent.id;
const bobWallet = (await call("GET", "/v1/wallets", { token: bob.session_token })).json.wallets[0].id;
const adaWallet = (await call("GET", "/v1/wallets", { token: A })).json.wallets.find((w: any) => w.type === "default").id;
await call("POST", "/v1/transfers", { token: A, key: "s1", body: { from_wallet_id: adaWallet, to_wallet_id: bobWallet, amount: 500 } });
await call("POST", "/v1/transfers", { token: A, key: "s2", body: { from_wallet_id: agentWallet, to_wallet_id: bobWallet, amount: 300 } });

eq("lists need admin credentials", [(await call("GET", "/v1/admin/users")).status, (await call("GET", "/v1/admin/merchants")).status, (await call("GET", "/v1/admin/transactions")).status], [401, 401, 401]);
const users = (await op("/v1/admin/users")).json.users;
eq("users: consumers only, newest first, with balance, wallets and agents", users.map((u: any) => [u.name, u.balance, u.wallets, u.agents]), [["Bob Builder", 800, 1, 0], ["Ada Lovelace", 9200, 2, 1]]);
eq("filter users by name, handle or email, case-insensitively", [(await op("/v1/admin/users?q=ada")).json.users.length, (await op("/v1/admin/users?q=BOB@EXAMPLE")).json.users.length, (await op("/v1/admin/users?q=zzz")).json.users.length], [1, 1, 0]);
eq("wildcards are literal in filters", [(await op("/v1/admin/users?q=%25")).json.users.length, (await op("/v1/admin/merchants?q=%25")).json.merchants.map((m: any) => m.name)], [0, ["Bakery 100%"]]);
const merchants = (await op("/v1/admin/merchants")).json.merchants;
eq("merchants: businesses only with terminals and payment totals", merchants.map((m: any) => [m.name, m.terminals, m.payments, m.volume]), [["Bakery 100%", 0, 0, 0], ["Cafe Nero", 0, 0, 0]]);
eq("filter merchants by name", (await op("/v1/admin/merchants?q=nero")).json.merchants.map((m: any) => m.name), ["Cafe Nero"]);

const all = (await op("/v1/admin/transactions")).json;
eq("all transactions with a count per filter card", [all.transactions.length, all.counts], [3, { all: 3, sends: 2, taps: 0, funds: 1, agents: 1 }]);
const sends = (await op("/v1/admin/transactions?kind=sends")).json;
eq("sends", sends.transactions.map((t: any) => [t.type, t.amount, t.from, t.from_wallet, t.to, t.agent]), [["send", 300, "Ada Lovelace", "Agent Smith", "Bob Builder", true], ["send", 500, "Ada Lovelace", "Ada Lovelace", "Bob Builder", false]]);
eq("each side carries a link target (user or merchant) and no photo unless it is an image address", sends.transactions.map((t: any) => [t.from_party?.kind, t.to_party?.kind, t.from_party?.photo, typeof t.from_party?.id]), [["user", "user", null, "string"], ["user", "user", null, "string"]]);
eq("funds", (await op("/v1/admin/transactions?kind=funds")).json.transactions.map((t: any) => [t.type, t.amount, t.status]), [["fund", 10000, "completed"]]);
eq("agents: activity from agent wallets only", (await op("/v1/admin/transactions?kind=agents")).json.transactions.map((t: any) => [t.amount, t.from_wallet, t.agent]), [[300, "Agent Smith", true]]);
eq("taps: none yet", (await op("/v1/admin/transactions?kind=taps")).json.transactions.length, 0);
const p1 = (await op("/v1/admin/transactions?limit=2")).json, p2 = (await op(`/v1/admin/transactions?limit=2&cursor=${encodeURIComponent(p1.next_cursor)}`)).json;
eq("paging by cursor", [p1.transactions.length, !!p1.next_cursor, p2.transactions.length, p2.next_cursor, new Set([...p1.transactions, ...p2.transactions].map((t: any) => t.id)).size], [2, true, 1, null, 3]);
eq("bad kind, limit and cursor are refused", [(await op("/v1/admin/transactions?kind=nope")).status, (await op("/v1/admin/transactions?limit=0")).status, (await op("/v1/admin/transactions?cursor=bad")).status], [400, 400, 400]);
const st = (await op("/v1/admin/stats")).json.payments;
eq("stats: agents row is a memo, lifetime and today, not added to the total", [st.agents, st.today.agents, st.total.count], [{ count: 1, volume: 300 }, { count: 1, volume: 300 }, 2]);
// ---- date / period filtering (program days, America/New_York)
for (let i = 0; i < 12; i++) await call("POST", "/v1/transfers", { token: A, key: "extra" + i, body: { from_wallet_id: adaWallet, to_wallet_id: bobWallet, amount: 1 + i } });   // enough rows to place around the edges
const ids = (await q("select id from transactions order by id")).map((r: any) => r.id);
const stamp = (id: string, iso: string) => q('update transactions set "timestamp" = $2::timestamptz, completed_at = case when completed_at is null then null else $2::timestamptz end where id = $1', [id, iso]);
// transactions around midnight New York (EDT, UTC-4): 03:59:59Z is still the day before, 04:00:00Z starts the day
await stamp(ids[0], "2026-10-15T03:59:59Z"); await stamp(ids[1], "2026-10-15T04:00:00Z"); await stamp(ids[2], "2026-10-16T03:59:59Z"); await stamp(ids[3], "2026-10-16T04:00:00Z");
const f = async (qs: string) => (await op(`/v1/admin/transactions?${qs}`)).json;
const idsIn = (r: any) => r.transactions.map((t: any) => t.id).sort();
eq("a day starts at 00:00 New York: 03:59:59Z is the day before, 04:00:00Z is the day (EDT)", [idsIn(await f("from=2026-10-15&to=2026-10-15")), idsIn(await f("from=2026-10-14&to=2026-10-14")).includes(ids[0]), idsIn(await f("from=2026-10-16&to=2026-10-16")).includes(ids[3])], [[ids[1], ids[2]].sort(), true, true]);
eq("from alone means that day onwards, to alone means up to that day (inclusive)", [idsIn(await f("from=2026-10-16")).includes(ids[3]), idsIn(await f("from=2026-10-16")).includes(ids[2]), idsIn(await f("to=2026-10-14")).includes(ids[0]), idsIn(await f("to=2026-10-14")).includes(ids[1])], [true, false, true, false]);
await stamp(ids[4], "2026-11-01T03:59:59Z"); await stamp(ids[5], "2026-11-01T04:00:00Z"); await stamp(ids[6], "2026-11-02T04:59:59Z"); await stamp(ids[7], "2026-11-02T05:00:00Z");
eq("1 November 2026 (fall back) is 25 hours: 04:00:00Z to 04:59:59Z the next day belong to it, 05:00:00Z starts the 2nd", [idsIn(await f("from=2026-11-01&to=2026-11-01")), idsIn(await f("from=2026-11-02&to=2026-11-02")).includes(ids[7])], [[ids[5], ids[6]].sort(), true]);
await stamp(ids[8], "2026-03-08T04:59:59Z"); await stamp(ids[9], "2026-03-08T05:00:00Z"); await stamp(ids[10], "2026-03-09T03:59:59Z"); await stamp(ids[11], "2026-03-09T04:00:00Z");
eq("8 March 2026 (spring forward) is 23 hours: 05:00:00Z to 03:59:59Z the next day belong to it", [idsIn(await f("from=2026-03-08&to=2026-03-08")), idsIn(await f("from=2026-03-09&to=2026-03-09")).includes(ids[11])], [[ids[9], ids[10]].sort(), true]);
const day15 = await f("from=2026-10-15&to=2026-10-15");
eq("the filter cards' counts follow the period; the kind filter too", [day15.counts.all, (await f("from=2026-10-15&to=2026-10-16")).counts.all, (await f("from=2026-10-15&to=2026-10-16&kind=sends")).transactions.every((t: any) => t.type === "send")], [2, (await q('select count(*)::int n from transactions where "timestamp" >= \'2026-10-15T04:00:00Z\' and "timestamp" < \'2026-10-17T04:00:00Z\''))[0].n, true]);
eq("totals are the completed transactions' count and volume for the filter and period", await (async () => { const r = await f("from=2026-10-15&to=2026-10-16"); const rows = (await q("select count(*)::int n, coalesce(sum(amount),0)::int v from transactions where status='completed' and \"timestamp\" >= '2026-10-15T04:00:00Z' and \"timestamp\" < '2026-10-17T04:00:00Z'"))[0]; return [r.totals.completed_count === rows.n, r.totals.completed_volume === rows.v]; })(), [true, true]);
eq("an empty period gives an empty answer, not an error", [(await f("from=2020-01-01&to=2020-01-02")).transactions.length, (await f("from=2020-01-01&to=2020-01-02")).counts.all, (await f("from=2020-01-01&to=2020-01-02")).totals], [0, 0, { completed_count: 0, completed_volume: 0 }]);
eq("bad dates are refused: wrong format, impossible date, from after to", [(await op("/v1/admin/transactions?from=2026/10/15")).status, (await op("/v1/admin/transactions?from=2026-02-30")).status, (await op("/v1/admin/transactions?from=2026-10-16&to=2026-10-15")).status, (await op("/v1/admin/transactions?to=tomorrow")).status], [400, 400, 400, 400]);
eq("paging inside a period follows the cursor and stays inside it", await (async () => { const a = await f("from=2026-10-15&to=2026-10-16&limit=1"); const b = await f(`from=2026-10-15&to=2026-10-16&limit=5&cursor=${encodeURIComponent(a.next_cursor)}`); return [a.transactions.length, !!a.next_cursor, [...a.transactions, ...b.transactions].map((t: any) => t.id).sort()]; })(), [1, true, idsIn(await f("from=2026-10-15&to=2026-10-16"))]);
console.log(`\n${pass} passed, ${fail} failed`); await adm.end(); process.exit(fail ? 1 : 0);
