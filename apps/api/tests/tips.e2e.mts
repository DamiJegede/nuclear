import { migrate, psql } from "./db.ts";
import { createCipheriv, randomBytes } from "node:crypto";
import postgres from "postgres";
import app from "../src/index.ts";
import { connect } from "../src/db.ts";

psql(["-c", "drop schema public cascade; create schema public;"]);
migrate();
const adm = postgres("postgres://postgres@127.0.0.1:54340/nuclear", { max: 2, onnotice: () => {} });
const q = async (s: string, p: unknown[] = []) => (await adm.unsafe(s, p as any)) as any[];

const tagKey = randomBytes(16);
const env: any = {
  HYPERDRIVE: { connectionString: "postgres://postgres@127.0.0.1:54340/nuclear" },
  JWT_SECRET: "test-secret-test-secret-test-secret!",
  SANDBOX_FUNDING: "true",
  TAG_KEY_V1: tagKey.toString("hex"),
};
const ctx: any = { waitUntil: (p: Promise<unknown>) => void p.catch(() => {}), passThroughOnException() {} };
let pass = 0, fail = 0;
const call = async (method: string, path: string, o: { body?: unknown; token?: string; key?: string } = {}) => {
  const res = await app.fetch(new Request("http://x" + path, {
    method,
    headers: { "content-type": "application/json",
      ...(o.token ? { authorization: `Bearer ${o.token}` } : {}),
      ...(o.key ? { "idempotency-key": o.key } : {}) },
    body: o.body === undefined ? undefined : JSON.stringify(o.body),
  }), env, ctx);
  const t = await res.text();
  return { status: res.status, json: t ? JSON.parse(t) : null };
};
const eq = (label: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(ok ? "ok  " : "FAIL", label, ok ? "" : `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
};
const signup = async (name: string, email: string, type = "C") => {
  const j = (await call("POST", "/v1/auth/signup", { body: { name, email, password: "correct horse battery", type } })).json;
  if (type === "B") await q("update accounts set status='active' where id=$1", [j.account_id]);   // businesses start pending; this suite needs them live
  return j;
};
const fund = (token: string, amount: number, key: string) => call("POST", "/v1/sandbox/fundings", { token, key, body: { amount } });
const bal = async (token: string) => (await call("GET", "/v1/balance", { token })).json;

// ---- tags (test helper: no claim endpoints yet) ----
const model = (await q("insert into tag_models(type,name,price,quantity) values('band','Band',1000,100) returning id"))[0].id;
const urlFor = (uid: string, counter: number, version = "v1") => {
  const pt = Buffer.alloc(16, 0x55);
  pt[0] = 0xc7; Buffer.from(uid, "hex").copy(pt, 1); pt.writeUIntLE(counter, 8, 3);
  const c = createCipheriv("aes-128-cbc", tagKey, Buffer.alloc(16)); c.setAutoPadding(false);
  return `https://tag.nclr.app/${version}/${Buffer.concat([c.update(pt), c.final()]).toString("hex")}`;
};
let uidSeq = 0x10;
const newTag = async (walletId: string | null, opts: { locked?: boolean; limit?: number } = {}) => {
  const uid = "04" + (uidSeq++).toString(16).padStart(2, "0").repeat(6);
  const id = (await q("insert into tags(uid,model_id,wallet_id,locked,transaction_limit) values($1,$2,$3,$4,$5) returning id",
    [uid.toUpperCase(), model, walletId, opts.locked ?? false, opts.limit ?? null]))[0].id;
  return { uid: uid.toUpperCase(), id };
};
const tpay = (token: string, url: string, amount: number, key: string, extra: object = {}) =>
  call("POST", "/v1/terminal/payments", { token, key, body: { amount, credential: { type: "tag", url }, ...extra } });

// ---- actors ----
const shop = await signup("Shop", "shop@example.com", "B");
const other = await signup("Other Shop", "other@example.com", "B");
const ada = await signup("Ada", "ada@example.com");
const sam = await signup("Sam", "sam@example.com");      // write staff (a manager)
const rae = await signup("Rae", "rae@example.com");      // read staff, the server on the terminal
const tom = await signup("Tom", "tom@example.com");      // read staff, no tips
const zed = await signup("Zed", "zed@example.com");      // not staff
const S = shop.session_token, O = other.session_token, A = ada.session_token;
await fund(A, 100000, "f1");

const terminal = await call("POST", "/v1/terminals", { token: S, body: { name: "Counter" } });
const T = terminal.json.session_token, tid = terminal.json.terminal.id;
const staffId: Record<string, string> = {};
for (const [who, acct, role] of [["sam", sam, "write"], ["rae", rae, "read"], ["tom", tom, "read"]] as const) {
  const r = await call("POST", "/v1/staff", { token: S, body: { staff_account_id: acct.account_id, role } });
  staffId[who] = r.json.staff.id;
}
const otherT = (await call("POST", "/v1/terminals", { token: O, body: { name: "O" } })).json.session_token;
await call("POST", "/v1/staff", { token: O, body: { staff_account_id: zed.account_id, role: "write" } });
const otherStaff = (await call("GET", "/v1/staff", { token: O })).json.staff[0].id;
const tag = await newTag(ada.default_wallet_id);
let ctr = 1;
const pay = (amount: number, key: string, extra: object = {}) => tpay(T, urlFor(tag.uid, ctr++), amount, key, extra);
const tipsOf = async (txId: string) => (await q("select t.amount, a.name from tips t join accounts a on a.id = t.staff_account_id where t.transaction_id = $1 order by a.name", [txId])).map((r: any) => [r.name, Number(r.amount)]);

// ============ the staff list and the active staff member ============
eq("terminal lists the merchant's staff (ids, no bank)", await (async () => { const r = (await call("GET", "/v1/terminal/staff", { token: T })).json; return [r.staff.map((s: any) => [s.name, s.role, "bank_account_id" in s]), r.active_staff_id]; })(),
  [[["Sam", "write", false], ["Rae", "read", false], ["Tom", "read", false]], null]);
eq("another merchant's staff id is refused", (await call("PUT", "/v1/terminal/active-staff", { token: T, body: { staff_id: otherStaff } })).status, 404);
eq("set the active staff member", (await call("PUT", "/v1/terminal/active-staff", { token: T, body: { staff_id: staffId.rae } })).json.active_staff_id, staffId.rae);
eq("a consumer cannot set it", (await call("PUT", "/v1/terminal/active-staff", { token: A, body: { staff_id: staffId.rae } })).status, 401);

// ============ a payment carries the tip and who served it ============
const adaB0 = (await bal(A)).balance, shopB0 = (await bal(S)).balance;
const p1 = await pay(2000, "tp1", { tip: 300 });
eq("tip is part of the amount; the active staff member serves and gets it", [p1.status, p1.json.payment.amount, p1.json.payment.tip_amount, p1.json.payment.served_by === rae.account_id], [201, 2300, 300, true]);
eq("one tip row for the server", await tipsOf(p1.json.payment.id), [["Rae", 300]]);
eq("payer paid and merchant received the whole amount", [adaB0 - (await bal(A)).balance, (await bal(S)).balance - shopB0], [2300, 2300]);
eq("the payment is a checkout: its total stays the items, the tip is on it, and it records who served", (await q("select c.tip_amount, c.total, t.amount, c.status, c.served_by from transactions t join checkouts c on c.id = t.checkout_id where t.id=$1", [p1.json.payment.id])).map((r: any) => [Number(r.tip_amount), Number(r.total), Number(r.amount), r.status, r.served_by === rae.account_id]), [[300, 2000, 2300, "paid", true]]);
eq("the money table has no tip columns", (await q("select count(*)::int n from information_schema.columns where table_name='transactions' and column_name in ('tip_amount','served_by')"))[0].n, 0);

const p2 = await pay(1000, "tp2", { tip: 200, served_by: staffId.sam });
eq("served_by overrides the active staff member", [p2.status, p2.json.payment.served_by === sam.account_id, await tipsOf(p2.json.payment.id)], [201, true, [["Sam", 200]]]);

const p3 = await pay(3000, "tp3", { tip: 250, tips: [{ staff_id: staffId.rae, amount: 150 }, { staff_id: staffId.sam, amount: 100 }] });
eq("a tip splits between people by amounts", [p3.status, await tipsOf(p3.json.payment.id)], [201, [["Rae", 150], ["Sam", 100]]]);

// plan errors come back before the tap is consumed: the same tap URL still works afterwards
const urlA = urlFor(tag.uid, ctr++);
eq("split that does not add up is refused", (await tpay(T, urlA, 1000, "tp4", { tip: 100, tips: [{ staff_id: staffId.rae, amount: 60 }, { staff_id: staffId.sam, amount: 30 }] })).json.error, "tips_mismatch");
eq("unknown staff id is refused", (await tpay(T, urlA, 1000, "tp4", { tip: 100, served_by: "0190aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee" })).json.error, "staff_not_found");
eq("another merchant's staff is refused", (await tpay(T, urlA, 1000, "tp4", { tip: 100, served_by: otherStaff })).json.error, "staff_not_found");
eq("an absurd tip is refused", (await tpay(T, urlA, 1000, "tp4", { tip: 20000, served_by: staffId.sam })).json.error, "invalid_tip");
await call("PUT", "/v1/terminal/active-staff", { token: T, body: { staff_id: null } });
eq("a tip with nobody to give it to is refused", (await tpay(T, urlA, 1000, "tp4", { tip: 100 })).json.error, "staff_required_for_tip");
const p4 = await tpay(T, urlA, 1000, "tp4");
eq("...and the untouched tap pays without a tip when none is asked", [p4.status, p4.json.payment.tip_amount, p4.json.payment.served_by], [201, 0, null]);
eq("no tip means no tip row, but the order is still a checkout with no server", [(await q("select count(*)::int n from tips where transaction_id=$1", [p4.json.payment.id]))[0].n, (await q("select tip_amount::int t, served_by from checkouts where id=(select checkout_id from transactions where id=$1)", [p4.json.payment.id]))[0]], [0, { t: 0, served_by: null }]);
await call("PUT", "/v1/terminal/active-staff", { token: T, body: { staff_id: staffId.rae } });

// ============ retries ============
const ctrBefore = ctr;
const again = await tpay(T, urlFor(tag.uid, ctr++), 2000, "tp1", { tip: 300 });
eq("a retry returns the recorded payment, no second tip", [again.status, again.json.payment.id === p1.json.payment.id, (await q("select count(*)::int n from tips where transaction_id=$1", [p1.json.payment.id]))[0].n], [200, true, 1]);
eq("a retry with another tip is a mismatch", (await tpay(T, urlFor(tag.uid, ctr++), 2000, "tp1", { tip: 400 })).json.error, "idempotency_mismatch");
eq("a retry with the tip dropped is a mismatch", (await tpay(T, urlFor(tag.uid, ctr++), 2000, "tp1")).json.error, "idempotency_mismatch");
void ctrBefore;

// ============ the customer's own app ============
const p5 = await call("POST", "/v1/payments", { token: A, key: "app1", body: { terminal_id: tid, amount: 1500, tip: 100 } });
eq("an app payment's tip goes to the terminal's active staff member", [p5.status, p5.json.payment.amount, p5.json.payment.tip_amount, await tipsOf(p5.json.payment.id)], [201, 1600, 100, [["Rae", 100]]]);
eq("a customer cannot name who gets the tip", (await call("POST", "/v1/payments", { token: A, key: "app2", body: { terminal_id: tid, amount: 1500, tip: 100, served_by: staffId.sam } })).status, 201);
eq("...it is ignored: still the active staff member", (await q("select a.name from tips t join accounts a on a.id=t.staff_account_id where t.transaction_id=(select id from transactions where idem like '%app2')"))[0].name, "Rae");

// ============ a declined payment writes no tip ============
const poor = await signup("Poor", "poor@example.com"); await fund(poor.session_token, 1000, "fp");
const pt = await newTag(poor.default_wallet_id);
const dec = await tpay(T, urlFor(pt.uid, 1), 900, "dec1", { tip: 200 });
eq("insufficient funds decline (tip counted in the amount) and no tip row", [dec.status, dec.json.status_code, (await q("select count(*)::int n from tips t join transactions x on x.id=t.transaction_id where x.status='declined'"))[0].n], [422, "insufficient_balance", 0]);

// ============ the checkout knows who served, and the tip follows it ============
const co1 = await call("POST", "/v1/terminal/checkouts", { token: T, body: { amount: 4000, served_by: staffId.sam } });
eq("a checkout records who serves it (the request)", [co1.status, (await q("select served_by from checkouts where id=$1", [co1.json.checkout.id]))[0].served_by === sam.account_id, co1.json.checkout.served_by === sam.account_id, co1.json.checkout.tip_amount], [201, true, true, 0]);
const co2 = await call("POST", "/v1/terminal/checkouts", { token: T, body: { amount: 1800 } });
eq("...or the terminal's active staff member", co2.json.checkout.served_by === rae.account_id, true);
eq("an unknown or other merchant's staff id is refused", [(await call("POST", "/v1/terminal/checkouts", { token: T, body: { amount: 100, served_by: otherStaff } })).status, (await call("POST", "/v1/terminal/checkouts", { token: T, body: { amount: 100, served_by: "0190aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee" } })).status], [404, 404]);
const payCo = (url: string, checkoutId: string, key: string, extra: object = {}) =>
  call("POST", "/v1/terminal/payments", { token: T, key, body: { checkout_id: checkoutId, credential: { type: "tag", url }, ...extra } });
const paid1 = await payCo(urlFor(tag.uid, ctr++), co1.json.checkout.id, "tpc1", { tip: 600 });
eq("the tip of an order goes to its server, not whoever is signed in on the terminal", [paid1.status, paid1.json.payment.amount, paid1.json.payment.tip_amount, await tipsOf(paid1.json.payment.id)], [201, 4600, 600, [["Sam", 600]]]);
eq("the paid checkout carries the tip once, and its total is still the items", (await q("select status, total::int t, tip_amount::int tip from checkouts where id=$1", [co1.json.checkout.id]))[0], { status: "paid", t: 4000, tip: 600 });
eq("a request can still name someone else for the tip", await (async () => { const r = await payCo(urlFor(tag.uid, ctr++), co2.json.checkout.id, "tpc2", { tip: 200, served_by: staffId.sam }); return [r.status, await tipsOf(r.json.payment.id)]; })(), [201, [["Sam", 200]]]);
// a declined payment of an amount-only order leaves nothing live behind
const decOrders = (await q("select count(*)::int n from checkouts where status='canceled'"))[0].n;
const dec2 = await tpay(T, urlFor(pt.uid, 2), 900, "dec2", { tip: 200 });
eq("a declined amount-only payment cancels its checkout and keeps no tip on it", [dec2.status, (await q("select count(*)::int n from checkouts where status='canceled'"))[0].n - decOrders, (await q("select count(*)::int n from checkouts where tip_amount > 0 and status <> 'paid'"))[0].n], [422, 1, 0]);
eq("a declined payment of an existing checkout leaves it open for another try", await (async () => { const c = await call("POST", "/v1/terminal/checkouts", { token: T, body: { amount: 900 } }); const d = await payCo(urlFor(pt.uid, 3), c.json.checkout.id, "dec3", { tip: 300 }); if (d.status !== 422) return "not declined"; return (await q("select status from checkouts where id=$1", [c.json.checkout.id]))[0].status; })(), "open");

// ============ who sees what ============
const view = async (token: string, qs: string) => call("GET", `/v1/tips${qs}`, { token });
const bizQ = `?business=${shop.account_id}`;
const rae_ = (await view(rae.session_token, bizQ)).json;
eq("a server sees only their own tips", [rae_.role, rae_.total, rae_.staff.map((s: any) => s.name), rae_.tips.every((t: any) => t.staff_account_id === rae.account_id)], ["read", 300 + 150 + 100 + 100 + 0, ["Rae"], true]);
const sam_ = (await view(sam.session_token, bizQ)).json;
eq("a write-role staff member sees everyone's", [sam_.role, sam_.staff.map((s: any) => [s.name, s.total])], ["write", [["Sam", 1100], ["Rae", 650]]]);
const own_ = (await view(S, "")).json;
eq("the business sees everyone's too", [own_.role, own_.total, own_.count], ["owner", 1750, 8]);
eq("a manager can look at one person", (await view(sam.session_token, `${bizQ}&staff=${rae.account_id}`)).json.staff.map((s: any) => s.name), ["Rae"]);
eq("a server cannot look at someone else", (await view(rae.session_token, `${bizQ}&staff=${sam.account_id}`)).status, 403);
eq("a staff member with no tips sees zero", [(await view(tom.session_token, bizQ)).json.total, (await view(tom.session_token, bizQ)).json.tips.length], [0, 0]);
eq("a person who is not staff is refused", (await view(zed.session_token, bizQ)).status, 404);
eq("a consumer must name the business", (await view(rae.session_token, "")).status, 400);
eq("another business cannot read this one", (await view(O, bizQ)).status, 404);
eq("a delegated wallet session cannot read tips", (await call("GET", `/v1/tips${bizQ}`, { token: (await call("POST", "/v1/devices/redeem", { body: { token: (await call("POST", `/v1/wallets/${(await call("POST", "/v1/wallets", { token: A, body: { display_name: "Kid", type: "person" } })).json.wallet.id}/links`, { token: A })).json.url.split("/magic-link/")[1] } })).json.session_token })).status, 403);
eq("an agent key cannot read tips", (await call("GET", `/v1/tips${bizQ}`, { token: "nk_agent_" + "x".repeat(43) })).status, 401);
eq("the employer list names the business and the role", (await call("GET", "/v1/tips/employers", { token: rae.session_token })).json.employers.map((e: any) => [e.name, e.role]), [["Shop", "read"]]);

// period filters (program days, New York)
const today = (await q("select (now() at time zone 'America/New_York')::date::text d"))[0].d;
eq("today covers them", (await view(rae.session_token, `${bizQ}&from=${today}&to=${today}`)).json.total, 650);
eq("another day is empty", (await view(rae.session_token, `${bizQ}&from=2020-01-01&to=2020-01-02`)).json.total, 0);
eq("bad dates are refused", [(await view(rae.session_token, `${bizQ}&from=2020-13-01`)).status, (await view(rae.session_token, `${bizQ}&from=2021-01-02&to=2021-01-01`)).status], [400, 400]);
const pg = (await view(S, "?limit=2")).json;
eq("pages carry a cursor", [pg.tips.length, pg.next_cursor !== null, (await view(S, `?limit=2&cursor=${pg.next_cursor}`)).json.tips.length], [2, true, 2]);
eq("a bad cursor is refused", (await view(S, "?cursor=nonsense")).status, 400);

// per-day totals (program days, New York)
const days = (await view(S, "")).json.days;
eq("per-day totals: today holds every entry, and the days add up to the total", [days.map((d: any) => d.date), days.reduce((a: number, d: any) => a + d.total, 0), days[0]?.count], [[today], 1750, 8]);
eq("a person's days are their own", (await view(rae.session_token, bizQ)).json.days, [{ date: today, total: 650, count: 4 }]);
await q("update tips set created_at = created_at where false");   // (rows are immutable: a past day is made with the trigger off)
await adm.unsafe("alter table tips disable trigger tips_no_update");
await q("update tips set created_at = created_at - interval '3 days' where amount = 150 and staff_account_id = $1", [rae.account_id]);
await adm.unsafe("alter table tips enable trigger tips_no_update");
const days2 = (await view(rae.session_token, bizQ)).json;
eq("entries on another day make another row, newest first, netting refunds", [days2.days.map((d: any) => [d.count, d.total]), days2.total], [[[3, 500], [1, 150]], 650]);
eq("the period limits the days", (await view(rae.session_token, `${bizQ}&from=${today}&to=${today}`)).json.days.map((d: any) => d.date), [today]);
eq("no tips, no days", (await view(tom.session_token, bizQ)).json.days, []);

// ============ refunds take tips back only beyond the non-tip part ============
const refund = (attempt: string, mode: string, key: string, amount?: number) => call("POST", "/v1/terminal/refunds", { token: T, key, body: { attempt, mode, ...(amount ? { amount } : {}) } });
const net = async (tx: string) => (await q("select a.name, sum(t.amount)::int n from tips t join accounts a on a.id=t.staff_account_id join transactions x on x.id=t.transaction_id where x.id=$1 or x.related_id=$1 group by a.name order by a.name", [tx])).map((r: any) => [r.name, r.n]).filter((r: any) => r[1] !== 0);
// p1: 2000 + 300 tip. A refund of the items part leaves the tip alone; the rest takes it back.
eq("refunding the non-tip part leaves the tip", [(await refund("tp1", "partial", "r1", 2000)).status, (await net(p1.json.payment.id))], [201, [["Rae", 300]]]);
eq("refunding the rest returns the tip", [(await refund("tp1", "full", "r2")).status, await net(p1.json.payment.id)], [201, []]);
eq("the refund that returned the tip wrote one negative row; the item refund wrote none", (await q("select (select sum(amount)::int from tips where transaction_id=x.id) s from transactions x where x.related_id=$1 and x.type='refund' order by x.created_at", [p1.json.payment.id])), [{ s: null }, { s: -300 }]);
// p3: 3000 + 250 tip split 150/100. A full refund reverses each share exactly.
eq("a full refund of a split tip reverses each share", [(await refund("tp3", "full", "r3")).status, await net(p3.json.payment.id)], [201, []]);

// a split that does not divide evenly: 1000 + 101 tip, Rae 51 / Sam 50
const p6 = await pay(1000, "tp6", { tip: 101, tips: [{ staff_id: staffId.rae, amount: 51 }, { staff_id: staffId.sam, amount: 50 }] });
eq("uneven split recorded", await tipsOf(p6.json.payment.id), [["Rae", 51], ["Sam", 50]]);
await refund("tp6", "partial", "r6a", 1050);   // 50 beyond the non-tip part
const mid = await net(p6.json.payment.id);
eq("a part of the tip is taken back in proportion (the spare cent goes to the larger remainder)", mid, [["Rae", 26], ["Sam", 25]]);
await refund("tp6", "full", "r6b");
eq("the rest takes back exactly what remains", await net(p6.json.payment.id), []);

// ============ the books ============
eq("every payment's tip rows add up to its checkout's tip", (await q("select count(*)::int n from transactions x join checkouts c on c.id = x.checkout_id where x.type='pay' and x.status='completed' and c.tip_amount <> coalesce((select sum(amount) from tips where transaction_id=x.id), 0)"))[0].n, 0);
eq("every completed payment is a checkout", (await q("select count(*)::int n from transactions where type='pay' and checkout_id is null"))[0].n, 0);
eq("what refunds took back never exceeds the tip", (await q("select count(*)::int n from transactions p where p.type='pay' and p.status='completed' and (select coalesce(sum(amount),0) from tips where transaction_id=p.id or transaction_id in (select id from transactions where related_id=p.id and type='refund')) < 0"))[0].n, 0);
let immutable = 0;
for (const sqlText of ["update tips set amount = 1", "delete from tips", "truncate tips"]) { try { await q(sqlText); } catch { immutable++; } }
eq("tips are immutable", immutable, 3);
let scope = "";
try { await q("insert into tips(transaction_id, account_id, staff_account_id, amount) values($1, $2, $3, 5)", [p4.json.payment.id, other.account_id, rae.account_id]); } catch (e: any) { scope = e.message; }
eq("a tip must belong to the merchant of its payment", scope.includes("a tip belongs to a completed payment or refund of its merchant"), true);
let wrongSign = "";
try { await q("insert into tips(transaction_id, account_id, staff_account_id, amount) values($1, $2, $3, -5)", [p4.json.payment.id, shop.account_id, rae.account_id]); } catch (e: any) { wrongSign = e.message; }
eq("a payment's tip cannot be negative", wrongSign.includes("positive"), true);

// ============ removing staff keeps their tips; the bank column is gone ============
const before = (await view(S, `?staff=${rae.account_id}`)).json.total;
eq("remove a staff member", (await call("DELETE", `/v1/staff/${staffId.rae}`, { token: S })).status, 204);
eq("their tips stay for the business", [(await view(S, `?staff=${rae.account_id}`)).json.total, before], [before, before]);
eq("they lose the staff view", (await view(rae.session_token, bizQ)).status, 404);
eq("the terminal's active staff is cleared when they leave", (await q("select active_staff_id from terminals where id=$1", [tid]))[0].active_staff_id, null);
eq("staff have no bank column any more", (await q("select count(*)::int n from information_schema.columns where table_name='staff' and column_name='bank_account_id'"))[0].n, 0);

console.log(`\n${pass} passed, ${fail} failed`);
await adm.end();
process.exit(fail ? 1 : 0);
