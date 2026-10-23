import { createCipheriv, randomBytes } from "node:crypto";
import postgres from "postgres";
import app from "../src/index.ts";
import { totp } from "../src/lib/totp.ts";
import { migrate, resetSchema, PG_URL } from "./db.ts";
resetSchema(); migrate();
const adm = postgres(PG_URL, { max: 3, onnotice: () => {} });
const q = async (s: string, p: unknown[] = []) => (await adm.unsafe(s, p as any)) as any[];
const OP = "op-" + randomBytes(16).toString("hex");
const TAG_KEY = randomBytes(16);
const env: any = { HYPERDRIVE: { connectionString: PG_URL }, JWT_SECRET: "x".repeat(40), ADMIN_API_TOKEN: OP, TAG_KEY_V1: TAG_KEY.toString("hex"), MFA_ENCRYPTION_KEY: randomBytes(32).toString("base64"), SANDBOX_FUNDING: "true", DAILY_VALUE_CAP_CENTS: "50000000" };
const ctx: any = { waitUntil: (p: Promise<unknown>) => void p.catch(() => {}), passThroughOnException() {} };
let pass = 0, fail = 0;
const eq = (l: string, g: unknown, w: unknown) => { const ok = JSON.stringify(g) === JSON.stringify(w); ok ? pass++ : fail++; console.log(ok ? "ok  " : "FAIL", l, ok ? "" : `got ${JSON.stringify(g)} want ${JSON.stringify(w)}`); };
const call = async (method: string, path: string, o: { body?: unknown; token?: string; key?: string } = {}) => {
  const r = await app.fetch(new Request("http://x" + path, { method, headers: { "content-type": "application/json", ...(o.token ? { authorization: `Bearer ${o.token}` } : {}), ...(o.key ? { "idempotency-key": o.key } : {}) }, body: o.body === undefined ? undefined : JSON.stringify(o.body) }), env, ctx);
  const t = await r.text(); return { status: r.status, json: t ? JSON.parse(t) : null };
};
const op = (p: string) => call("GET", p, { token: OP });
const signup = async (name: string, email: string, type = "C") => { const j = (await call("POST", "/v1/auth/signup", { body: { name, email, password: "correct horse battery", type } })).json; if (type === "B") await q("update accounts set status='active' where id=$1", [j.account_id]); return j; }; // businesses start pending; these suites need them live
const urlFor = (uid: string, counter: number) => { const pt = Buffer.alloc(16, 0x55); pt[0] = 0xc7; Buffer.from(uid, "hex").copy(pt, 1); pt.writeUIntLE(counter, 8, 3); const c = createCipheriv("aes-128-cbc", TAG_KEY, Buffer.alloc(16)); c.setAutoPadding(false); return `https://tag.nclr.app/v1/${Buffer.concat([c.update(pt), c.final()]).toString("hex")}`; };

// ---- a person with a busy life
const ada = await signup("Ada Lovelace", "ada@example.com"), bob = await signup("Bob", "bob@example.com"), shop = await signup("Cafe", "cafe@example.com", "B"), poor = await signup("Poor", "poor@example.com");
const A = ada.session_token, U = ada.account_id;
await call("PUT", "/v1/account/handle", { token: A, body: { handle: "ada01" } });
await call("POST", "/v1/sandbox/fundings", { token: A, key: "f1", body: { amount: 100000 } });
await call("POST", "/v1/sandbox/fundings", { token: bob.session_token, key: "fb", body: { amount: 5000 } });
const agent = (await call("POST", "/v1/wallets", { token: A, body: { display_name: "Ada's Agent", type: "agent", allow_send: true, balance: 20000, daily_limit: 5000 } })).json;
const kid = (await call("POST", "/v1/wallets", { token: A, body: { display_name: "Kid", type: "person", allow_pay: false } })).json.wallet;
const term = (await call("POST", "/v1/terminals", { token: shop.session_token, body: { name: "Counter" } })).json, approvalTerm = (await call("POST", "/v1/terminals", { token: shop.session_token, body: { name: "Bar", allow_refunds: false } })).json;
await call("POST", "/v1/transfers", { token: A, key: "s1", body: { to_wallet_id: bob.default_wallet_id, amount: 1500 } });
await call("POST", "/v1/transfers", { token: agent.key, key: "s2", body: { to_wallet_id: bob.default_wallet_id, amount: 700 } });
await call("POST", "/v1/transfers", { token: bob.session_token, key: "s3", body: { to_wallet_id: ada.default_wallet_id, amount: 400 } });
const p1 = await call("POST", "/v1/payments", { token: A, key: "p1", body: { amount: 2500, terminal_id: term.terminal.id } });
const p2 = await call("POST", "/v1/payments", { token: A, key: "p2", body: { amount: 900, terminal_id: approvalTerm.terminal.id } });
await call("POST", "/v1/terminal/refunds", { token: term.session_token, key: "r1", body: { payment_id: p1.json.payment.id, mode: "partial", amount: 500 } });
await call("POST", "/v1/terminal/refunds", { token: approvalTerm.session_token, key: "r2", body: { payment_id: p2.json.payment.id, mode: "full" } });   // pending: not the customer's business yet
await call("POST", "/v1/transfers", { token: poor.session_token, key: "bad", body: { to_wallet_id: ada.default_wallet_id, amount: 100 } });           // someone else's failure: not ada's
await call("POST", "/v1/transfers", { token: A, key: "overdraw", body: { from_wallet_id: kid.id, to_wallet_id: bob.default_wallet_id, amount: 100 } });   // fails: the kid wallet has no allow_send
const model = (await call("POST", "/v1/admin/tag-models", { token: OP, body: { type: "band", name: "NEO Band", price: 2999, quantity: 5, status: "available" } })).json.model;
const uid = "04" + randomBytes(6).toString("hex").toUpperCase();
await call("POST", `/v1/admin/tag-models/${model.id}/tags`, { token: OP, body: { uids: [uid] } });
await call("POST", "/v1/tags/claim", { token: A, body: { url: urlFor(uid, 1), label: "Wrist" } });
await call("POST", "/v1/shop/orders", { token: A, key: "o1", body: { model_id: model.id, quantity: 1, shipping: { name: "Ada", line1: "1 St", city: "London", region: "LDN", postal_code: "N1", country: "gb" } } });
const second = (await call("POST", "/v1/auth/login", { body: { email: "ada@example.com", password: "correct horse battery", platform: "ios" } })).json.session_token;
const kidSession = (await call("POST", "/v1/devices/redeem", { body: { token: (await call("POST", `/v1/wallets/${kid.id}/links`, { token: A })).json.url.split("/magic-link/")[1] } })).json.session_token;

// ---- people with roles
async function person(name: string, role: string) {
  const made = (await call("POST", "/v1/admin/admins", { token: OP, body: { name, role } })).json;
  const T = (await call("POST", "/v1/admin/login", { body: { access_id: made.credentials.access_id, access_token: made.credentials.access_token } })).json.session_token as string;
  const setup = (await call("POST", "/v1/admin/mfa/setup", { token: T })).json;
  await call("POST", "/v1/admin/mfa/enable", { token: T, body: { code: totp(setup.secret, Date.now()) } });
  return T;
}
const R: Record<string, string> = {}; for (const r of ["admin", "sales", "support", "merchants", "accounting", "tags"]) R[r] = await person(r, r);
const act = (role: string, path: string, method = "POST", body?: unknown) => call(method, path, { token: role === "operator" ? OP : R[role], body });

// ---- the profile
const d = (await op(`/v1/admin/users/${U}`)).json.user;
eq("profile: name, handle, email, status, joined; the login is not locked", [d.name, d.handle, d.email, d.status, d.login_locked, d.created_at !== null], ["Ada Lovelace", "ada01", "ada@example.com", "active", null, true]);
eq("balances: total, shared funds and earmarked money are separate", [d.balances.balance, d.balances.earmarked, d.balances.shared, d.balances.balance - d.balances.earmarked === d.balances.shared], [(await q("select balance::int b from balances where account_id=$1", [U]))[0].b, 20000 - 700, (await q("select balance::int b from balances where account_id=$1", [U]))[0].b - (20000 - 700), true]);
eq("numbers: sent, received, merchant payments, loads, failed attempts of their own, wallets, agents, tags, active devices, orders", [d.stats.sent, d.stats.received, d.stats.payments, d.stats.loads, d.stats.failed, d.stats.wallets, d.stats.agents, d.stats.tags, d.stats.devices, d.stats.orders], [{ count: 2, volume: 2200 }, { count: 1, volume: 400 }, { count: 2, volume: 2500 + 900 }, { count: 1, volume: 100000 }, 1, 3, 1, 1, 3, 1]);
eq("only people: a merchant id, an unknown id and a bad id are 404 on every route", await Promise.all(["", "/wallets", "/tags", "/devices", "/funding", "/orders", "/transactions"].map(async (sub) => [(await op(`/v1/admin/users/${shop.account_id}${sub}`)).status, (await op(`/v1/admin/users/00000000-0000-7000-8000-000000000000${sub}`)).status, (await op(`/v1/admin/users/nope${sub}`)).status].join("/"))), Array(7).fill("404/404/404"));
eq("the profile carries no password hash, token hash or key", JSON.stringify(d).match(/scrypt|hash|nk_agent/i), null);

// ---- wallets, tags, devices, funding, orders
const wal = (await op(`/v1/admin/users/${U}/wallets`)).json.wallets;
eq("wallets: default first, then agent and person, with earmark, limits, permissions and the agent key's hint only", wal.map((w: any) => [w.name, w.type, w.earmarked, w.balance, w.daily_limit, w.allow_pay, w.allow_send, w.key?.hint ?? null]), [["Ada Lovelace", "default", false, null, null, true, true, null], ["Ada's Agent", "agent", true, 19300, 5000, true, true, agent.key.slice(-4)], ["Kid", "person", false, null, null, false, false, null]]);
eq("tags: the band, its model, label and wallet (no NFC UID)", [(await op(`/v1/admin/users/${U}/tags`)).json.tags.map((t: any) => [t.model, t.model_type, t.label, t.locked, t.wallet]), JSON.stringify((await op(`/v1/admin/users/${U}/tags`)).json).includes(uid)], [[["NEO Band", "band", "Wrist", false, "Ada Lovelace"]], false]);
const dev = (await op(`/v1/admin/users/${U}/devices`)).json.devices;
eq("devices: each login and the delegated session, with platform, activity and whether it is active; never a token", [dev.length, dev.filter((x: any) => x.active).length, dev.some((x: any) => x.platform === "ios"), dev.some((x: any) => x.wallet === "Kid"), JSON.stringify(dev).match(/token|hash/i)], [3, 3, true, true, null]);
const fund = (await op(`/v1/admin/users/${U}/funding`)).json.funding;
eq("funding: bank accounts and every load with its status", [fund.fundings.length, fund.fundings[0].status, fund.fundings[0].amount, fund.banks.length], [1, "completed", 100000, 1]);
eq("orders: model, quantity, total, status and where it ships (city, not the full address)", (await op(`/v1/admin/users/${U}/orders`)).json.orders.map((o: any) => [o.model_name, o.quantity, o.total, o.status, o.shipping.city]), [["NEO Band", 1, 2999, "paid", "London"]]);

// ---- transactions
const all = (await op(`/v1/admin/users/${U}/transactions`)).json;
eq("each row names both sides and links them (user or merchant); the bank and the store have no link", all.transactions.every((t: any) => "from" in t && "to" in t && (t.from_party === null || ["user", "merchant"].includes(t.from_party.kind)) && (t.to_party === null || ["user", "merchant"].includes(t.to_party.kind))) && all.transactions.some((t: any) => t.from_party?.kind === "user" || t.to_party?.kind === "user"), true);
eq("a load comes from the bank (named, no link)", all.transactions.filter((t: any) => t.type === "fund").every((t: any) => t.from === "Bank" && t.from_party === null && t.to_party?.id === U), true);
eq("transactions: everything the account took part in; someone else's failure and a pending refund request are not shown; counts per filter", [all.transactions.length, all.counts], [9, { all: 9, sends: 3, received: 1, payments: 3, loads: 1, refunds: 1 }]);
const kinds = await Promise.all(["sends", "received", "payments", "loads", "refunds"].map(async (k) => (await op(`/v1/admin/users/${U}/transactions?kind=${k}`)).json.transactions.map((t: any) => `${t.type}:${t.status}`).sort().join(",")));
eq("kinds: sends (including the failed one), received, payments (pay and the store purchase), loads, refunds", kinds, ["send:completed,send:completed,send:failed", "send:completed", "pay:completed,pay:completed,purchase:completed", "fund:completed", "refund:completed"]);
eq("rows say who, which wallet, how and why: counterparty, wallet, agent flag, via, status code", all.transactions.filter((t: any) => t.type === "send" || t.type === "purchase").map((t: any) => [t.direction, t.counterparty, t.wallet, t.agent, t.status_code, t.amount]).sort((a: any, b: any) => JSON.stringify(a).localeCompare(JSON.stringify(b))), [["in", "Bob", "Ada Lovelace", false, null, 400], ["out", "Bob", "Ada Lovelace", false, null, 1500], ["out", "Bob", "Ada's Agent", true, null, 700], ["out", "Bob", "Kid", false, "send_not_allowed", 100], ["out", "Nuclear store", "Ada Lovelace", false, null, 2999]].sort((a: any, b: any) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
eq("money in and out are completed money only", all.totals, { money_out: 1500 + 700 + 2500 + 900 + 2999, money_in: 100000 + 400 + 500 });
eq("period, paging and bad input behave as on the other lists", await (async () => { const a = (await op(`/v1/admin/users/${U}/transactions?limit=4`)).json; const b = (await op(`/v1/admin/users/${U}/transactions?limit=10&cursor=${encodeURIComponent(a.next_cursor)}`)).json; return [(await op(`/v1/admin/users/${U}/transactions?from=2020-01-01&to=2020-01-31`)).json.counts.all, a.transactions.length, b.transactions.length, new Set([...a.transactions, ...b.transactions].map((t: any) => t.id)).size, (await op(`/v1/admin/users/${U}/transactions?kind=nope`)).status, (await op(`/v1/admin/users/${U}/transactions?from=bad`)).status]; })(), [0, 4, 5, 9, 400, 400]);

// ---- who can look, who can act
const looks = await Promise.all(["admin", "sales", "support", "merchants", "accounting", "tags"].map(async (r) => [r, (await Promise.all([`/v1/admin/users/${U}`, `/v1/admin/users/${U}/wallets`, `/v1/admin/users/${U}/transactions`].map((p) => call("GET", p, { token: R[r] }).then((x) => x.status)))).join("/")]));
eq("looking at a person: Admin, Sales and Support may; Merchants, Accounting and Tags may not", looks, [["admin", "200/200/200"], ["sales", "200/200/200"], ["support", "200/200/200"], ["merchants", "403/403/403"], ["accounting", "403/403/403"], ["tags", "403/403/403"]]);
eq("support actions are for Admin and Support only: Sales (read-only) and the rest get 403", await Promise.all(["sales", "merchants", "accounting", "tags"].flatMap((r) => [act(r, `/v1/admin/users/${U}/sign-out`), act(r, `/v1/admin/users/${U}/unlock-login`), act(r, `/v1/admin/wallets/${agent.wallet.id}/revoke-key`)]).map((p) => p.then((x) => x.status))), Array(12).fill(403));
eq("suspending is Admin only (Support may not); bad statuses are refused", [(await act("support", `/v1/admin/users/${U}/status`, "PUT", { status: "suspended" })).status, (await act("sales", `/v1/admin/wallets/${agent.wallet.id}/status`, "PUT", { status: "suspended" })).status, (await act("admin", `/v1/admin/users/${U}/status`, "PUT", { status: "closed" })).status, (await act("admin", `/v1/admin/users/${shop.account_id}/status`, "PUT", { status: "suspended" })).status], [403, 403, 400, 404]);

// ---- the actions
eq("unlock login: five wrong passwords lock the person out and the page says so; Support unlocks them", await (async () => {
  for (let i = 0; i < 5; i++) await call("POST", "/v1/auth/login", { body: { email: "ada@example.com", password: "wrong horse battery staple" } });
  const locked = (await op(`/v1/admin/users/${U}`)).json.user.login_locked;
  const blocked = (await call("POST", "/v1/auth/login", { body: { email: "ada@example.com", password: "correct horse battery" } })).status;
  const un = await act("support", `/v1/admin/users/${U}/unlock-login`);
  return [locked !== null && locked.retry_after > 0, blocked, un.status, (await op(`/v1/admin/users/${U}`)).json.user.login_locked, (await call("POST", "/v1/auth/login", { body: { email: "ada@example.com", password: "correct horse battery" } })).status];
})(), [true, 429, 204, null, 200]);
const before = (await op(`/v1/admin/users/${U}`)).json.user.stats.devices;
const out = await act("support", `/v1/admin/users/${U}/sign-out`);
eq("sign out everywhere: every session, including the delegated one, stops working at once; money and wallets are untouched", [before > 3, out.status, out.json.signed_out >= before, (await call("GET", "/v1/account", { token: A })).status, (await call("POST", "/v1/transfers", { token: second, key: "so-1", body: { to_wallet_id: bob.default_wallet_id, amount: 1 } })).status, (await call("GET", "/v1/balance", { token: kidSession })).status, (await op(`/v1/admin/users/${U}`)).json.user.stats.devices, (await call("GET", "/v1/balance", { token: agent.key })).status], [true, 200, true, 401, 401, 401, 0, 200]);
const A2 = (await call("POST", "/v1/auth/login", { body: { email: "ada@example.com", password: "correct horse battery" } })).json.session_token;
eq("revoke the agent key: it stops working at once and the wallet shows no key; the owner can issue a new one", [(await act("support", `/v1/admin/wallets/${agent.wallet.id}/revoke-key`)).status, (await call("GET", "/v1/balance", { token: agent.key })).status, (await op(`/v1/admin/users/${U}/wallets`)).json.wallets.find((w: any) => w.type === "agent").key, (await act("admin", `/v1/admin/wallets/${agent.wallet.id}/revoke-key`)).status, (await call("POST", `/v1/wallets/${agent.wallet.id}/key`, { token: A2 })).status], [204, 401, null, 404, 201]);
const newKey = (await call("POST", `/v1/wallets/${agent.wallet.id}/key`, { token: A2 })).json.key as string;
eq("suspend one wallet: its agent key is refused, the person's other wallets work, and it can be reactivated", [(await act("admin", `/v1/admin/wallets/${agent.wallet.id}/status`, "PUT", { status: "suspended" })).json.wallet.status, (await call("GET", "/v1/balance", { token: newKey })).status, (await call("GET", "/v1/balance", { token: A2 })).status, (await op(`/v1/admin/users/${U}/wallets`)).json.wallets.find((w: any) => w.type === "agent").status, (await act("admin", `/v1/admin/wallets/${agent.wallet.id}/status`, "PUT", { status: "active" })).status, (await call("GET", "/v1/balance", { token: newKey })).status], ["suspended", 401, 200, "suspended", 200, 200]);
const susp = await act("admin", `/v1/admin/users/${U}/status`, "PUT", { status: "suspended" });
eq("suspend the person: every session and key is refused, they cannot sign in, nobody can pay them, and the page still shows everything", [susp.status, susp.json.user.status, (await op(`/v1/admin/users/${U}`)).json.user.status, (await call("GET", "/v1/account", { token: A2 })).status, (await call("GET", "/v1/balance", { token: newKey })).status, (await call("POST", "/v1/auth/login", { body: { email: "ada@example.com", password: "correct horse battery" } })).status, (await call("POST", "/v1/transfers", { token: bob.session_token, key: "toSusp", body: { to_wallet_id: ada.default_wallet_id, amount: 100 } })).json.status_code, (await op(`/v1/admin/users/${U}/transactions`)).json.counts.all > 0], [200, "suspended", "suspended", 401, 401, 401, "recipient_unavailable", true]);
const react = await act("admin", `/v1/admin/users/${U}/status`, "PUT", { status: "active" });
eq("reactivate: they sign in again and everything resumes", [react.status, (await call("POST", "/v1/auth/login", { body: { email: "ada@example.com", password: "correct horse battery" } })).status, (await call("GET", "/v1/balance", { token: newKey })).status], [200, 200, 200]);
eq("the operator token can do all of it", [(await act("operator", `/v1/admin/users/${U}/sign-out`)).status, (await act("operator", `/v1/admin/users/${U}/unlock-login`)).status, (await act("operator", `/v1/admin/users/${U}/status`, "PUT", { status: "active" })).status], [200, 204, 200]);
console.log(`\n${pass} passed, ${fail} failed`); await adm.end(); process.exit(fail ? 1 : 0);
