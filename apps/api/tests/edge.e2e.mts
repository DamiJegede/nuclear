import { ROOT, applyMigration, migrate, psql, resetSchema } from "./db.ts";
import { execFileSync } from "node:child_process";
import { randomBytes, createCipheriv } from "node:crypto";
import { readFileSync } from "node:fs";
import postgres from "postgres";
import app from "../src/index.ts";
import { resetDailyCounters } from "../src/lib/ledger.ts";
import { connect } from "../src/db.ts";
psql(["-c", "drop schema public cascade; create schema public;"]);
migrate();
const adm = postgres("postgres://postgres@127.0.0.1:54340/nuclear", { max: 6, onnotice: () => {} });
const q = async (s: string, p: unknown[] = []) => (await adm.unsafe(s, p as any)) as any[];
const vars: Record<string, string> = { ADMIN_API_TOKEN: "op-" + randomBytes(16).toString("hex"), TAG_KEY_V1: randomBytes(16).toString("hex") };   // test secrets, never real ones
const OP = vars.ADMIN_API_TOKEN!;
const env: any = { HYPERDRIVE: { connectionString: "postgres://postgres@127.0.0.1:54340/nuclear" }, JWT_SECRET: "x".repeat(40), ADMIN_API_TOKEN: OP, TAG_KEY_V1: vars.TAG_KEY_V1, SANDBOX_FUNDING: "true", DAILY_VALUE_CAP_CENTS: "50000000" };
const ctx: any = { waitUntil: (p: Promise<unknown>) => void p.catch(() => {}), passThroughOnException() {} };
let pass = 0, fail = 0;
const eq = (l: string, g: unknown, w: unknown) => { const ok = JSON.stringify(g) === JSON.stringify(w); ok ? pass++ : fail++; console.log(ok ? "ok  " : "FAIL", l, ok ? "" : `got ${JSON.stringify(g)} want ${JSON.stringify(w)}`); };
const call = async (method: string, path: string, o: { body?: unknown; token?: string; key?: string } = {}) => {
  const r = await app.fetch(new Request("http://x" + path, { method, headers: { "content-type": "application/json", ...(o.token ? { authorization: `Bearer ${o.token}` } : {}), ...(o.key ? { "idempotency-key": o.key } : {}) }, body: o.body === undefined ? undefined : JSON.stringify(o.body) }), env, ctx);
  const t = await r.text(); return { status: r.status, json: t ? JSON.parse(t) : null };
};
const signup = async (name: string, email: string, type = "C") => { const j = (await call("POST", "/v1/auth/signup", { body: { name, email, password: "correct horse battery", type } })).json; if (type === "B") await q("update accounts set status='active' where id=$1", [j.account_id]); return j; }; // businesses start pending; these suites need them live
const tagKey = Buffer.from(vars.TAG_KEY_V1!, "hex");
const urlFor = (uid: string, counter: number) => { const pt = Buffer.alloc(16, 0x55); pt[0] = 0xc7; Buffer.from(uid, "hex").copy(pt, 1); pt.writeUIntLE(counter, 8, 3); const c = createCipheriv("aes-128-cbc", tagKey, Buffer.alloc(16)); c.setAutoPadding(false); return `https://tag.nclr.app/v1/${Buffer.concat([c.update(pt), c.final()]).toString("hex")}`; };

const ada = await signup("Ada", "ada@example.com"), bob = await signup("Bob", "bob@example.com"), shop = await signup("Shop", "shop@example.com", "B"), shop2 = await signup("Other Shop", "shop2@example.com", "B");
const A = ada.session_token, B = bob.session_token, S = shop.session_token, S2 = shop2.session_token;
const fund = (t: string, k: string, amount: number) => call("POST", "/v1/sandbox/fundings", { token: t, key: k, body: { amount } });
await fund(A, "f1", 100000); await fund(B, "fb", 10000);
const bal = async (t: string) => (await call("GET", "/v1/balance", { token: t })).json;
const wallets = async (t: string) => (await call("GET", "/v1/wallets", { token: t })).json.wallets;
const adaDefault = ada.default_wallet_id, bobDefault = bob.default_wallet_id;
const mkAgent = async (name: string, balance: number | null, extra: object = {}) => (await call("POST", "/v1/wallets", { token: A, body: { display_name: name, type: "agent", allow_send: true, balance, ...extra } })).json;
const mkPerson = async (name: string, extra: object = {}) => (await call("POST", "/v1/wallets", { token: A, body: { display_name: name, type: "person", allow_send: true, ...extra } })).json.wallet;
const link = async (walletId: string) => (await call("POST", "/v1/devices/redeem", { body: { token: (await call("POST", `/v1/wallets/${walletId}/links`, { token: A })).json.url.split("/magic-link/")[1] } })).json.session_token as string;
const send = (token: string, key: string, from: string | undefined, to: string, amount: number) => call("POST", "/v1/transfers", { token, key, body: { ...(from ? { from_wallet_id: from } : {}), to_wallet_id: to, amount } });
const term = (token: string, name: string, extra: object = {}) => call("POST", "/v1/terminals", { token, body: { name, ...extra } }).then((r) => ({ id: r.json.terminal.id as string, jwt: r.json.session_token as string }));
const T1 = await term(S, "Counter"), T1x = await term(S, "Approval counter", { allow_refunds: false }), T2 = await term(S2, "Other counter");
const pay = (token: string, key: string, terminal: string, amount: number, extra: object = {}) => call("POST", "/v1/payments", { token, key, body: { amount, terminal_id: terminal, ...extra } });

// ======== 1. wallet attempts: using wallets you do not own or are not allowed to use =================
const agentRes = await mkAgent("Agent One", 5000); const agent = agentRes.wallet, AK = agentRes.key as string;
const kid = await mkPerson("Kid"); const KID = await link(kid.id);
const agent2Res = await mkAgent("Agent Two", 3000); const agent2 = agent2Res.wallet, AK2 = agent2Res.key as string;
eq("an agent key cannot spend from another wallet of its owner (from_wallet_id is checked)", [(await send(AK, "w1", adaDefault, bobDefault, 100)).status, (await send(AK, "w2", agent2.id, bobDefault, 100)).status, (await send(AK, "w3", kid.id, bobDefault, 100)).status], [404, 404, 404]);
eq("a delegated person-wallet session cannot spend from the default or an agent wallet", [(await send(KID, "w4", adaDefault, bobDefault, 100)).status, (await send(KID, "w5", agent.id, bobDefault, 100)).status], [404, 404]);
eq("nobody can spend from someone else's wallet id", [(await send(B, "w6", adaDefault, bobDefault, 100)).status, (await send(B, "w7", agent.id, adaDefault, 100)).status, (await send(AK, "w8", bobDefault, adaDefault, 100)).status], [404, 404, 404]);
eq("a payment cannot name another account's wallet either", [(await pay(B, "wp1", T1.id, 100, { from_wallet_id: adaDefault })).status, (await pay(AK, "wp2", T1.id, 100, { from_wallet_id: adaDefault })).status, (await pay(KID, "wp3", T1.id, 100, { from_wallet_id: agent.id })).status], [404, 404, 404]);
eq("an agent key and a delegated session cannot read or touch other wallets or allocations", [(await call("GET", `/v1/wallets/${adaDefault}`, { token: AK })).status, (await call("GET", `/v1/wallets/${agent.id}/allocations`, { token: KID })).status, (await call("GET", `/v1/wallets/${agent2.id}`, { token: AK })).status], [404, 404, 404]);
eq("sending to yourself, a business, a missing wallet or with a bad amount fails cleanly", [(await send(AK, "s1", undefined, agent.id, 100)).json.error, (await send(AK, "s2", undefined, agent2.id, 100)).json.error, (await send(AK, "s3", undefined, (await wallets(S))[0].id, 100)).json.error, (await send(AK, "s4", undefined, "00000000-0000-7000-8000-000000000000", 100)).json.error, (await send(AK, "s5", undefined, bobDefault, 0)).status, (await send(AK, "s6", undefined, bobDefault, -5)).status, (await send(AK, "s7", undefined, bobDefault, 1.5)).status], ["same_wallet", "same_account", "recipient_not_eligible", "recipient_not_found", 400, 400, 400]);
eq("an agent cannot send without allow_send, nor pay without allow_pay", await (async () => {
  const noSend = (await mkAgent("NoSend", 1000, { allow_send: false })).key as string, noPay = (await mkAgent("NoPay", 1000, { allow_pay: false })).key as string;
  return [(await send(noSend, "np1", undefined, bobDefault, 100)).json.status_code, (await pay(noPay, "np2", T1.id, 100)).json.status_code, (await pay(noSend, "np3", T1.id, 100)).status];
})(), ["send_not_allowed", "pay_not_allowed", 201]);

// ======== 2. funding sub-wallets (setting aside money) ===================================================
const free = async () => (await bal(A)).available_to_send;
const set = (token: string, id: string, balance: number | null) => call("PUT", `/v1/wallets/${id}/balance`, { token, body: { balance } });
const before = await free();
const exact = await set(A, agent2.id, 3000 + before);   // raise by exactly everything that is free
eq("raising an earmark by exactly the free funds works and leaves nothing free", [exact.status, await free()], [200, 0]);
eq("one cent more than is free is refused and changes nothing", [(await set(A, agent2.id, 3000 + before + 1)).json.error, (await wallets(A)).find((w: any) => w.id === agent2.id).balance], ["insufficient_shared_balance", 3000 + before]);
await set(A, agent2.id, 3000);
eq("setting 0 keeps it earmarked (nothing to spend); null releases it", [(await set(A, agent2.id, 0)).json.wallet.earmarked, (await send(AK2, "z1", undefined, bobDefault, 1)).json.status_code, (await set(A, agent2.id, null)).json.wallet.earmarked], [true, "wallet_balance_exceeded", false]);
await set(A, agent2.id, 3000);
eq("a load (sandbox funding) goes to the shared funds, not to any wallet", await (async () => { const w0 = (await wallets(A)).find((w: any) => w.id === agent.id).balance; const before_load = (await bal(A)).balance; await fund(A, "f-extra", 7000); return [(await wallets(A)).find((w: any) => w.id === agent.id).balance === w0, (await bal(A)).earmarked === (await q("select coalesce(sum(balance),0)::int s from wallets where account_id=$1", [ada.account_id]))[0].s, (await bal(A)).balance === before_load + 7000]; })(), [true, true, true]);
eq("two earmark raises that fit alone but not together: exactly one wins", await (async () => {
  const f = await free(); const w1 = await mkPerson("R1"), w2 = await mkPerson("R2");
  const rs = await Promise.all([set(A, w1.id, f - 100), set(A, w2.id, f - 100)]);
  const e = (await bal(A)).earmarked; return [rs.filter((r) => r.status === 200).length, rs.filter((r) => r.json.error === "insufficient_shared_balance").length, e <= (await bal(A)).balance];
})(), [1, 1, true]);
eq("an earmark raise racing a spend from the shared funds never over-commits", await (async () => {
  await q("update wallets set balance = null where account_id=$1 and type='person'", [ada.account_id]);   // release the racing wallets
  const f = await free(); const w = await mkPerson("R3");
  const rs = await Promise.all([set(A, w.id, f), send(A, "race-s", adaDefault, bobDefault, f)]);   // both want everything that is free
  const b = await bal(A); return [rs.filter((r) => r.status === 200 || r.status === 201).length, b.earmarked <= b.balance, (await q("select count(*)::int n from wallets w join balances b on b.account_id=w.account_id where w.account_id=$1 group by b.balance having sum(w.balance) > b.balance", [ada.account_id])).length];
})(), [1, true, 0]);
await q("update wallets set balance = null where account_id=$1 and type='person'", [ada.account_id]);   // release the racing wallets
await fund(A, "fx-close", 100000);
eq("closing an earmarked wallet is logged and returns its money", await (async () => { const w = await mkPerson("Temp"); const f0 = await free(); await set(A, w.id, 0); const before = (await bal(A)).earmarked; const up = await set(A, w.id, Math.min(500, await free())); const closed = await call("PATCH", `/v1/wallets/${w.id}`, { token: A, body: { status: "closed" } }); return [up.status, closed.status, (await q("select balance from wallets where id=$1", [w.id]))[0].balance, (await bal(A)).earmarked === before, (await call("GET", `/v1/wallets/${w.id}/allocations`, { token: A })).json.allocations.length >= 2]; })(), [200, 200, null, true, true]);
await fund(A, "fx-closer", 100000);
eq("a closed wallet cannot be funded; its session and key stop working", await (async () => { const a = await mkAgent("Closer", 100); await call("PATCH", `/v1/wallets/${a.wallet.id}`, { token: A, body: { status: "closed" } }); return [(await set(A, a.wallet.id, 50)).status, (await call("GET", "/v1/balance", { token: a.key })).status]; })(), [409, 401]);

// ======== 3. payments and sends when the sub-wallet's funds run out ====================================
await set(A, agent.id, 1000);
eq("pay: within the wallet balance works and reduces it", [(await pay(AK, "p1", T1.id, 400)).status, (await wallets(A)).find((w: any) => w.id === agent.id).balance], [201, 600]);
eq("pay: over the wallet balance is declined even though the account has plenty and credit exists", await (async () => {
  await q("update balances set credit_limit = 50000 where account_id=$1", [ada.account_id]);
  const r = await pay(AK, "p2", T1.id, 601); return [r.status, r.json.status_code, (await q("select credit_spent::int c from balances where account_id=$1", [ada.account_id]))[0].c, (await wallets(A)).find((w: any) => w.id === agent.id).balance];
})(), [422, "wallet_balance_exceeded", 0, 600]);
eq("pay: a declined attempt replays as declined with the same key, a new key can succeed after the balance is raised", [(await pay(AK, "p2", T1.id, 601)).json.status_code, (await set(A, agent.id, 2000)).status, (await pay(AK, "p2b", T1.id, 601)).status], ["wallet_balance_exceeded", 200, 201]);
// a clean scenario for the credit/earmark interplay: fresh account
const dan = await signup("Dan", "dan@example.com"); const D = dan.session_token;
await fund(D, "fd", 5000);
const dAgent = (await call("POST", "/v1/wallets", { token: D, body: { display_name: "Dan's agent", type: "agent", balance: 3000 } })).json;
await q("update balances set credit_limit = 10000 where account_id=$1", [dan.account_id]);
const d1 = await pay(D, "dp1", T1.id, 2000);        // shared funds are 2000 (5000 - 3000 earmarked): exactly enough
const d2 = await pay(D, "dp2", T1.id, 500);         // shared exhausted: credit pays, earmarked money untouched
const db = await bal(D);
eq("pay: shared funds first, then credit; the earmarked 3000 is untouched", [d1.status, d2.status, (await q("select balance::int b, credit_spent::int c from balances where account_id=$1", [dan.account_id]))[0], (await call("GET", "/v1/wallets", { token: D })).json.wallets.find((w: any) => w.id === dAgent.wallet.id).balance], [201, 201, { b: 3000, c: 500 }, 3000]);
eq("pay: the earmarked wallet itself can still not use credit", [(await pay(dAgent.key, "dp3", T1.id, 3001)).json.status_code, (await pay(dAgent.key, "dp4", T1.id, 3000)).status, (await q("select balance::int b, credit_spent::int c from balances where account_id=$1", [dan.account_id]))[0]], ["wallet_balance_exceeded", 201, { b: 0, c: 500 }]);
eq("shop: an earmarked wallet's purchase over its balance is declined; an agent key cannot buy at all", await (async () => {
  const m = (await call("POST", "/v1/admin/tag-models", { token: OP, body: { type: "band", name: "B", price: 2000, quantity: 50, status: "available" } })).json.model;
  const ship = { name: "Ada", line1: "1 St", city: "C", region: "R", postal_code: "1", country: "us" };
  const over = await call("POST", "/v1/shop/orders", { token: A, key: "o1", body: { model_id: m.id, quantity: 1, wallet_id: agent.id, shipping: ship } });
  await set(A, agent.id, 100);
  const small = await call("POST", "/v1/shop/orders", { token: A, key: "o2", body: { model_id: m.id, quantity: 1, wallet_id: agent.id, shipping: ship } });
  await set(A, agent.id, 5000);
  const ok = await call("POST", "/v1/shop/orders", { token: A, key: "o3", body: { model_id: m.id, quantity: 1, wallet_id: agent.id, shipping: ship } });
  return [small.json.status_code, ok.status, (await wallets(A)).find((w: any) => w.id === agent.id).balance, (await call("POST", "/v1/shop/orders", { token: AK, key: "o4", body: { model_id: m.id, quantity: 1, shipping: ship } })).status];
})(), ["wallet_balance_exceeded", 201, 3000, 403]);

// ======== 4. person (sub-wallet) users spending ======================================================
const kid2 = await mkPerson("Kid2", { daily_limit: 1000 }); const K2 = await link(kid2.id);
eq("a person wallet shares the account funds and obeys its daily limit across sends and payments", [(await pay(K2, "k1", T1.id, 600)).status, (await send(K2, "k2", undefined, bobDefault, 400)).status, (await send(K2, "k3", undefined, bobDefault, 1)).json.status_code, (await pay(K2, "k4", T1.id, 1)).json.status_code, (await call("GET", "/v1/wallets", { token: K2 })).json.wallets[0].remaining_today], [201, 201, "spend_limit_exceeded", "spend_limit_exceeded", 0]);
eq("the midnight reset lets it spend again", await (async () => { const sql = connect(env); await resetDailyCounters(sql); await sql.end(); return [(await pay(K2, "k5", T1.id, 100)).status, (await call("GET", "/v1/wallets", { token: K2 })).json.wallets[0].spent_today]; })(), [201, 100]);
eq("a suspended or closed person wallet's session stops working immediately", await (async () => { await call("PATCH", `/v1/wallets/${kid2.id}`, { token: A, body: { status: "suspended" } }); const s1 = (await pay(K2, "k6", T1.id, 1)).status; await call("PATCH", `/v1/wallets/${kid2.id}`, { token: A, body: { status: "active" } }); return [s1, (await pay(K2, "k7", T1.id, 1)).status]; })(), [401, 201]);
eq("a suspended account blocks every wallet and key", await (async () => { await q("update accounts set status='suspended' where id=$1", [ada.account_id]); const r = [(await call("GET", "/v1/balance", { token: AK })).status, (await call("GET", "/v1/balance", { token: K2 })).status, (await call("GET", "/v1/balance", { token: A })).status]; await q("update accounts set status='active' where id=$1", [ada.account_id]); return r; })(), [401, 401, 401]);
eq("a person wallet with a limit of 0 cannot spend; lifting the limit restores spending", [(await call("PATCH", `/v1/wallets/${kid2.id}`, { token: A, body: { daily_limit: 0 } })).status, (await pay(K2, "k8", T1.id, 1)).json.status_code, (await call("PATCH", `/v1/wallets/${kid2.id}`, { token: A, body: { daily_limit: null } })).status, (await pay(K2, "k9", T1.id, 1)).status], [200, "spend_limit_exceeded", 200, 201]);
eq("the delegated session cannot change its own limits, balance, status or links", [(await call("PATCH", `/v1/wallets/${kid2.id}`, { token: K2, body: { daily_limit: null } })).status, (await set(K2, kid2.id, 100)).status, (await call("POST", `/v1/wallets/${kid2.id}/links`, { token: K2 })).status, (await call("POST", `/v1/wallets/${kid2.id}/key`, { token: K2 })).status], [403, 403, 403, 403]);

// ======== 5. tag taps from an earmarked wallet =========================================================
const tagUid = "04" + randomBytes(6).toString("hex").toUpperCase();
const model = (await call("POST", "/v1/admin/tag-models", { token: OP, body: { type: "band", name: "Tap band", price: 1000, quantity: 5, status: "available" } })).json.model;
await call("POST", `/v1/admin/tag-models/${model.id}/tags`, { token: OP, body: { uids: [tagUid] } });
await set(A, agent.id, 800);
const claim = await call("POST", "/v1/tags/claim", { token: A, body: { url: urlFor(tagUid, 1), wallet_id: agent.id } });
const tap = (n: number, amount: number, key: string, jwt = T1.jwt) => call("POST", "/v1/terminal/payments", { token: jwt, key, body: { amount, credential: { type: "tag", url: urlFor(tagUid, n) } } });
const t2 = await tap(2, 801, "tap-over"), t3 = await tap(3, 300, "tap-ok");
eq("tap: a band on an agent wallet spends only that wallet's balance; over it is declined and still burns the proof", [claim.status, t2.status, t2.json.payment?.status_code ?? t2.json.error, t3.status, (await wallets(A)).find((w: any) => w.id === agent.id).balance, (await tap(3, 1, "tap-replay")).json.error], [201, 422, "wallet_balance_exceeded", 201, 500, "proof_replayed"]);

// ======== 6. refunds without permission =================================================================
const paid = await pay(B, "rf-pay", T1.id, 2000); const payId = paid.json.payment.id;
const paidX = await pay(B, "rf-pay2", T1x.id, 1500); const payX = paidX.json.payment.id;
const refund = (token: string, key: string, body: object) => call("POST", "/v1/terminal/refunds", { token, key, body });
eq("refund: customers, agents, delegated sessions and the wrong merchant's terminal cannot create refunds", [(await refund(B, "r1", { payment_id: payId, mode: "full" })).status, (await refund(AK, "r2", { payment_id: payId, mode: "full" })).status, (await refund(KID, "r3", { payment_id: payId, mode: "full" })).status, (await refund(T2.jwt, "r4", { payment_id: payId, mode: "full" })).status, (await refund("", "r5", { payment_id: payId, mode: "full" })).status], [401, 401, 401, 404, 401]);
eq("refund: bad bodies (both ids, neither, partial without amount, over the payment) are refused", [(await refund(T1.jwt, "r6", { payment_id: payId, attempt: "x", mode: "full" })).status, (await refund(T1.jwt, "r7", { mode: "full" })).status, (await refund(T1.jwt, "r8", { payment_id: payId, mode: "partial" })).status, (await refund(T1.jwt, "r9", { payment_id: payId, mode: "partial", amount: 2001 })).status, (await refund(T1.jwt, "r10", { payment_id: "00000000-0000-7000-8000-000000000000", mode: "full" })).status], [400, 400, 400, 422, 404]);
const pend = await refund(T1x.jwt, "r11", { payment_id: payX, mode: "full" });
eq("refund: an approval-required terminal with no tap only records a pending request; nothing moves", [pend.status, pend.json.refund.status_code, (await q("select count(*)::int n from transactions where type='refund' and status='completed'"))[0].n], [202, "awaiting_approval", 0]);
const pendId = pend.json.refund.id;
eq("refund: nobody but the merchant owner (or write staff by tap) can approve: customer, agent, delegated, other merchant", [(await call("POST", `/v1/refunds/${pendId}/approve`, { token: B })).status, (await call("POST", `/v1/refunds/${pendId}/approve`, { token: AK })).status, (await call("POST", `/v1/refunds/${pendId}/approve`, { token: KID })).status, (await call("POST", `/v1/refunds/${pendId}/approve`, { token: S2 })).status], [403, 403, 403, 404]);
const bobBefore = (await bal(B)).balance;
const ap = await call("POST", `/v1/refunds/${pendId}/approve`, { token: S }), ap2 = await call("POST", `/v1/refunds/${pendId}/approve`, { token: S });
eq("refund: the merchant owner approves; approving again changes nothing; the customer is paid once", [ap.status, ap2.status, (await bal(B)).balance - bobBefore], [201, 200, 1500]);
eq("refund: a refund of a refunded payment is refused, partial refunds add up and never exceed the payment", [(await refund(T1.jwt, "r12", { payment_id: payId, mode: "partial", amount: 1200 })).status, (await refund(T1.jwt, "r13", { payment_id: payId, mode: "partial", amount: 801 })).status, (await refund(T1.jwt, "r14", { payment_id: payId, mode: "partial", amount: 800 })).status, (await refund(T1.jwt, "r15", { payment_id: payId, mode: "full" })).json.error], [201, 422, 201, "already_refunded"]);
eq("refund: a payment made from an earmarked wallet refunds into that wallet", await (async () => { await set(A, agent.id, 1000); const p = await pay(AK, "ra1", T1.id, 700); const b0 = (await wallets(A)).find((w: any) => w.id === agent.id).balance; await refund(T1.jwt, "ra2", { payment_id: p.json.payment.id, mode: "full" }); return [p.status, b0, (await wallets(A)).find((w: any) => w.id === agent.id).balance]; })(), [201, 300, 1000]);
eq("refund: if the wallet was released to shared funds before the refund, the money goes to the account, not the wallet", await (async () => { await set(A, agent.id, 1000); const p = await pay(AK, "rb1", T1.id, 700); await set(A, agent.id, null); const b0 = (await bal(A)).balance; await refund(T1.jwt, "rb2", { payment_id: p.json.payment.id, mode: "full" }); return [(await bal(A)).balance - b0, (await wallets(A)).find((w: any) => w.id === agent.id).balance]; })(), [700, null]);
eq("refund: payments from a closed wallet's key still refund to the account (the wallet is gone)", await (async () => { const a = await mkAgent("Short-lived", 500); const p = await pay(a.key, "rc1", T1.id, 200); await call("PATCH", `/v1/wallets/${a.wallet.id}`, { token: A, body: { status: "closed" } }); const b0 = (await bal(A)).balance; const r = await refund(T1.jwt, "rc2", { payment_id: p.json.payment.id, mode: "full" }); return [r.status, (await bal(A)).balance - b0]; })(), [201, 200]);

// ======== 7. the books after all of that ======================================================================
const stats = (await call("GET", "/v1/admin/stats", { token: OP })).json;
eq("after every scenario the books reconcile and no wallet is over-earmarked", stats.reconciliation, { balances_match_ledger: true, balance_difference: 0, credit_matches_ledger: true, credit_difference: 0, ledger_balanced: true, earmarks_within_balances: true, escrow_matches_employees: true, benefits_match_ledger: true, daily_caps_match_ledger: true });
eq("no wallet or account balance is negative anywhere, no earmark exceeds its account", [(await q("select count(*)::int n from wallets where balance < 0"))[0].n, (await q("select count(*)::int n from (select w.account_id from wallets w join balances b on b.account_id=w.account_id where w.balance is not null group by w.account_id, b.balance having sum(w.balance) > b.balance) x"))[0].n], [0, 0]);
console.log(`\n${pass} passed, ${fail} failed`); await adm.end(); process.exit(fail ? 1 : 0);
