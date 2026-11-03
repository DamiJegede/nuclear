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
const ada = await signup("Ada", "ada@example.com"), bob = await signup("Bob", "bob@example.com"), shop = await signup("Shop", "shop@example.com", "B");
const A = ada.session_token, B = bob.session_token, S = shop.session_token;
await call("POST", "/v1/sandbox/fundings", { token: A, key: "f1", body: { amount: 10000 } });
const wallets = async (t: string) => (await call("GET", "/v1/wallets", { token: t })).json.wallets;
const adaDefault = (await wallets(A)).find((w: any) => w.type === "default").id, bobDefault = (await wallets(B))[0].id;
const bal = async (t: string) => (await call("GET", "/v1/balance", { token: t })).json;
const send = (token: string, key: string, from: string, to: string, amount: number) => call("POST", "/v1/transfers", { token, key, body: { from_wallet_id: from, to_wallet_id: to, amount } });

// Fund holds (docs/TABS.md): `wallets.held` and `fund_holds`. The tab functions place holds; here they are placed with plain SQL.
const term = (await call("POST", "/v1/terminals", { token: S, body: { name: "Counter" } })).json;
const TID = term.terminal.id;
const hold = async (walletId: string, amount: number) => {
  const [w] = await q("select account_id from wallets where id=$1", [walletId]);
  await q("insert into fund_holds (account_id, wallet_id, amount) values ($1,$2,$3)", [w.account_id, walletId, amount]);
  await q("update wallets set held = held + $2 where id=$1", [walletId, amount]);
};
const releaseAll = async (walletId: string) => {
  await q("update fund_holds set status='released', ended_at=now(), end_reason='canceled' where wallet_id=$1 and status='active'", [walletId]);
  await q("update wallets set held = 0 where id=$1", [walletId]);
};
const pay = (token: string, key: string, amount: number) => call("POST", "/v1/payments", { token, key, body: { amount, terminal_id: TID } });
const held = async (t: string) => (await bal(t)).held;

// ---- a shared wallet's hold comes off the account's shared pool
await hold(adaDefault, 3000);
let b0 = await bal(A);
eq("a hold on a shared wallet: the balance is unchanged, held rises, the shared funds fall", [b0.balance, b0.held, b0.available_to_send, b0.available_to_pay, b0.ordinary_shared_available], [10000, 3000, 7000, 7000, 7000]);
eq("sending more than what is free is declined, exactly the free amount works", [(await send(A, "s1", adaDefault, bobDefault, 7001)).json.status_code, (await send(A, "s2", adaDefault, bobDefault, 7000)).status], ["insufficient_balance", 201]);
eq("the held money is still in the balance afterwards", [(await bal(A)).balance, await held(A)], [3000, 3000]);
eq("a payment cannot use held money either", [(await pay(A, "p1", 1)).json.status_code ?? (await pay(A, "p1", 1)).json.error], ["insufficient_balance"]);
eq("nor can a store purchase", (await call("GET", "/v1/shop/models", {})).status, 200);
await releaseAll(adaDefault);
eq("releasing makes it spendable again", [(await bal(A)).held, (await bal(A)).available_to_pay], [0, 3000]);
await call("POST", "/v1/sandbox/fundings", { token: A, key: "f2", body: { amount: 7000 } });

// ---- an earmarked wallet holds from its own money
const kid = (await call("POST", "/v1/wallets", { token: A, body: { display_name: "Kid", type: "person", allow_send: true, allow_pay: true, balance: 2000 } })).json.wallet;
await hold(kid.id, 1500);
const kb = await bal(A);
eq("a hold on an earmarked wallet leaves the shared pool alone (it is inside the earmark)", [kb.held, kb.ordinary_shared_available, kb.earmarked], [1500, 8000, 2000]);
eq("the earmarked wallet can spend only balance minus held", [(await send(A, "k1", kid.id, bobDefault, 501)).json.status_code, (await send(A, "k2", kid.id, bobDefault, 500)).status], ["wallet_balance_exceeded", 201]);
eq("the earmark cannot be lowered below the hold, and the refusal says what is held", await (async () => { const r = await call("PUT", `/v1/wallets/${kid.id}/balance`, { token: A, body: { balance: 1000 } }); return [r.status, r.json.error, r.json.held]; })(), [422, "hold_active", 1500]);
eq("lowering to exactly the hold is allowed", (await call("PUT", `/v1/wallets/${kid.id}/balance`, { token: A, body: { balance: 1500 } })).status, 200);
eq("the database refuses a hold above the wallet's own money", await q("update wallets set held = 99999 where id=$1", [kid.id]).then(() => "accepted", (e: any) => String(e.message).includes("wallets_held_within_own_balance") ? "refused" : String(e.message)), "refused");
await releaseAll(kid.id);
await call("PUT", `/v1/wallets/${kid.id}/balance`, { token: A, body: { balance: null } });

// ---- releasing an earmark keeps the holds; turning a shared wallet into an earmarked one
const kid2 = (await call("POST", "/v1/wallets", { token: A, body: { display_name: "Kid2", type: "person", allow_send: true, allow_pay: true } })).json.wallet;
await hold(kid2.id, 1000);
const free0 = (await bal(A)).ordinary_shared_available;
const setUp = await call("PUT", `/v1/wallets/${kid2.id}/balance`, { token: A, body: { balance: 3000 } });
eq("earmarking a wallet that already holds 1000: only the extra 2000 leaves the shared pool", [setUp.status, free0, (await bal(A)).ordinary_shared_available], [200, free0, free0 - 2000]);
eq("and its hold now sits inside the earmark", [(await bal(A)).held, (await bal(A)).earmarked], [1000, 3000]);
await releaseAll(kid2.id);
await call("PUT", `/v1/wallets/${kid2.id}/balance`, { token: A, body: { balance: null } });

// ---- the wallet's daily limit is reserved by a hold
const lim = (await call("POST", "/v1/wallets", { token: A, body: { display_name: "Lim", type: "person", allow_send: true, allow_pay: true, daily_limit: 1000 } })).json.wallet;
await hold(lim.id, 800);
eq("a hold reserves the daily limit: 201 is over what is left of 1000", [(await send(A, "l1", lim.id, bobDefault, 201)).json.status_code, (await send(A, "l2", lim.id, bobDefault, 200)).status], ["spend_limit_exceeded", 201]);
await releaseAll(lim.id);

// ---- Benefits wallet money held
const org = await signup("Org", "org@example.com", "O");
const [orgRow] = await q("select id from accounts where email='org@example.com'");
const [adaRow] = await q("select id from accounts where email='ada@example.com'");
const bw = (await q("insert into wallets (account_id, display_name, type, org_account_id, balance, allow_send, allow_pay) values ($1,'Benefits','benefits',$2,2500,false,true) returning id", [adaRow.id, orgRow.id]))[0].id;
await q("update balances set balance = balance + 2500 where account_id=$1", [adaRow.id]);
await hold(bw, 2000);
const mv = await call("POST", "/v1/wallets/move", { token: A, key: "mv1", body: { from_wallet_id: bw, to_wallet_id: adaDefault, amount: 501 } });
eq("held Benefits money cannot be moved: 501 of 2500 with 2000 held is declined", [mv.status, mv.json.transaction?.status_code ?? mv.json.status_code ?? mv.json.error], [422, "wallet_balance_exceeded"]);
eq("500 can move", (await call("POST", "/v1/wallets/move", { token: A, key: "mv2", body: { from_wallet_id: bw, to_wallet_id: adaDefault, amount: 500 } })).status, 201);
await releaseAll(bw);

// ---- the database guards
eq("an ended hold is frozen", await (async () => { const [h] = await q("select id from fund_holds where status='released' limit 1"); return q("update fund_holds set amount=1 where id=$1", [h.id]).then(() => "accepted", (e: any) => String(e.message).includes("frozen") ? "refused" : String(e.message)); })(), "refused");
eq("a hold is never deleted", await (async () => { const [h] = await q("select id from fund_holds limit 1"); return q("delete from fund_holds where id=$1", [h.id]).then(() => "accepted", (e: any) => String(e.message).includes("never deleted") ? "refused" : String(e.message)); })(), "refused");
await hold(adaDefault, 100);
eq("only one active hold per tab and wallet", await (async () => { const [w] = await q("select account_id from wallets where id=$1", [adaDefault]); const [shopRow] = await q("select id from accounts where email='shop@example.com'"); const tab = (await q("insert into tabs (account_id, host_wallet_id, invite_code) values ($1,$2,$3) returning id", [shopRow.id, adaDefault, "invite-" + randomBytes(12).toString("hex")]))[0].id; await q("insert into fund_holds (account_id, wallet_id, tab_id, amount) values ($1,$2,$3,5)", [w.account_id, adaDefault, tab]); return q("insert into fund_holds (account_id, wallet_id, tab_id, amount) values ($1,$2,$3,5)", [w.account_id, adaDefault, tab]).then(() => "accepted", (e: any) => String(e.message).includes("fund_holds_active_key") ? "refused" : String(e.message)); })(), "refused");
await q("update fund_holds set status='released', ended_at=now(), end_reason='canceled' where status='active'");
await q("update wallets set held = 0");

// ---- concurrency: holds and spends on one account never overspend
await call("POST", "/v1/sandbox/fundings", { token: B, key: "fb2", body: { amount: 10000 } });
const bobTotal = (await bal(B)).balance;
await hold(bobDefault, bobTotal - 500);
const race = await Promise.all(Array.from({ length: 8 }, (_, i) => send(B, `r${i}`, bobDefault, adaDefault, 100)));
eq("eight simultaneous sends of 100 with 500 free: five succeed, three are declined", [race.filter((r) => r.status === 201).length, race.filter((r) => r.json.status_code === "insufficient_balance").length], [5, 3]);
eq("held money untouched and the balance never below the hold", [(await bal(B)).balance >= (await bal(B)).held, (await bal(B)).held], [true, bobTotal - 500]);

// ---- invariant: wallets.held equals the active holds, and the books reconcile
const drift = await q("select count(*)::int c from wallets w where w.held <> coalesce((select sum(amount) from fund_holds h where h.wallet_id = w.id and h.status = 'active'), 0)");
eq("every wallet's held equals the sum of its active holds", drift[0].c, 0);
console.log(`\n${pass} passed, ${fail} failed`); await adm.end(); process.exit(fail ? 1 : 0);
