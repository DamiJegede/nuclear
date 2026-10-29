import { createCipheriv, randomBytes } from "node:crypto";
import postgres from "postgres";
import app from "../src/index.ts";
import { connect } from "../src/db.ts";
import { addDays, easternDate } from "../src/lib/dates.ts";
import { arrivalOf, closeOut, pollSubmittedSettlements, runSettlement } from "../src/lib/settlement.ts";
import { sandboxAch, type AchItem, type AchProvider } from "../src/lib/ach.ts";
import { migrate, resetSchema, PG_URL } from "./db.ts";
resetSchema(); migrate();
const adm = postgres(PG_URL, { max: 3, onnotice: () => {} });
const q = async (s: string, p: unknown[] = []) => (await adm.unsafe(s, p as any)) as any[];
const tagKey = randomBytes(16);
const OP = "op-" + randomBytes(16).toString("hex");
const env: any = { STATS_TTL_SECONDS: "0", HYPERDRIVE: { connectionString: PG_URL }, JWT_SECRET: "x".repeat(40), ADMIN_API_TOKEN: OP, SANDBOX_FUNDING: "true", BANK_ENCRYPTION_KEY: randomBytes(32).toString("base64"), TAG_KEY_V1: tagKey.toString("hex") };
const live: any = { ...env, SANDBOX_FUNDING: undefined };
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

async function merchant(name: string, email: string, withBank = true) {
  const m = await sign(name, email, "B");
  await q("update accounts set status='active' where id=$1", [m.account_id]);
  if (withBank) {
    await call("PUT", "/v1/business/profile", { token: m.session_token, body: { legal_name: name + " LLC", display_name: name } });
    await call("PUT", "/v1/business/bank", { token: m.session_token, body: { routing_number: "110000000", account_number: "0001234567" + email.length } });
  }
  const term = (await call("POST", "/v1/terminals", { token: m.session_token, body: { name: "Counter" } })).json;
  return { ...m, term: term.terminal.id };
}
const payer = await sign("Payer", "payer@x.test");
await call("POST", "/v1/sandbox/fundings", { token: payer.session_token, key: "f1", body: { amount: 190000 } });
let n = 0;
const sale = async (m: any, amount: number) => (await call("POST", "/v1/payments", { token: payer.session_token, key: `sale-${n++}`, body: { amount, terminal_id: m.term } })).json.payment;
const bal = async (m: any) => Number((await q("select balance from balances where account_id=$1", [m.account_id]))[0].balance);
const closeOutCall = (m: any) => call("POST", "/v1/business/close-out", { token: m.session_token });
const rows = (m: any) => q("select source, rail, status, direction, amount::int amount, settle_date::text d from settlements where merchant_account_id=$1 order by created_at", [m.account_id]);
const recon = async () => (await call("GET", "/v1/admin/stats", { token: OP })).json.reconciliation;

// ---- a merchant closes out: the whole balance, at once, for today
const A = await merchant("Alpha Cafe", "alpha@x.test");
await sale(A, 1000); await sale(A, 500);
const r1 = await closeOutCall(A);
eq("close out pays the whole balance now: 201, the amount, the rail (ACH: the bank is not known to be instant), settled by the bank", [r1.status, r1.json.settlement.amount, r1.json.settlement.rail, r1.json.settlement.status, r1.json.settlement.date], [201, 1500, "ach", "completed", today]);
eq("the arrival is honest: today before the same-day cutoff, otherwise the next business day", ["today", "next_business_day"].includes(r1.json.settlement.arrival), true);
eq("the balance dropped to zero and one row says close_out, same-day ACH, for today", [await bal(A), await rows(A)], [0, [{ source: "close_out", rail: "ach", status: "settled", direction: "credit", amount: 1500, d: today }]]);
eq("it is one settle transaction from the merchant's wallet to the bank wallet, keyed by the day", (await q("select count(*)::int n, min(idempotency_key) k from (select idem as idempotency_key from transactions where type = 'settle') x"))[0], { n: 1, k: `settle:${A.account_id}:${today}` });
eq("the books still reconcile", await recon().then((r: any) => [r.ledger_balanced, r.balances_match_ledger]), [true, true]);
eq("the merchant's payouts list says it was a close-out", (await call("GET", "/v1/business/payouts", { token: A.session_token })).json.payouts.map((p: any) => [p.kind, p.amount, p.status, p.source, p.rail]), [["payout", 1500, "completed", "close_out", "ach"]]);

// ---- only one settlement a day; what is sold afterwards belongs to the next day
await sale(A, 250);
const r2 = await closeOutCall(A);
eq("a second close-out the same day is refused and the balance is untouched", [r2.status, r2.json.error, await bal(A)], [409, "already_closed_out", 250]);
const ov = (await call("GET", "/v1/business/overview", { token: A.session_token })).json;
eq("today now counts only what was sold since the close-out", [ov.today.transactions, ov.today.closed_out_at !== null, ov.today.since === ov.today.closed_out_at], [1, true, true]);
const tomorrow = addDays(today, 1);
const nightly: any = await runSettlement(env, sql, tomorrow);
eq("tonight's run settles today's date but skips a merchant that already closed out: the evening sale stays in the balance", [nightly.cutoff_date, nightly.created, await bal(A), (await rows(A)).length], [today, 0, 250, 1]);
const next: any = await runSettlement(env, sql, addDays(today, 2));
eq("the next day's run sweeps it, as the next day's settlement", [next.cutoff_date, next.payouts, await bal(A), (await rows(A)).map((r: any) => [r.source, r.amount, r.d])], [tomorrow, 1, 0, [["close_out", 1500, today], ["nightly", 250, tomorrow]]]);

// ---- refusals
const B = await merchant("Beta Books", "beta@x.test", false);
await sale(B, 700);
eq("no payout bank: refused, money untouched", [(await closeOutCall(B)).json.error, await bal(B)], ["no_bank", 700]);
const C = await merchant("Gamma Grill", "gamma@x.test");
eq("nothing to close out: 409", [(await closeOutCall(C)).status, (await closeOutCall(C)).json.error], [409, "nothing_to_close_out"]);
await q("update balances set balance = -500 where account_id=$1", [C.account_id]);
const owes = await closeOutCall(C);
eq("a merchant that owes money cannot close out (the nightly run collects), and nothing is recorded", [owes.status, owes.json.error, owes.json.owed, (await rows(C)).length], [409, "owes", 500, 0]);
const col: any = await runSettlement(env, sql, addDays(today, 3));
eq("the nightly run still collects it by ACH, never by instant payment", [(await rows(C)).map((r: any) => [r.source, r.direction, r.rail, r.amount])], [[["nightly", "debit", "ach", 500]]]);
eq("without a payment provider it is refused with 503 and nothing moves", await (async () => { const D = await merchant("Delta Deli", "delta@x.test"); await sale(D, 400); const r = await closeOut(live, sql, D.account_id, null); return [r, await bal(D), (await rows(D)).length]; })(), [{ ok: false, error: "payouts_unavailable" }, 400, 0]);

// ---- a double click, or five at once, pays once
const E = await merchant("Echo Eats", "echo@x.test");
await sale(E, 1200); await sale(E, 300);
const burst = await Promise.all([1, 2, 3, 4, 5].map(() => closeOutCall(E)));
eq("five simultaneous close-outs: exactly one is paid", [burst.filter((r) => r.status === 201).length, burst.filter((r) => r.status === 409).length, await bal(E), (await rows(E)).length], [1, 4, 0, 1]);
eq("a sixth in the hour is rate limited", (await closeOutCall(E)).status, 429);
eq("one settle transaction, the whole 1500", (await q("select count(*)::int n, sum(t.amount)::int a from transactions t join settlements s on s.id = t.settlement_id where s.merchant_account_id=$1 and t.type='settle'", [E.account_id]))[0], { n: 1, a: 1500 });

// ---- rails: instant where the bank is instant, same-day ACH when it is not, and a fallback when the bank cannot take the instant payment
const seen: AchItem[] = [];
let instantRejected = false, submitDown = false;
const provider: AchProvider = {
  name: "test",
  submit: async (key, items) => { if (submitDown) throw new Error("bank unreachable"); seen.push(...items.map((i) => ({ ...i }))); return { reference: `t-${key}` }; },
  outcomes: async (_r, items) => items.map((i) => (i.rail === "instant" && instantRejected ? { itemId: i.itemId, outcome: "retry_ach" as const } : { itemId: i.itemId, outcome: "settled" as const })),
};
await q("update routing_numbers set instant = true");
const F = await merchant("Foxtrot Foods", "fox@x.test"); await sale(F, 800);
const rf = await closeOut(env, sql, F.account_id, provider);
eq("a bank that takes instant payments is paid instantly, right away", [rf.ok && rf.settlement.rail, rf.ok && rf.settlement.arrival, rf.ok && rf.settlement.status, seen.map((i) => [i.rail, i.serviceType])], ["instant", "instant", "settled", [["instant", "SameDay"]]]);
seen.length = 0; instantRejected = true;
const G = await merchant("Golf Grill", "golf@x.test"); await sale(G, 900);
const rg = await closeOut(env, sql, G.account_id, provider);
eq("an instant payment the bank cannot take goes by same-day ACH, in the same request", [rg.ok && rg.settlement.rail, rg.ok && rg.settlement.status, seen.map((i) => [i.rail, i.serviceType]), (await rows(G)).map((r: any) => [r.rail, r.status])], ["ach", "settled", [["instant", "SameDay"], ["ach", "SameDay"]], [["ach", "settled"]]]);
instantRejected = false; seen.length = 0; submitDown = true;
const H = await merchant("Hotel Haven", "hotel@x.test"); await sale(H, 650);
const rh = await closeOut(env, sql, H.account_id, provider);
eq("the bank unreachable: the balance still drops and the payout waits, pending", [rh.ok && rh.settlement.status, await bal(H), (await rows(H)).map((r: any) => r.status)], ["submitted", 0, ["submitted"]]);
submitDown = false;
await runSettlement(env, sql, addDays(today, 5), provider);
await pollSubmittedSettlements(env, sql, provider);
eq("the next run sends it, once, and the next poll finishes it (nothing is paid twice)", [(await rows(H)).map((r: any) => r.status), seen.filter((i) => i.accountId === H.account_id).length, (await q("select count(*)::int n from transactions t join settlements s on s.id = t.settlement_id where s.merchant_account_id=$1 and t.type='settle'", [H.account_id]))[0].n], [["settled"], 1, 1]);
eq("a nightly payout to an instant bank is instant too; a collection never is", await (async () => {
  const I = await merchant("India Inn", "india@x.test"); await sale(I, 500);
  const J = await merchant("Juliet Jam", "juliet@x.test"); await q("update balances set balance = -300 where account_id=$1", [J.account_id]);
  seen.length = 0;
  await runSettlement(env, sql, addDays(today, 6), provider);
  return seen.filter((i) => i.accountId === I.account_id || i.accountId === J.account_id).map((i) => [i.direction, i.rail, i.serviceType]).sort();
})(), [["credit", "instant", "Standard"], ["debit", "ach", "Standard"]]);

// ---- the merchant's staff closes out from the terminal with a tap (write staff only)
const urlFor = (uid: string, counter: number) => {
  const pt = Buffer.alloc(16, 0x55);
  pt[0] = 0xc7; Buffer.from(uid, "hex").copy(pt, 1); pt.writeUIntLE(counter, 8, 3);
  const c = createCipheriv("aes-128-cbc", tagKey, Buffer.alloc(16)); c.setAutoPadding(false);
  return `https://tag.nclr.app/v1/${Buffer.concat([c.update(pt), c.final()]).toString("hex")}`;
};
const tagModel = (await q("insert into tag_models(type,name,price,quantity) values('band','Band',1000,100) returning id"))[0].id;
let uid = 0x20;
const tagFor = async (person: any) => { const u = ("04" + (uid++).toString(16).padStart(2, "0").repeat(6)).toUpperCase(); await q("insert into tags(uid,model_id,wallet_id) values($1,$2,$3)", [u, tagModel, person.default_wallet_id]); return u; };
const T = await merchant("Tango Tacos", "tango@x.test");
const termToken = (await call("POST", `/v1/terminals/${T.term}/session`, { token: T.session_token })).json.session_token;
const writer = await sign("Wanda Writer", "wanda@x.test"), reader = await sign("Rita Reader", "rita@x.test"), stranger = await sign("Sam Stranger", "sam@x.test");
await call("POST", "/v1/staff", { token: T.session_token, body: { staff_account_id: writer.account_id, role: "write" } });
await call("POST", "/v1/staff", { token: T.session_token, body: { staff_account_id: reader.account_id, role: "read" } });
const [wTag, rTag, sTag] = [await tagFor(writer), await tagFor(reader), await tagFor(stranger)];
const staffClose = (u: string | null, token = termToken) => call("POST", "/v1/terminal/close-out", { token, body: u === null ? {} : { approval: { credential: { type: "tag", url: u } } } });
await sale(T, 900);
eq("a tap by read-only staff cannot close out: 403, the balance stays", [(await staffClose(urlFor(rTag, 5))).status, (await staffClose(urlFor(sTag, 5))).status, await bal(T)], [403, 403, 900]);
eq("no tap, a bad tap and an owner token on the terminal route are refused", [(await staffClose(null)).status, (await staffClose("https://tag.nclr.app/v1/zz")).status, (await staffClose(urlFor(wTag, 6), T.session_token)).status], [400, 400, 401]);
eq("a replayed tap is refused and a refused tap is still burned", [(await staffClose(urlFor(rTag, 5))).status, (await q("select counter::int c from tags where uid=$1", [rTag]))[0].c], [409, 5]);
const sc = await staffClose(urlFor(wTag, 7));
eq("a tap by write staff closes out: the whole balance, 201, settled by the (sandbox) bank", [sc.status, sc.json.settlement.amount, sc.json.settlement.status, await bal(T)], [201, 900, "completed", 0]);
eq("the log says which staff member did it", (await q("select actor_id, details from logs where action = 'merchant.closed_out_by_staff'"))[0].actor_id, writer.account_id);
eq("the same tap again is a replay", (await staffClose(urlFor(wTag, 7))).status, 409);
await sale(T, 100);
eq("a fresh tap the same day, after a later sale, is 409 already_closed_out and the sale stays in the balance", [(await staffClose(urlFor(wTag, 8))).json.error, await bal(T)], ["already_closed_out", 100]);

// ---- when it arrives
const at = (iso: string) => new Date(iso);
eq("arrival: instant always; ACH before 4 pm Eastern on a weekday is today, later or on a weekend is the next business day", [
  arrivalOf("instant", at("2026-10-24T03:00:00Z")),                       // Saturday night, still instant
  arrivalOf("ach", at("2026-10-28T15:00:00Z")),                           // Wednesday 11:00 ET
  arrivalOf("ach", at("2026-10-28T21:30:00Z")),                           // Wednesday 17:30 ET
  arrivalOf("ach", at("2026-10-24T15:00:00Z")),                           // Saturday 11:00 ET
], ["instant", "today", "next_business_day", "next_business_day"]);
eq("the audit log records each close-out", (await q("select count(*)::int n from logs where action = 'merchant.closed_out'"))[0].n >= 5, true);

console.log(`\n${pass} passed, ${fail} failed`); await adm.end(); process.exit(fail ? 1 : 0);
