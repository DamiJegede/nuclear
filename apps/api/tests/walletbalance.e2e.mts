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
const env: any = { HYPERDRIVE: { connectionString: "postgres://postgres@127.0.0.1:54340/nuclear" }, JWT_SECRET: "x".repeat(40), ADMIN_API_TOKEN: OP, SANDBOX_FUNDING: "true", DAILY_VALUE_CAP_CENTS: "5000000" };
const ctx: any = { waitUntil: (p: Promise<unknown>) => void p.catch(() => {}), passThroughOnException() {} };
let pass = 0, fail = 0;
const eq = (l: string, g: unknown, w: unknown) => { const ok = JSON.stringify(g) === JSON.stringify(w); ok ? pass++ : fail++; console.log(ok ? "ok  " : "FAIL", l, ok ? "" : `got ${JSON.stringify(g)} want ${JSON.stringify(w)}`); };
const call = async (method: string, path: string, o: { body?: unknown; token?: string; key?: string } = {}) => {
  const r = await app.fetch(new Request("http://x" + path, { method, headers: { "content-type": "application/json", ...(o.token ? { authorization: `Bearer ${o.token}` } : {}), ...(o.key ? { "idempotency-key": o.key } : {}) }, body: o.body === undefined ? undefined : JSON.stringify(o.body) }), env, ctx);
  const t = await r.text(); return { status: r.status, json: t ? JSON.parse(t) : null };
};
const signup = async (name: string, email: string, type = "C") => (await call("POST", "/v1/auth/signup", { body: { name, email, password: "correct horse battery", type } })).json;

const ada = await signup("Ada", "ada@example.com"), bob = await signup("Bob", "bob@example.com"), shop = await signup("Shop", "shop@example.com", "B");
const A = ada.session_token, B = bob.session_token, S = shop.session_token;
await call("POST", "/v1/sandbox/fundings", { token: A, key: "f1", body: { amount: 10000 } });
const wallets = async (t: string) => (await call("GET", "/v1/wallets", { token: t })).json.wallets;
const adaDefault = (await wallets(A)).find((w: any) => w.type === "default").id, bobDefault = (await wallets(B))[0].id;
const bal = async (t: string) => (await call("GET", "/v1/balance", { token: t })).json;
const send = (token: string, key: string, from: string, to: string, amount: number) => call("POST", "/v1/transfers", { token, key, body: { from_wallet_id: from, to_wallet_id: to, amount } });

// ---- creating wallets
const agent = (await call("POST", "/v1/wallets", { token: A, body: { display_name: "Agent", type: "agent", allow_send: true } })).json.wallet;
const person = (await call("POST", "/v1/wallets", { token: A, body: { display_name: "Kid", type: "person", allow_send: true } })).json.wallet;
eq("an agent wallet starts earmarked at 0, a person wallet shares the account's funds, the default wallet shares", [agent.balance, agent.earmarked, person.balance, person.earmarked, (await wallets(A))[0].balance], [0, true, null, false, null]);
eq("an agent wallet with nothing set aside cannot spend", await (async () => { const r = await send(A, "a0", agent.id, bobDefault, 100); return [r.status, r.json.status_code]; })(), [422, "wallet_balance_exceeded"]);
eq("and the decline is recorded as a failed transaction", (await q("select status, status_code from transactions where idempotency_key='a0'"))[0], { status: "failed", status_code: "wallet_balance_exceeded" });

// ---- setting aside funds
const set = (token: string, id: string, balance: number | null) => call("PUT", `/v1/wallets/${id}/balance`, { token, body: { balance } });
const s1 = await set(A, agent.id, 5000);
eq("the owner sets aside 5000: the account balance is unchanged, earmarked rises, the rest is shared", [s1.status, s1.json.wallet.balance, s1.json.change, (await bal(A)).balance, (await bal(A)).earmarked, (await bal(A)).available_to_send], [200, 5000, 5000, 10000, 5000, 5000]);
eq("more than the shared funds is refused with what is free", await (async () => { const r = await set(A, person.id, 5001); return [r.status, r.json.error, r.json.available]; })(), [422, "insufficient_shared_balance", 5000]);
eq("the change is logged", (await call("GET", `/v1/wallets/${agent.id}/allocations`, { token: A })).json.allocations.map((a: any) => [a.amount, a.balance_after]), [[5000, 5000]]);
eq("only the owner can set it; bad values are refused", [(await set(B, agent.id, 1)).status, (await call("PUT", `/v1/wallets/${agent.id}/balance`, { token: A, body: { balance: -5 } })).status, (await call("PUT", `/v1/wallets/${agent.id}/balance`, { token: A, body: {} })).status, (await set(A, "00000000-0000-7000-8000-000000000000", 1)).status], [404, 400, 400, 404]);

// ---- the hard limit
const a1 = await send(A, "a1", agent.id, bobDefault, 2000);
eq("the agent spends within its balance with no further approval", [a1.status, (await wallets(A)).find((w: any) => w.id === agent.id).balance, (await bal(A)).balance, (await bal(A)).earmarked], [201, 3000, 8000, 3000]);
const a2 = await send(A, "a2", agent.id, bobDefault, 3001);
eq("it cannot spend more than its balance even though the account has more", [a2.status, a2.json.status_code, (await bal(A)).balance], [422, "wallet_balance_exceeded", 8000]);
eq("the default wallet cannot touch the earmarked money: 5001 declined, 5000 allowed", [(await send(A, "d1", adaDefault, bobDefault, 5001)).json.status_code, (await send(A, "d2", adaDefault, bobDefault, 5000)).status, (await bal(A)).balance, (await bal(A)).earmarked, (await wallets(A)).find((w: any) => w.id === agent.id).balance], ["insufficient_balance", 201, 3000, 3000, 3000]);
eq("a shared (person) wallet is limited by the unearmarked funds only", [(await send(A, "p1", person.id, bobDefault, 1)).json.status_code], ["insufficient_balance"]);

// ---- incoming money and releasing
await call("POST", "/v1/sandbox/fundings", { token: B, key: "fb", body: { amount: 1000 } });
const inc = await send(B, "in1", bobDefault, agent.id, 400);
eq("money sent to an earmarked wallet becomes its balance", [inc.status, (await wallets(A)).find((w: any) => w.id === agent.id).balance, (await bal(A)).balance], [201, 3400, 3400]);
const lower = await set(A, agent.id, 1000);
eq("lowering returns the difference to the shared funds", [lower.json.change, (await bal(A)).earmarked, (await bal(A)).available_to_send, (await bal(A)).balance], [-2400, 1000, 2400, 3400]);
const rel = await set(A, agent.id, null);
eq("releasing (null) gives everything back and the wallet shares again", [rel.json.wallet.balance, rel.json.wallet.earmarked, rel.json.change, (await bal(A)).earmarked, (await bal(A)).available_to_send], [null, false, -1000, 0, 3400]);
eq("setting it again works; setting the same value is a no-op without a log entry", [(await set(A, agent.id, 600)).json.change, (await set(A, agent.id, 600)).json.change, (await call("GET", `/v1/wallets/${agent.id}/allocations`, { token: A })).json.allocations.length], [600, 0, 4]);

// ---- delegated session, merchant payment and refund
const link = await call("POST", `/v1/wallets/${agent.id}/links`, { token: A });
const AG = (await call("POST", "/v1/devices/redeem", { body: { token: link.json.url.split("/magic-link/")[1] } })).json.session_token;
eq("a delegated agent session sees its wallet's balance as what it can pay, and cannot change it", [(await bal(AG)).available_to_pay, (await call("PUT", `/v1/wallets/${agent.id}/balance`, { token: AG, body: { balance: 99999 } })).status], [600, 403]);
const term = (await call("POST", "/v1/terminals", { token: S, body: { name: "Counter" } })).json;
const T = term.session_token, tid = term.terminal.id;
const pay = (key: string, amount: number) => call("POST", "/v1/payments", { token: AG, key, body: { amount, terminal_id: tid } });
const p1 = await pay("ap1", 250);
eq("the agent pays a merchant from its balance", [p1.status, (await wallets(A)).find((w: any) => w.id === agent.id).balance, (await bal(AG)).available_to_pay], [201, 350, 350]);
const p2 = await pay("ap2", 351);
eq("a payment above the wallet balance is declined even with account funds and credit-free", [p2.status, p2.json.status_code ?? p2.json.error], [422, "wallet_balance_exceeded"]);
const ref = await call("POST", "/v1/terminal/refunds", { token: T, key: "rf1", body: { payment_id: p1.json.payment.id, mode: "full" } });
eq("a refund goes back to the earmarked wallet", [ref.status, (await wallets(A)).find((w: any) => w.id === agent.id).balance], [201, 600]);

// ---- closing, concurrency, invariant
const closing = (await call("POST", "/v1/wallets", { token: A, body: { display_name: "Temp", type: "agent", balance: 500 } })).json.wallet;
eq("creating with a balance sets it aside", [closing.balance, (await bal(A)).earmarked], [500, 1100]);
const closed = await call("PATCH", `/v1/wallets/${closing.id}`, { token: A, body: { status: "closed" } });
eq("closing a wallet returns its earmark to the shared funds", [closed.status, (await bal(A)).earmarked, (await q("select balance from wallets where id=$1", [closing.id]))[0].balance], [200, 600, null]);
eq("creating with more than the shared funds creates nothing", await (async () => { const before = (await wallets(A)).length; const r = await call("POST", "/v1/wallets", { token: A, body: { display_name: "Greedy", type: "agent", balance: 999999 } }); return [r.status, r.json.error, (await wallets(A)).length - before]; })(), [422, "insufficient_shared_balance", 0]);
const race = await Promise.all(Array.from({ length: 6 }, (_, i) => send(A, `race${i}`, agent.id, bobDefault, 200)));
eq("six simultaneous spends of 200 from a 600 balance: three succeed, three are declined, never below zero", [race.filter((r) => r.status === 201).length, (await q("select balance from wallets where id=$1", [agent.id]))[0].balance >= 0n], [3, true]);
eq("earmarks never exceed the account balance and the books still reconcile", [(await q("select coalesce(sum(w.balance),0)::int s, b.balance::int b from wallets w join balances b on b.account_id=w.account_id where w.account_id=$1 group by b.balance", [(await q("select id from accounts where email='ada@example.com'"))[0].id]))[0].s <= (await bal(A)).balance, (await call("GET", "/v1/admin/stats", { token: OP })).json.reconciliation], [true, { balances_match_ledger: true, balance_difference: 0, credit_matches_ledger: true, credit_difference: 0, ledger_balanced: true, earmarks_within_balances: true }]);
console.log(`\n${pass} passed, ${fail} failed`); await adm.end(); process.exit(fail ? 1 : 0);
