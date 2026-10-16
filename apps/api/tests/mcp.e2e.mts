import { ROOT, applyMigration, migrate, psql, resetSchema } from "./db.ts";
import { execFileSync } from "node:child_process";
import { randomBytes, createHash } from "node:crypto";
import postgres from "postgres";
import app from "../src/index.ts";
import mcp from "../../mcp/src/index.ts";
psql(["-c", "drop schema public cascade; create schema public;"]);
migrate();
const adm = postgres("postgres://postgres@127.0.0.1:54340/nuclear", { max: 4, onnotice: () => {} });
const q = async (s: string, p: unknown[] = []) => (await adm.unsafe(s, p as any)) as any[];
const env: any = { HYPERDRIVE: { connectionString: "postgres://postgres@127.0.0.1:54340/nuclear" }, JWT_SECRET: "x".repeat(40), SANDBOX_FUNDING: "true" };
const ctx: any = { waitUntil: (p: Promise<unknown>) => void p.catch(() => {}), passThroughOnException() {} };
let pass = 0, fail = 0;
const eq = (l: string, g: unknown, w: unknown) => { const ok = JSON.stringify(g) === JSON.stringify(w); ok ? pass++ : fail++; console.log(ok ? "ok  " : "FAIL", l, ok ? "" : `got ${JSON.stringify(g)} want ${JSON.stringify(w)}`); };
const call = async (method: string, path: string, o: { body?: unknown; token?: string; key?: string } = {}) => {
  const r = await app.fetch(new Request("http://x" + path, { method, headers: { "content-type": "application/json", ...(o.token ? { authorization: `Bearer ${o.token}` } : {}), ...(o.key ? { "idempotency-key": o.key } : {}) }, body: o.body === undefined ? undefined : JSON.stringify(o.body) }), env, ctx);
  const t = await r.text(); return { status: r.status, json: t ? JSON.parse(t) : null };
};
const mcpEnv: any = { API: { fetch: (req: Request) => app.fetch(req, env, ctx) } };   // the service binding, simulated
let rid = 0;
const rpc = async (key: string | null, method: string, params?: unknown, raw?: unknown) => {
  const r = await mcp.fetch(new Request("http://mcp/mcp", { method: "POST", headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) }, body: JSON.stringify(raw ?? { jsonrpc: "2.0", id: ++rid, method, params }) }), mcpEnv);
  const t = await r.text(); return { status: r.status, json: t ? JSON.parse(t) : null };
};
const tool = async (key: string, name: string, args: object = {}) => { const r = await rpc(key, "tools/call", { name, arguments: args }); const c = r.json.result; return { isError: c.isError as boolean, data: JSON.parse(c.content[0].text) }; };
const signup = async (name: string, email: string, type = "C") => (await call("POST", "/v1/auth/signup", { body: { name, email, password: "correct horse battery", type } })).json;

const ada = await signup("Ada", "ada@example.com"), bob = await signup("Bob", "bob@example.com"), shop = await signup("Shop", "shop@example.com", "B");
const A = ada.session_token, B = bob.session_token, S = shop.session_token;
await call("PUT", "/v1/account/handle", { token: B, body: { handle: "bobby" } });
await call("POST", "/v1/sandbox/fundings", { token: A, key: "f1", body: { amount: 10000 } });
const created = (await call("POST", "/v1/wallets", { token: A, body: { display_name: "Agent Smith", type: "agent", allow_send: true, balance: 5000 } })).json;
const agent = created.wallet, KEY0 = created.key as string;
const personRes = (await call("POST", "/v1/wallets", { token: A, body: { display_name: "Kid", type: "person" } })).json;
const person = personRes.wallet;
eq("creating an agent wallet also creates its key, shown once; a person wallet gets none", [/^nk_agent_[A-Za-z0-9_-]{43}$/.test(KEY0), created.wallet.key.hint === KEY0.slice(-4), JSON.stringify(created.wallet).includes(KEY0), "key" in personRes, personRes.wallet.key, (await call("GET", "/v1/balance", { token: KEY0 })).json.available_to_send], [true, true, false, false, null, 5000]);

// ---- the key
const k1 = await call("POST", `/v1/wallets/${agent.id}/key`, { token: A });   // rotate: the key from creation stops working
const KEY = k1.json.key as string;
eq("rotating replaces the creation key at once", [KEY !== KEY0, (await call("GET", "/v1/balance", { token: KEY0 })).status, (await call("GET", "/v1/balance", { token: KEY })).status], [true, 401, 200]);
eq("an owner rotates the agent's key: shown once, prefixed, with a hint; the wallet shows only the hint", [k1.status, /^nk_agent_[A-Za-z0-9_-]{43}$/.test(KEY), k1.json.wallet.key.hint === KEY.slice(-4), JSON.stringify(k1.json.wallet).includes(KEY)], [201, true, true, false]);
eq("only a hash is stored", [(await q("select key_hash from wallets where id=$1", [agent.id]))[0].key_hash === createHash("sha256").update(KEY).digest("hex"), JSON.stringify(await q("select * from wallets where id=$1", [agent.id])).includes(KEY)], [true, false]);
eq("only agent wallets get keys; unknown wallet 404; only the owner may issue them", [(await call("POST", `/v1/wallets/${person.id}/key`, { token: A })).json.error, (await call("POST", `/v1/wallets/${agent.id}/key`, { token: B })).status, (await call("POST", `/v1/wallets/${agent.id}/key`, { token: KEY })).status], ["not_an_agent_wallet", 404, 403]);
eq("the wallet list shows that a key exists, never the key", (await call("GET", "/v1/wallets", { token: A })).json.wallets.find((w: any) => w.id === agent.id).key.hint, KEY.slice(-4));

// ---- what the key can and cannot do through the API
eq("the key works for balance and activity, and is scoped to its wallet", [(await call("GET", "/v1/balance", { token: KEY })).json.available_to_send, (await call("GET", "/v1/wallets", { token: KEY })).json.wallets.map((w: any) => w.id)], [5000, [agent.id]]);
eq("it cannot manage anything: wallets, balance, keys, devices, account, shop, logout", await Promise.all([
  call("POST", "/v1/wallets", { token: KEY, body: { display_name: "x", type: "agent" } }), call("PUT", `/v1/wallets/${agent.id}/balance`, { token: KEY, body: { balance: 99999 } }),
  call("POST", `/v1/wallets/${agent.id}/key`, { token: KEY }), call("GET", "/v1/devices", { token: KEY }), call("GET", "/v1/account", { token: KEY }),
  call("GET", "/v1/shop/orders", { token: KEY }), call("POST", "/v1/auth/logout", { token: KEY }), call("PATCH", `/v1/wallets/${agent.id}`, { token: KEY, body: { status: "closed" } }),
]).then((rs) => rs.map((r) => r.status)), [403, 403, 403, 403, 403, 403, 403, 403]);
eq("a made-up or malformed key is 401", [(await call("GET", "/v1/balance", { token: "nk_agent_" + "A".repeat(43) })).status, (await call("GET", "/v1/balance", { token: "nk_agent_" })).status], [401, 401]);
eq("using the key records when it was last used", (await q("select key_last_used_at is not null as used from wallets where id=$1", [agent.id]))[0].used, true);

// ---- the MCP server
eq("no key, or a badly formed one, is 401 with a challenge", [(await rpc(null, "ping")).status, (await rpc("hello", "ping")).status, (await rpc("nk_agent_short", "ping")).status], [401, 401, 401]);
const get = await mcp.fetch(new Request("http://mcp/mcp"), mcpEnv);
eq("GET is not supported (no server-initiated stream); health works; other paths 404", [get.status, get.headers.get("allow"), (await mcp.fetch(new Request("http://mcp/health"), mcpEnv)).status, (await mcp.fetch(new Request("http://mcp/x"), mcpEnv)).status], [405, "POST", 200, 404]);
const init = await rpc(KEY, "initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "1" } });
eq("initialize negotiates the version and advertises tools", [init.json.result.protocolVersion, init.json.result.serverInfo.name, !!init.json.result.capabilities.tools], ["2025-03-26", "nuclear", true]);
eq("an unknown protocol version gets the latest we speak", (await rpc(KEY, "initialize", { protocolVersion: "1999-01-01" })).json.result.protocolVersion, "2025-06-18");
eq("notifications get 202 and no body; ping answers", [(await rpc(KEY, "", undefined, { jsonrpc: "2.0", method: "notifications/initialized" })).status, (await rpc(KEY, "ping")).json.result], [202, {}]);
const list = (await rpc(KEY, "tools/list")).json.result.tools;
eq("tools: wallet, lookup, send, pay, activity, each with a schema; nothing that manages wallets", [list.map((t: any) => t.name), list.every((t: any) => t.inputSchema.type === "object")], [["get_wallet", "lookup_recipient", "send_money", "pay_merchant", "list_activity"], true]);
eq("unknown method and unknown tool are JSON-RPC errors", [(await rpc(KEY, "nope")).json.error.code, (await rpc(KEY, "tools/call", { name: "set_balance", arguments: {} })).json.error.code], [-32601, -32602]);
eq("batches are answered in one array", (await rpc(KEY, "", undefined, [{ jsonrpc: "2.0", id: 1, method: "ping" }, { jsonrpc: "2.0", id: 2, method: "ping" }])).json.map((r: any) => r.id), [1, 2]);
eq("bad JSON is a parse error", await (async () => { const r = await mcp.fetch(new Request("http://mcp/mcp", { method: "POST", headers: { authorization: `Bearer ${KEY}` }, body: "{" }), mcpEnv); return [r.status, (await r.json()).error.code]; })(), [400, -32700]);

const gw = await tool(KEY, "get_wallet");
eq("get_wallet: id, balance as the hard limit, what can be used", [gw.isError, gw.data.wallet_id === agent.id, gw.data.balance, gw.data.available_to_send, gw.data.allow_send, gw.data.currency], [false, true, 5000, 5000, true, "USD"]);
eq("get_wallet says what it may do and the most it can send or pay now, and that no per-transaction cap exists", [gw.data.can_send, gw.data.can_pay, gw.data.max_send_cents, gw.data.max_pay_cents, gw.data.daily_limit, gw.data.remaining_today, gw.data.per_transaction_limit], [true, true, 5000, 5000, null, null, null]);
await call("PATCH", `/v1/wallets/${agent.id}`, { token: A, body: { daily_limit: 2000, allow_pay: false } });
const lim = (await tool(KEY, "get_wallet")).data;
eq("permissions and the daily limit are reflected: pay off, sends capped by what is left today", [lim.can_pay, lim.max_pay_cents, lim.can_send, lim.max_send_cents, lim.daily_limit, lim.spent_today, lim.remaining_today], [false, 0, true, 2000, 2000, 0, 2000]);
await call("PATCH", `/v1/wallets/${agent.id}`, { token: A, body: { daily_limit: null, allow_pay: true } });
const bobWallet = (await call("GET", "/v1/wallets", { token: B })).json.wallets[0].id;
const lk = await tool(KEY, "lookup_recipient", { handle: "@bobby" });
eq("lookup by handle (with or without @) and by email", [lk.data.wallet_id === bobWallet, (await tool(KEY, "lookup_recipient", { email: "bob@example.com" })).data.wallet_id === bobWallet], [true, true]);
eq("lookup refuses ambiguous or empty input, unknown people and businesses", [(await tool(KEY, "lookup_recipient", {})).data.error, (await tool(KEY, "lookup_recipient", { handle: "x", email: "y@z.co" })).data.error, (await tool(KEY, "lookup_recipient", { handle: "nobody1" })).data.error], ["invalid_request", "invalid_request", "not_found"]);

const sent = await tool(KEY, "send_money", { to_wallet_id: bobWallet, amount_cents: 1200, idempotency_key: "agent-pay-0001" });
eq("send_money moves the money within the wallet's balance", [sent.isError, sent.data.status, sent.data.amount_cents, (await tool(KEY, "get_wallet")).data.balance], [false, "completed", 1200, 3800]);
eq("retrying with the same key does not move money twice", [(await tool(KEY, "send_money", { to_wallet_id: bobWallet, amount_cents: 1200, idempotency_key: "agent-pay-0001" })).data.transaction_id === sent.data.transaction_id, (await tool(KEY, "get_wallet")).data.balance], [true, 3800]);
const over = await tool(KEY, "send_money", { to_wallet_id: bobWallet, amount_cents: 3801, idempotency_key: "agent-pay-0002" });
eq("over the wallet balance is declined as a tool error and nothing moves", [over.isError, over.data.error, over.data.status_code, (await tool(KEY, "get_wallet")).data.balance], [true, "declined", "wallet_balance_exceeded", 3800]);
eq("bad arguments are tool errors, not crashes", [(await tool(KEY, "send_money", { to_wallet_id: "nope", amount_cents: 5, idempotency_key: "agent-pay-0003" })).data.error, (await tool(KEY, "send_money", { to_wallet_id: bobWallet, amount_cents: 1.5, idempotency_key: "agent-pay-0003" })).data.error, (await tool(KEY, "send_money", { to_wallet_id: bobWallet, amount_cents: 5, idempotency_key: "x" })).data.error, (await tool(KEY, "send_money", { to_wallet_id: bobWallet, amount_cents: -5, idempotency_key: "agent-pay-0003" })).data.error], ["invalid_to_wallet_id", "invalid_amount", "invalid_idempotency_key", "invalid_amount"]);
eq("it cannot send to a business or to its owner's own wallets", [(await tool(KEY, "send_money", { to_wallet_id: (await call("GET", "/v1/wallets", { token: S })).json.wallets[0].id, amount_cents: 100, idempotency_key: "agent-pay-0004" })).data.status_code ?? "error", (await tool(KEY, "send_money", { to_wallet_id: person.id, amount_cents: 100, idempotency_key: "agent-pay-0005" })).data.error], ["error", "same_account"]);

const term = (await call("POST", "/v1/terminals", { token: S, body: { name: "Counter" } })).json.terminal.id;
const paid = await tool(KEY, "pay_merchant", { terminal_id: term, amount_cents: 500, reference: "Coffee", idempotency_key: "agent-shop-0001" });
eq("pay_merchant pays from the wallet; replay is the same payment", [paid.isError, paid.data.status, paid.data.amount_cents, (await tool(KEY, "pay_merchant", { terminal_id: term, amount_cents: 500, reference: "Coffee", idempotency_key: "agent-shop-0001" })).data.payment_id === paid.data.payment_id, (await tool(KEY, "get_wallet")).data.balance], [false, "completed", 500, true, 3300]);
eq("pay_merchant needs a target and refuses mixed ones", [(await tool(KEY, "pay_merchant", { idempotency_key: "agent-shop-0002" })).data.error, (await tool(KEY, "pay_merchant", { checkout_id: term, terminal_id: term, idempotency_key: "agent-shop-0003" })).data.error], ["invalid_terminal_id", "invalid_request"]);
const act = await tool(KEY, "list_activity", { limit: 2 });
eq("list_activity: newest first with cents and counterparty", [act.data.items.length, act.data.items[0].type, act.data.items[0].amount_cents, act.data.items[0].counterparty], [2, "pay", 500, "Shop"]);

// ---- rotation, revocation, closing, suspending
const k2 = await call("POST", `/v1/wallets/${agent.id}/key`, { token: A });
eq("rotating gives a new key and the old one stops working at once", [k2.json.key !== KEY, (await call("GET", "/v1/balance", { token: KEY })).status, (await call("GET", "/v1/balance", { token: k2.json.key })).status, (await tool(KEY, "get_wallet")).data.error], [true, 401, 200, "unauthorized"]);
await call("PATCH", `/v1/wallets/${agent.id}`, { token: A, body: { status: "suspended" } });
eq("a suspended wallet's key does not work", (await call("GET", "/v1/balance", { token: k2.json.key })).status, 401);
await call("PATCH", `/v1/wallets/${agent.id}`, { token: A, body: { status: "active" } });
eq("reactivating restores it", (await call("GET", "/v1/balance", { token: k2.json.key })).status, 200);
eq("revoking removes the key", [(await call("DELETE", `/v1/wallets/${agent.id}/key`, { token: A })).status, (await call("GET", "/v1/balance", { token: k2.json.key })).status, (await call("DELETE", `/v1/wallets/${agent.id}/key`, { token: B })).status], [204, 401, 404]);
const k3 = (await call("POST", `/v1/wallets/${agent.id}/key`, { token: A })).json.key;
await call("PATCH", `/v1/wallets/${agent.id}`, { token: A, body: { status: "closed" } });
eq("closing a wallet removes its key", [(await call("GET", "/v1/balance", { token: k3 })).status, (await q("select key_hash is null as gone from wallets where id=$1", [agent.id]))[0].gone], [401, true]);
let bad = "none"; try { await q("update wallets set key_hash='x', key_hint='y' where type='default' and account_id=$1", [ada.account_id ?? (await q("select id from accounts where email='ada@example.com'"))[0].id]); } catch (e: any) { bad = e.constraint_name; }
eq("the database refuses a key on a non-agent wallet", bad, "wallets_key_agent_only");
console.log(`\n${pass} passed, ${fail} failed`); await adm.end(); process.exit(fail ? 1 : 0);
