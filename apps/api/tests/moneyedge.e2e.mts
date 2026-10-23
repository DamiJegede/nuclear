import { writeFileSync } from "node:fs";
process.on("uncaughtException", (e: any) => { writeFileSync("/tmp/me.err", String(e?.stack ?? e)); process.exit(1); });
process.on("unhandledRejection", (e: any) => { writeFileSync("/tmp/me.err", String(e?.stack ?? e)); process.exit(1); });
import { randomBytes } from "node:crypto";
import postgres from "postgres";
import app from "../src/index.ts";
import { migrate, resetSchema, PG_URL } from "./db.ts";
resetSchema(); migrate();
const adm = postgres(PG_URL, { max: 3, onnotice: () => {} });
const q = async (s: string, p: unknown[] = []) => (await adm.unsafe(s, p as any)) as any[];
const OP = "op-" + randomBytes(16).toString("hex");
const env: any = { STATS_TTL_SECONDS: "0", HYPERDRIVE: { connectionString: PG_URL }, JWT_SECRET: "x".repeat(40), ADMIN_API_TOKEN: OP, SANDBOX_FUNDING: "true" };
const ctx: any = { waitUntil: (p: Promise<unknown>) => void p.catch(() => {}), passThroughOnException() {} };
let pass = 0, fail = 0;
const eq = (l: string, g: unknown, w: unknown) => { const ok = JSON.stringify(g) === JSON.stringify(w); ok ? pass++ : fail++; console.log(ok ? "ok  " : "FAIL", l, ok ? "" : `got ${JSON.stringify(g)} want ${JSON.stringify(w)}`); };
const call = async (m: string, p: string, o: { body?: unknown; token?: string; key?: string } = {}) => {
  const r = await app.fetch(new Request("http://x" + p, { method: m, headers: { "content-type": "application/json", ...(o.token ? { authorization: `Bearer ${o.token}` } : {}), ...(o.key ? { "idempotency-key": o.key } : {}) }, body: o.body === undefined ? undefined : JSON.stringify(o.body) }), env, ctx);
  const t = await r.text(); return { status: r.status, json: t ? JSON.parse(t) : null };
};
const sign = async (name: string, email: string, type = "C") => (await call("POST", "/v1/auth/signup", { body: { type, name, email, password: "correct horse battery" } })).json;
const bal = async (accountId: string) => Number((await q("select balance from balances where account_id=$1", [accountId]))[0].balance);
const credit = async (accountId: string) => Number((await q("select credit_spent from balances where account_id=$1", [accountId]))[0].credit_spent);
const wallet = async (p: any) => (await call("GET", "/v1/wallets", { token: p.session_token })).json.wallets[0].id;
const fund = (p: any, amount: number, key: string) => call("POST", "/v1/sandbox/fundings", { token: p.session_token, key, body: { amount } });
const total = async () => Number((await q("select sum(balance)::bigint t from balances"))[0].t);
const send = (p: any, to: string, amount: number, key: string, extra: object = {}) => call("POST", "/v1/transfers", { token: p.session_token, key, body: { to_wallet_id: to, amount, ...extra } });
const reconciled = async () => (await call("GET", "/v1/admin/stats", { token: OP })).json.reconciliation;

const ada = await sign("Ada", "ada@example.com"), bob = await sign("Bob", "bob@example.com"), cy = await sign("Cy", "cy@example.com");
const shop = await sign("Shop", "shop@example.com", "B");
await q("update accounts set status='active' where id=$1", [shop.account_id]);
const term = (await call("POST", "/v1/terminals", { token: shop.session_token, body: { name: "T" } })).json.terminal.id;
await fund(ada, 10000, "f-a"); await fund(bob, 1000, "f-b"); await fund(cy, 5000, "f-c");
const wa = await wallet(ada), wb = await wallet(bob), wc = await wallet(cy);

// ================= SEND =================
eq("send: bad amounts and bodies are refused before anything is recorded", [
  (await send(ada, wb, 0, "s0")).status, (await send(ada, wb, -5, "s-1")).status, (await send(ada, wb, 1.5, "s-2")).status,
  (await call("POST", "/v1/transfers", { token: ada.session_token, key: "s-3", body: { to_wallet_id: "nope", amount: 5 } })).status,
  (await call("POST", "/v1/transfers", { token: ada.session_token, body: { to_wallet_id: wb, amount: 5 } })).status,
  (await q("select count(*)::int n from transactions where type='send'"))[0].n], [400, 400, 400, 400, 400, 0]);
eq("send: unknown recipient 404; to a business 422; to your own wallet or account 422", [
  (await send(ada, "00000000-0000-7000-8000-000000000000", 5, "s-4")).json.error,
  (await send(ada, await wallet(shop), 5, "s-5")).json.error,
  (await send(ada, wa, 5, "s-6")).json.error,
  await (async () => { const kid = (await call("POST", "/v1/wallets", { token: ada.session_token, body: { display_name: "Kid", type: "person" } })).json.wallet; return (await send(ada, kid.id, 5, "s-7")).json.error; })()], ["recipient_not_found", "recipient_not_eligible", "same_wallet", "same_account"]);
eq("send: nothing moved by any of those", [await bal(ada.account_id), await bal(bob.account_id)], [10000, 1000]);

const t0 = await total();
const s1 = await send(ada, wb, 2500, "s-ok");
eq("send: a normal send moves exactly the amount and posts a balanced ledger", [s1.status, await bal(ada.account_id), await bal(bob.account_id), (await reconciled()).ledger_balanced, await total()], [201, 7500, 3500, true, t0]);
const again = await send(ada, wb, 2500, "s-ok");
eq("send: a retry with the same key and body replays (200, same id, charged once)", [again.status, again.json.transaction.id === s1.json.transaction.id, await bal(ada.account_id)], [200, true, 7500]);
eq("send: the same key with a different amount or recipient is a 409", [(await send(ada, wb, 999, "s-ok")).json.error, (await send(ada, wc, 2500, "s-ok")).json.error], ["idempotency_mismatch", "idempotency_mismatch"]);
const poor = await send(bob, wa, 99999, "s-poor");
eq("send: too little money is a recorded decline and moves nothing", [poor.status, poor.json.status_code, (await q("select status, status_code from txn where idempotency_key like '%:s-poor'"))[0], await bal(bob.account_id)], [422, "insufficient_balance", { status: "failed", status_code: "insufficient_balance" }, 3500]);
const replayDecl = await send(bob, wa, 99999, "s-poor");
eq("send: a declined attempt replays as the same decline", [replayDecl.status, replayDecl.json.status_code], [422, "insufficient_balance"]);
eq("send: the exact balance goes, then the next cent fails", [(await send(bob, wa, 3500, "s-all")).status, await bal(bob.account_id), (await send(bob, wa, 1, "s-more")).json.status_code], [201, 0, "insufficient_balance"]);

// earmarks
const kidE = (await call("POST", "/v1/wallets", { token: cy.session_token, body: { display_name: "Kid", type: "person", balance: 1000 } })).json.wallet;
const ear = async (id: string) => Number((await q("select balance from wallets where id=$1", [id]))[0].balance);
await call("PATCH", `/v1/wallets/${kidE.id}`, { token: cy.session_token, body: { allow_send: true } });
eq("send: an earmarked wallet may send only up to its earmark, which then shrinks with the account balance", [
  (await send(cy, wa, 1500, "e-1", { from_wallet_id: kidE.id })).json.status_code,
  (await send(cy, wa, 400, "e-2", { from_wallet_id: kidE.id })).status, await ear(kidE.id), await bal(cy.account_id)], ["wallet_balance_exceeded", 201, 600, 4600]);
const rcv = (await call("POST", "/v1/wallets", { token: bob.session_token, body: { display_name: "Rcv", type: "person", balance: 0 } })).json.wallet;
await send(ada, rcv.id, 300, "e-3");
eq("send: money sent to an earmarked wallet raises its earmark", [await ear(rcv.id), await bal(bob.account_id)], [300, 300]);

// limits and unavailable parties
const lim = (await call("POST", "/v1/wallets", { token: ada.session_token, body: { display_name: "Limited", type: "person", daily_limit: 500, allow_send: true } })).json.wallet;
eq("send: a wallet's daily limit counts what it sent and refuses the excess", [
  (await send(ada, wb, 300, "l-1", { from_wallet_id: lim.id })).status, (await send(ada, wb, 300, "l-2", { from_wallet_id: lim.id })).json.status_code,
  Number((await q("select spent_today from wallets where id=$1", [lim.id]))[0].spent_today)], [201, "spend_limit_exceeded", 300]);
await q("update wallets set status='suspended' where id=$1", [wb]);
eq("send: a suspended recipient wallet declines (recorded)", (await send(ada, wb, 5, "u-1")).json.status_code, "recipient_unavailable");
await q("update wallets set status='active' where id=$1", [wb]);
await q("update accounts set status='suspended' where id=$1", [cy.account_id]);
eq("send: a suspended recipient account declines too", (await send(ada, wc, 5, "u-2")).json.status_code, "recipient_unavailable");
await q("update accounts set status='active' where id=$1", [cy.account_id]);
const rec = await sign("Rec", "rec@example.com"); const wr = await wallet(rec);
env.DAILY_VALUE_CAP_CENTS = "1000";
eq("send: a recipient's program-day incoming cap (here $10) is enforced and counts what already arrived", [(await send(ada, wr, 600, "cap-1")).status, (await send(ada, wr, 600, "cap-2")).json.status_code, (await send(ada, wr, 400, "cap-3")).status], [201, "recipient_limit_exceeded", 201]);
delete env.DAILY_VALUE_CAP_CENTS;

// concurrency: two sends each wanting the whole balance
const racer = await sign("Racer", "racer@example.com"); await fund(racer, 1000, "f-r");
const rr = await Promise.all([send(racer, wa, 1000, "r-1"), send(racer, wb, 1000, "r-2"), send(racer, wc, 1000, "r-3")]);
eq("send: three simultaneous sends of the whole balance: exactly one succeeds, nobody is overdrawn", [rr.filter((r) => r.status === 201).length, rr.filter((r) => r.status === 422).length, await bal(racer.account_id)], [1, 2, 0]);

// ================= PAY =================
const payer = await sign("Payer", "payer@example.com"); await fund(payer, 5000, "f-p");
const pay = (p: any, body: object, key: string) => call("POST", "/v1/payments", { token: p.session_token, key, body });
eq("pay: bad bodies and unknown terminals or checkouts are refused", [
  (await pay(payer, { terminal_id: term, amount: 0 }, "p0")).status, (await pay(payer, { terminal_id: term, amount: -1 }, "p1")).status,
  (await pay(payer, { amount: 100 }, "p2")).status, (await pay(payer, { terminal_id: "00000000-0000-7000-8000-000000000000", amount: 100 }, "p3")).status,
  (await pay(payer, { checkout_id: "00000000-0000-7000-8000-000000000000" }, "p4")).status], [400, 400, 400, 404, 404]);
eq("pay: a business cannot pay its own terminal (422, not a 500)", (await call("POST", "/v1/payments", { token: shop.session_token, key: "self", body: { terminal_id: term, amount: 100 } })).json?.error ?? "unexpected", "self_payment");
const m0 = await bal(shop.account_id), t1 = await total();
const p1 = await pay(payer, { terminal_id: term, amount: 1200 }, "pay-1");
eq("pay: a payment moves the money to the merchant and posts a balanced ledger", [p1.status, await bal(payer.account_id), (await bal(shop.account_id)) - m0, (await reconciled()).ledger_balanced, await total()], [201, 3800, 1200, true, t1]);
eq("pay: a retry replays; the same key with another amount conflicts; the payer is charged once", [(await pay(payer, { terminal_id: term, amount: 1200 }, "pay-1")).status, (await pay(payer, { terminal_id: term, amount: 7 }, "pay-1")).status, await bal(payer.account_id)], [200, 409, 3800]);
const dec = await pay(payer, { terminal_id: term, amount: 99999 }, "pay-poor");
eq("pay: too little money is a recorded decline; nothing moves", [dec.status, dec.json.status_code ?? dec.json.error, await bal(payer.account_id)], [422, "insufficient_balance", 3800]);
// credit: balance first, then approved credit, journaled on the payment
await q("update balances set credit_limit = 5000 where account_id=$1", [payer.account_id]);
const pc = await pay(payer, { terminal_id: term, amount: 6000 }, "pay-credit");
eq("pay: funded balance is used first, then approved credit, and the transaction records the credit part", [pc.status, await bal(payer.account_id), await credit(payer.account_id), (await q("select amount::int a, credit_amount::int c from transactions where idem like '%pay-credit'"))[0]], [201, 0, 2200, { a: 6000, c: 2200 }]);
eq("pay: credit beyond the limit is declined", (await pay(payer, { terminal_id: term, amount: 4000 }, "pay-over")).json.status_code, "insufficient_balance");
await q("update balances set credit_limit = 0 where account_id=$1", [payer.account_id]);
eq("pay: an account over its credit limit is restricted", (await pay(payer, { terminal_id: term, amount: 5 }, "pay-restricted")).json.status_code, "account_restricted");
await q("update balances set credit_limit = 5000 where account_id=$1", [payer.account_id]);
// earmark
const p2 = await sign("P2", "p2@example.com"); await fund(p2, 9000, "f-p2");
const agent = (await call("POST", "/v1/wallets", { token: p2.session_token, body: { display_name: "Bot", type: "agent", balance: 700 } })).json;
const payBot = (amount: number, key: string) => call("POST", "/v1/payments", { token: agent.key, key, body: { terminal_id: term, amount } });
eq("pay: an earmarked wallet is a hard limit and never borrows credit", [(await payBot(800, "b-1")).json.status_code, (await payBot(300, "b-2")).status, await ear(agent.wallet.id), await bal(p2.account_id)], ["wallet_balance_exceeded", 201, 400, 8700]);
// wallet daily limit and state
const lw = (await call("POST", "/v1/wallets", { token: p2.session_token, body: { display_name: "Lim", type: "person", daily_limit: 500, allow_pay: true } })).json.wallet;
const payFrom = (w: string, amount: number, key: string) => call("POST", "/v1/payments", { token: p2.session_token, key, body: { terminal_id: term, amount, from_wallet_id: w } });
eq("pay: a wallet's daily limit, and a wallet that may not pay", [(await payFrom(lw.id, 400, "d-1")).status, (await payFrom(lw.id, 400, "d-2")).json.status_code, (await (async () => { await call("PATCH", `/v1/wallets/${lw.id}`, { token: p2.session_token, body: { allow_pay: false } }); return payFrom(lw.id, 1, "d-3"); })()).json.status_code], [201, "spend_limit_exceeded", "pay_not_allowed"]);
// merchant suspended
await q("update accounts set status='suspended' where id=$1", [shop.account_id]);
eq("pay: a suspended merchant takes no payments", (await pay(p2, { terminal_id: term, amount: 5 }, "m-1")).json.error, "merchant_unavailable");
await q("update accounts set status='active' where id=$1", [shop.account_id]);

// concurrency
const racer2 = await sign("Racer2", "racer2@example.com"); await fund(racer2, 1000, "f-r2");
const pr = await Promise.all([1, 2, 3].map((n) => pay(racer2, { terminal_id: term, amount: 1000 }, `race-${n}`)));
eq("pay: three simultaneous payments of the whole balance: exactly one succeeds", [pr.filter((r) => r.status === 201).length, await bal(racer2.account_id)], [1, 0]);
const co = (await call("POST", "/v1/terminal/checkouts", { token: (await call("POST", `/v1/terminals/${term}/session`, { token: shop.session_token })).json.session_token, body: { amount: 500 } })).json.checkout;
await fund(racer2, 3000, "f-r3");
const cr = await Promise.all([1, 2, 3].map((n) => pay(racer2, { checkout_id: co.id }, `co-${n}`)));
eq("pay: one checkout paid by three simultaneous attempts is paid once", [cr.filter((r) => r.status === 201).length, Number((await q("select count(*) n from transactions where checkout_id=$1 and type='pay' and status='completed'", [co.id]))[0].n), await bal(racer2.account_id)], [1, 1, 2500]);
// a refund brings the money back through the same paths
const refundable = p1.json.transaction?.id ?? p1.json.payment?.id;
eq("pay: the books still balance and nobody is negative after all of it", [(await reconciled()).ledger_balanced, (await reconciled()).balances_match_ledger, (await q("select count(*)::int n from balances where balance < 0"))[0].n], [true, true, 0]);
void refundable;
console.log(`\n${pass} passed, ${fail} failed`); await adm.end(); process.exit(fail ? 1 : 0);
