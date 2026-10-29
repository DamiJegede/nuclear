import { createHmac, randomBytes, randomUUID } from "node:crypto";
import postgres from "postgres";
import app from "../src/index.ts";
import { connect } from "../src/db.ts";
import { crbClient, CrbError } from "../src/lib/crb.ts";
import { addDays, easternDate } from "../src/lib/dates.ts";
import { runSettlement } from "../src/lib/settlement.ts";
import { migrate, resetSchema, PG_URL } from "./db.ts";
resetSchema(); migrate();
const adm = postgres(PG_URL, { max: 3, onnotice: () => {} });
const q = async (s: string, p: unknown[] = []) => (await adm.unsafe(s, p as any)) as any[];

// ---- a stand-in for the bank (behind the proxy): the token server, the directory, ACH and instant payments
type Pay = { id: string; kind: "ach" | "rtp"; body: any; idem: string | null; status: string; postingCode?: string; original?: string; returnCode?: string };
const bank = {
  tokens: 0, expireNext: false, down: false, createStatus: 0, createDefinitive: 0, lastLost: false, pays: new Map<string, Pay>(), calls: [] as string[], proxyKeys: new Set<string>(),
  directory: { "021000021": [{ routingNumber: "021000021", institutionName: "JPMorgan Chase", name: "JPMorgan Chase", receiveServices: ["CRDT"], networkPlatform: "TCH" }, { routingNumber: "021000021", name: "JPMORGAN CHASE BANK, NA", receiveServices: ["CTSR"], networkPlatform: "FedNow" }] } as Record<string, any[]>,
};
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
const fakeFetch: typeof fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : (input as Request).url);
  const h = new Headers(init?.headers);
  bank.proxyKeys.add(h.get("x-nuclear-proxy-key") ?? "");
  if (url.pathname === "/idp/connect/token") {
    bank.tokens++;
    return json({ access_token: `tok-${bank.tokens}`, expires_in: 3600, token_type: "Bearer" });
  }
  const path = url.pathname.replace(/^\/sandbox/, "");
  bank.calls.push(`${init?.method ?? "GET"} ${path}`);
  if (bank.down) return json({ errors: [{ code: 5000, message: "down" }] }, 503);
  if (bank.expireNext) { bank.expireNext = false; return json({ errors: [] }, 401); }
  if (h.get("authorization") !== `Bearer tok-${bank.tokens}`) return json({ errors: [] }, 401);
  if (path === "/rtp/v1/directory") return json({ results: bank.directory[url.searchParams.get("filter.routingNumber") ?? ""] ?? [] });
  const m = path.match(/^\/(ach|rtp)\/v1\/payments(?:\/([^/]+))?$/);
  if (!m) return json({ errors: [{ code: 2000, message: "Resource not found" }] }, 404);
  const kind = m[1] as "ach" | "rtp";
  if (init?.method === "POST") {
    const body = JSON.parse(String(init.body));
    if (bank.createDefinitive && kind === "rtp") return json({ errors: [{ code: bank.createDefinitive, message: "not valid" }] }, 400);
    const dupe = [...bank.pays.values()].find((p) => p.idem === h.get("idempotency-key") && p.kind === kind);
    const p: Pay = dupe ?? { id: randomUUID(), kind, body, idem: h.get("idempotency-key"), status: kind === "ach" ? "Pending" : "Created" };
    bank.pays.set(p.id, p);
    if (bank.createStatus) { bank.createStatus = 0; bank.lastLost = true; return json({ errors: [{ code: 5000, message: "boom" }] }, 500); }   // created, but the answer is lost
    return json({ id: p.id, status: p.status });
  }
  if (m[2]) {
    const p = bank.pays.get(m[2]);
    return p ? json({ id: p.id, status: p.status, postingCode: p.postingCode, original: p.original ? { paymentId: p.original } : undefined, returnCode: p.returnCode }) : json({ errors: [{ code: 2004, message: "not found" }] }, 404);
  }
  const cid = url.searchParams.get("filter.clientIdentifier");
  return json({ results: [...bank.pays.values()].filter((p) => p.kind === kind && p.body.clientIdentifier === cid).map((p) => ({ id: p.id, status: p.status })) });
};

const WH = randomBytes(24).toString("base64");   // the bank's webhook secret is base64; the HMAC key is its decoded bytes
const OP = "op-" + randomBytes(16).toString("hex");
const env: any = {
  STATS_TTL_SECONDS: "0", HYPERDRIVE: { connectionString: PG_URL }, JWT_SECRET: "x".repeat(40), ADMIN_API_TOKEN: OP, SANDBOX_FUNDING: "true", BANK_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
  BANK_PROXY_URL: "http://bank.test", BANK_PROXY_KEY: "proxy-key-1", CR_CLIENT_ID: "cid", CR_CLIENT_SEC: "csec", CR_WH_SEC: WH, CR_ACCOUNT: "109722829461", CR_PAYOUTS: "true", CRB_FETCH: fakeFetch,
};
const ctx: any = { waitUntil: (p: Promise<unknown>) => void p.catch(() => {}), passThroughOnException() {} };
let pass = 0, fail = 0;
const eq = (l: string, g: unknown, w: unknown) => { const ok = JSON.stringify(g) === JSON.stringify(w); ok ? pass++ : fail++; console.log(ok ? "ok  " : "FAIL", l, ok ? "" : `got ${JSON.stringify(g)} want ${JSON.stringify(w)}`); };
const call = async (m: string, p: string, o: { body?: unknown; token?: string; key?: string } = {}) => {
  const r = await app.fetch(new Request("http://x" + p, { method: m, headers: { "content-type": "application/json", ...(o.token ? { authorization: `Bearer ${o.token}` } : {}), ...(o.key ? { "idempotency-key": o.key } : {}) }, body: o.body === undefined ? undefined : JSON.stringify(o.body) }), env, ctx);
  const t = await r.text(); return { status: r.status, json: t ? JSON.parse(t) : null };
};
const sign = async (name: string, email: string, type = "C") => (await call("POST", "/v1/auth/signup", { body: { type, name, email, password: "correct horse battery" } })).json;
const sql = connect(env);
const today = easternDate(new Date());

async function merchant(name: string, email: string, routing: string, account = "0001234567") {
  const m = await sign(name, email, "B");
  await q("update accounts set status='active' where id=$1", [m.account_id]);
  await call("PUT", "/v1/business/profile", { token: m.session_token, body: { legal_name: name + " LLC", display_name: name } });
  const b = await call("PUT", "/v1/business/bank", { token: m.session_token, body: { routing_number: routing, account_number: account } });
  const term = (await call("POST", "/v1/terminals", { token: m.session_token, body: { name: "Counter" } })).json;
  return { ...m, term: term.terminal.id, bank: b.json };
}
const payer = await sign("Payer", "payer@x.test");
await call("POST", "/v1/sandbox/fundings", { token: payer.session_token, key: "f1", body: { amount: 190000 } });
let n = 0;
const sale = async (m: any, amount: number) => (await call("POST", "/v1/payments", { token: payer.session_token, key: `sale-${n++}`, body: { amount, terminal_id: m.term } })).json.payment;
const bal = async (m: any) => Number((await q("select balance from balances where account_id=$1", [m.account_id]))[0].balance);
const closeOut = (m: any) => call("POST", "/v1/business/close-out", { token: m.session_token });
const rows = (m: any) => q("select status, rail, direction, amount::int amount, provider_reference ref, failure_code code from settlements where merchant_account_id=$1 order by created_at", [m.account_id]);
const recon = async () => (await call("GET", "/v1/admin/stats", { token: OP })).json.reconciliation;
const sig = (body: string, secret = WH, t = Math.floor(Date.now() / 1000), asBase64Key = true) =>
  `t:${t}, v1:${createHmac("sha256", asBase64Key ? Buffer.from(secret, "base64") : secret).update(`${t}.${body}`).digest("base64")}`;
const hook = async (ev: unknown, header?: string | null) => {
  const body = JSON.stringify(ev);
  const r = await app.fetch(new Request("http://x/v1/bank-hooks/crb", { method: "POST", headers: { "content-type": "application/json", ...(header === null ? {} : { "cos-signature": header ?? sig(body) }) }, body }), env, ctx);
  return { status: r.status, json: await r.json().catch(() => null) as any };
};

// ---- the client: one token for many calls, a fresh one only when the bank says it expired, the proxy key on every request
const c = crbClient(env)!;
await c.call("GET", "/rtp/v1/directory?filter.routingNumber=000000000");
await c.call("GET", "/rtp/v1/directory?filter.routingNumber=000000000");
eq("one token serves many calls", bank.tokens, 1);
bank.expireNext = true;
await c.call("GET", "/rtp/v1/directory?filter.routingNumber=000000000");
eq("an expired token is replaced once and the call repeats", bank.tokens, 2);
eq("every request carries the proxy key and nothing else is sent without it", [...bank.proxyKeys], ["proxy-key-1"]);
bank.down = true;
const err: any = await c.call("GET", "/rtp/v1/directory?filter.routingNumber=1").catch((e) => e);
bank.down = false;
eq("an outage is an error that is not definitive (it is retried later)", [err instanceof CrbError, err.status, err.definitive], [true, 503, false]);
eq("without the bank's settings there is no client", crbClient({ ...env, CR_CLIENT_SEC: undefined }), null);

// ---- the bank directory decides whether a bank is instant
const J = await merchant("Jolly Jars", "jolly@x.test", "021000021", "5550001");
eq("a bank on RTP and FedNow is instant, named from the directory", [J.bank.bank.institution.instant, (await q("select directory_name, networks from routing_numbers where routing_number='021000021'"))[0]], [true, { directory_name: "JPMorgan Chase", networks: ["RTP", "FedNow"] }]);
const A = await merchant("Alpha Cafe", "alpha@x.test", "110000000", "0001234567");
eq("a bank the directory does not list is not instant", A.bank.bank.institution.instant, false);

// ---- ACH: a close-out creates one payment, the bank's webhook finishes it
await sale(A, 1000); await sale(A, 500);
const r1 = await closeOut(A);
const ach = [...bank.pays.values()].filter((p) => p.kind === "ach");
eq("close out pays 1500 by same-day ACH: waiting for the bank", [r1.status, r1.json.settlement.rail, r1.json.settlement.status, await bal(A)], [201, "ach", "pending", 0]);
eq("one CCD push with the merchant's own bank details, our originating account, cents, the row id as idempotency key and client id", [ach.length, ach[0]!.body.transactionType, ach[0]!.body.secCode, ach[0]!.body.serviceType, ach[0]!.body.amount, ach[0]!.body.accountNumber, ach[0]!.body.receiver.routingNumber, ach[0]!.body.receiver.accountNumber, ach[0]!.body.receiver.accountType, ach[0]!.body.receiver.name, ach[0]!.body.description, ach[0]!.idem === ach[0]!.body.clientIdentifier], [1, "Push", "CCD", "SameDay", 1500, "109722829461", "110000000", "0001234567", "Checking", "ALPHA CAFE", "NUCLEAR", true]);
eq("the row keeps the bank's payment id as its reference", (await rows(A)).map((r: any) => [r.status, r.ref]), [["submitted", `ach:${ach[0]!.id}`]]);

const ev = { id: randomUUID(), eventName: "Ach.Payment.Sent", partnerId: "p", createdAt: new Date().toISOString(), resources: [`/ach/v1/payments/${ach[0]!.id}`], isPing: false };
eq("a webhook while the payment is still pending changes nothing", [(await hook(ev)).status, (await rows(A))[0].status], [200, "submitted"]);
ach[0]!.status = "Completed";
eq("when the bank says Completed the next event settles the payout", [(await hook(ev)).status, (await rows(A))[0].status, await bal(A)], [200, "settled", 0]);
eq("a repeat of the event does nothing more", [(await hook(ev)).status, (await rows(A)).length, (await q("select count(*)::int n from transactions where type in ('settle','settle_return','collect')"))[0].n], [200, 1, 1]);

// ---- a return arrives days after Completed: the money goes back to the merchant, once
const ret: Pay = { id: randomUUID(), kind: "ach", body: {}, idem: null, status: "Completed", original: ach[0]!.id, returnCode: "R02" };
bank.pays.set(ret.id, ret);
const rev = { id: randomUUID(), eventName: "Ach.Return.Received", resources: [`/ach/v1/payments/${ret.id}`] };
eq("Ach.Return.Received returns the settled payout: balance restored, row returned with the bank's code", [(await hook(rev)).status, await bal(A), (await rows(A))[0].status, (await rows(A))[0].code], [200, 1500, "returned", "R02"]);
eq("a repeat of the return does not restore it twice", [(await hook(rev)).status, await bal(A), (await q("select count(*)::int n from transactions where type='settle_return'"))[0].n], [200, 1500, 1]);
eq("the books reconcile after a late return", await recon().then((r: any) => [r.ledger_balanced, r.balances_match_ledger]), [true, true]);

// ---- a payment the bank rejects gives the money back
const B = await merchant("Beta Books", "beta@x.test", "110000000", "7770002");
await sale(B, 700);
await closeOut(B);
const bp = [...bank.pays.values()].filter((p) => p.kind === "ach" && p.body.receiver?.accountNumber === "7770002")[0]!;
bp.status = "Rejected"; bp.postingCode = "ANF";
await hook({ id: randomUUID(), eventName: "Ach.Payment.Rejected", resources: [{ href: `/ach/v1/payments/${bp.id}` }] });
eq("Ach.Payment.Rejected returns the payout with the posting code", [(await rows(B))[0].status, (await rows(B))[0].code, await bal(B)], ["returned", "ANF", 700]);

// ---- instant payment: a bank that takes it is paid instantly; one the bank then refuses falls back to same-day ACH
const before = bank.pays.size;
await sale(J, 900);
const rj = await closeOut(J);
const rtp = [...bank.pays.values()].filter((p) => p.kind === "rtp");
eq("an instant bank gets an instant payment: creditor, amount, no network unless configured", [rj.json.settlement.rail, rtp.length, rtp[0]!.body.amount, rtp[0]!.body.creditor, rtp[0]!.body.networkPlatform], ["instant", 1, 900, { name: "JOLLY JARS", accountNumber: "5550001", routingNumber: "021000021" }, undefined]);
rtp[0]!.status = "Completed";
await hook({ id: randomUUID(), eventName: "Rtp.Payment.Completed", resources: { paymentId: rtp[0]!.id } });
eq("when the bank completes it the payout is settled", (await rows(J)).map((r: any) => [r.rail, r.status]), [["instant", "settled"]]);

const K = await merchant("Kilo Kitchen", "kilo@x.test", "021000021", "5550002");
await sale(K, 450);
bank.createDefinitive = 2013;
const rk = await closeOut(K);
bank.createDefinitive = 0;
eq("an instant payment the bank cannot take is sent as same-day ACH in the same request", [rk.json.settlement.rail, (await rows(K)).map((r: any) => [r.rail, r.status, r.ref?.startsWith("ach:")]), await bal(K)], ["ach", [["ach", "submitted", true]], 0]);
const KR = [...bank.pays.values()].filter((p) => p.kind === "rtp" && p.body.creditor.accountNumber === "5550002");
eq("nothing was created at the bank for the refused instant payment", KR.length, 0);

const L = await merchant("Lima Lamps", "lima@x.test", "021000021", "5550003");
await sale(L, 300);
await closeOut(L);
const lp = [...bank.pays.values()].filter((p) => p.kind === "rtp" && p.body.creditor.accountNumber === "5550003")[0]!;
lp.status = "Rejected"; lp.postingCode = "NARC";
await hook({ id: randomUUID(), eventName: "Rtp.Payment.Rejected", resources: [lp.id] });
eq("an instant payment the receiving bank rejects afterwards goes by same-day ACH", (await rows(L)).map((r: any) => [r.rail, r.status, r.ref?.slice(0, 4)]), [["ach", "submitted", "ach:"]]);

// ---- the bank is unreachable: the balance is already paid out of, the row stays unsent, the next run sends it once
const M = await merchant("Mike Motors", "mike@x.test", "110000000", "7770004");
await sale(M, 600);
bank.down = true;
const rm = await closeOut(M);
bank.down = false;
eq("with the bank down the close-out still takes the balance and waits (no payment, no reference)", [rm.status, rm.json.settlement.status, await bal(M), (await rows(M)).map((r: any) => [r.status, r.ref])], [201, "pending", 0, [["submitted", null]]]);
const nxt: any = await runSettlement(env, sql, addDays(today, 1));
const mp = [...bank.pays.values()].filter((p) => p.body.receiver?.accountNumber === "7770004");
eq("the next run sends the waiting row: one payment, one reference", [mp.length, (await rows(M))[0].ref === `ach:${mp[0]!.id}`], [1, true]);

// ---- a create whose answer was lost: the payment exists, so we find it by our id instead of paying twice
const N = await merchant("November Nuts", "nov@x.test", "110000000", "7770005");
await sale(N, 800);
bank.createStatus = 500;
await closeOut(N);
const np = [...bank.pays.values()].filter((p) => p.body.receiver?.accountNumber === "7770005");
eq("a lost answer ends with exactly one payment at the bank and the row pointing at it", [np.length, (await rows(N))[0].ref === `ach:${np[0]!.id}`], [1, true]);

eq("the books reconcile before the debt test", await recon().then((r: any) => [r.ledger_balanced, r.balances_match_ledger]), [true, true]);
// ---- a collection the bank returns after it arrived: the debt comes back, once, and is collected again
const P = await merchant("Papa Pies", "papa@x.test", "110000000", "7770007");
await q("update balances set balance = -500 where account_id=$1", [P.account_id]);
await runSettlement(env, sql, addDays(today, 3));
const pull = [...bank.pays.values()].filter((p) => p.body.receiver?.accountNumber === "7770007")[0]!;
eq("a debt is collected by an ACH pull, waiting for the bank", [pull.body.transactionType, pull.body.amount, (await rows(P)).map((r: any) => [r.direction, r.status])], ["Pull", 500, [["debit", "submitted"]]]);
pull.status = "Completed";
await hook({ id: randomUUID(), eventName: "Ach.Payment.Sent", resources: [`/ach/v1/payments/${pull.id}`] });
eq("when the pull completes the debt is cleared", [(await rows(P))[0].status, await bal(P)], ["settled", 0]);
const pret: Pay = { id: randomUUID(), kind: "ach", body: {}, idem: null, status: "Completed", original: pull.id, returnCode: "R01" };
bank.pays.set(pret.id, pret);
const pev = { id: randomUUID(), eventName: "Ach.Return.Received", resources: [`/ach/v1/payments/${pret.id}`] };
await hook(pev);
eq("the return after it arrived puts the debt back: balance -500, the row returned with the bank's code", [await bal(P), (await rows(P))[0].status, (await rows(P))[0].code], [-500, "returned", "R01"]);
eq("one collect_return, from the merchant to the bank, related to the collect and keyed by the day", (await q("select t.type, t.amount::int a, t.related_id = c.id rel, t.idem from transactions t join transactions c on c.settlement_id = t.settlement_id and c.type = 'collect' where t.type = 'collect_return'"))[0], { type: "collect_return", a: 500, rel: true, idem: `collect_return:${P.account_id}:${addDays(today, 2)}` });
await hook(pev);
eq("a repeat of the return changes nothing", [await bal(P), (await q("select count(*)::int n from transactions where type='collect_return'"))[0].n], [-500, 1]);
eq("the transactions still balance against each other (the -500 debt was set directly, so account balances are not compared)", await recon().then((r: any) => r.ledger_balanced), true);

// ---- the webhook route: the signature is the only authority
const evb = { id: randomUUID(), eventName: "Ach.Payment.Sent", resources: [] };
const body = JSON.stringify(evb);
eq("no signature: 401", (await hook(evb, null)).status, 401);
eq("a wrong signature: 401", (await hook(evb, sig(body, randomBytes(24).toString("base64")))).status, 401);
eq("a body changed after signing: 401", (await hook({ ...evb, id: randomUUID() }, sig(body))).status, 401);
eq("an old timestamp (25 minutes): 401", (await hook(evb, sig(body, WH, Math.floor(Date.now() / 1000) - 25 * 60))).status, 401);
eq("a fresh signature: 200", (await hook(evb)).status, 200);
eq("a ping answers 200", (await hook({ id: randomUUID(), eventName: "Ping", isPing: true, resources: [] })).status, 200);
eq("an event about a payment we do not know is acknowledged (the registration must not be suspended)", (await hook({ id: randomUUID(), eventName: "Ach.Payment.Sent", resources: [`/ach/v1/payments/${randomUUID()}`] })).status, 200);
eq("a secret read as plain text instead of base64 is refused", (await hook(evb, sig(body, WH, undefined, false))).status, 401);
const none = await app.fetch(new Request("http://x/v1/bank-hooks/crb", { method: "POST", body }), { ...env, CR_WH_SEC: undefined }, ctx);
eq("without a webhook secret the route is off (503)", none.status, 503);

// ---- the sandbox stand-in still pays when the bank is not switched on
const S = await merchant("Sierra Subs", "sierra@x.test", "110000000", "7770006");
await sale(S, 100);
const saved = env.CR_PAYOUTS; env.CR_PAYOUTS = "false";
const rs = await closeOut(S);
env.CR_PAYOUTS = saved;
eq("with CR_PAYOUTS off the sandbox stand-in settles it and the bank is not called", [rs.json.settlement.status, [...bank.pays.values()].filter((p) => p.body.receiver?.accountNumber === "7770006").length], ["completed", 0]);

console.log(`\n${pass} passed, ${fail} failed`);
await adm.end(); await sql.end?.();
process.exit(fail ? 1 : 0);
