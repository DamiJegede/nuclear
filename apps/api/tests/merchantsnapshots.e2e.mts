import postgres from "postgres";
import { connect } from "../src/db.ts";
import { addDays } from "../src/lib/dates.ts";
import { merchantTransactions } from "../src/lib/merchantSupport.ts";
import { catchUpMerchantSnapshots, merchantSnapshotDay } from "../src/lib/merchantSnapshots.ts";
import { migrate, resetSchema, PG_URL } from "./db.ts";
resetSchema(); migrate();
const adm = postgres(PG_URL, { max: 4, onnotice: () => {} });
const q = async (s: string, p: unknown[] = []) => (await adm.unsafe(s, p as any)) as any[];
const sql = connect({ HYPERDRIVE: { connectionString: PG_URL } } as any);
let pass = 0, fail = 0;
const eq = (l: string, g: unknown, w: unknown) => { const ok = JSON.stringify(g) === JSON.stringify(w); ok ? pass++ : fail++; console.log(ok ? "ok  " : "FAIL", l, ok ? "" : `got ${JSON.stringify(g)} want ${JSON.stringify(w)}`); };

const today = (await q("select program_today()::text d"))[0].d as string;
eq("the migration marks yesterday as the last snapshot day", await merchantSnapshotDay(sql as any), addDays(today, -1));

// one merchant and two customers, rows placed on past program days (triggers off: the rows are inserted directly)
const acct = async (type: string, name: string) => { const a = (await q("insert into accounts (type, name) values ($1, $2) returning id", [type, name]))[0].id; const w = (await q("insert into wallets (account_id, display_name, type) values ($1, 'w', 'default') returning id", [a]))[0].id; return { a, w }; };
const M = await acct("B", "Shop"), C1 = await acct("C", "Ann"), C2 = await acct("C", "Bo"), staff = await acct("C", "Sam");
const day = (k: number, hour = 15) => `${addDays(today, -k)} ${hour}:00:00 America/New_York`;
let n = 0;
const tx = (type: string, status: string, from: string, to: string, amount: number, when: string, acc: string) =>
  q(`insert into transactions (type, status, status_code, from_wallet_id, to_wallet_id, amount, account_id, idem, created_at) values ($1, $2, $3, $4, $5, $6, $7, $8, $9::text::timestamptz) returning id`,
    [type, status, status === "declined" ? "insufficient_balance" : null, from, to, amount, acc, "k" + n++, when]).then((r) => r[0].id as string);
await adm.begin(async (t) => {
  await t.unsafe("set local session_replication_role = replica");
  const ins = async (type: string, status: string, from: string, to: string, amount: number, when: string, acc: string) =>
    (await t.unsafe(`insert into transactions (type, status, status_code, from_wallet_id, to_wallet_id, amount, account_id, idem, created_at) values ($1, $2, $3, $4, $5, $6, $7, $8, $9::text::timestamptz) returning id`,
      [type, status, status === "declined" ? "insufficient_balance" : null, from, to, amount, acc, "k" + n++, when] as any))[0].id as string;
  for (const k of [6, 5, 5, 3, 2, 2, 1]) {
    const id = await ins("pay", "completed", C1.w, M.w, 1000 + k, day(k), C1.a);
    if (k % 2 === 0) await t.unsafe("insert into tips (transaction_id, account_id, staff_account_id, amount, created_at) values ($1, $2, $3, 150, $4::text::timestamptz)", [id, M.a, staff.a, day(k)] as any);
  }
  await ins("pay", "declined", C2.w, M.w, 700, day(5), C2.a);
  const rid = await ins("refund", "completed", M.w, C1.w, 400, day(2), M.a);
  await t.unsafe("insert into tips (transaction_id, account_id, staff_account_id, amount, created_at) values ($1, $2, $3, -50, $4::text::timestamptz)", [rid, M.a, staff.a, day(2)] as any);
  await ins("refund", "declined", M.w, C1.w, 99, day(1), M.a);
  await ins("pay", "completed", C1.w, M.w, 555, day(0, 1), C1.a);        // today: live, never in a snapshot
  // another merchant's payment must not leak in
  const O = await acct("B", "Other"); await ins("pay", "completed", C1.w, O.w, 9999, day(3), C1.a);
  // refund requests: always live
  const pid = await ins("pay", "completed", C2.w, M.w, 800, day(4), C2.a);
  await t.unsafe("insert into refunds (merchant_account_id, pay_transaction_id, mode, amount, status, idem, created_at, resolved_at) values ($1, $2, 'partial', 300, 'pending', 'ri1', $3::text::timestamptz, null), ($1, $2, 'partial', 100, 'rejected', 'ri2', $4::text::timestamptz, now())", [M.a, pid, day(0, 2), day(3)] as any);
});
void tx;

// the snapshots: rebuild them for the days above (the marker moves back, then the catch-up writes the days)
await q("update system set value = $1 where key = 'merchant_snapshot_day'", [addDays(today, -8)]);
const made = await catchUpMerchantSnapshots(sql as any, addDays(today, -1));
eq("the catch-up covers the days after the marker through yesterday and moves the marker", [made?.from, made?.to, await merchantSnapshotDay(sql as any)], [addDays(today, -7), addDays(today, -1), addDays(today, -1)]);
eq("a second call does nothing", await catchUpMerchantSnapshots(sql as any, addDays(today, -1)), null);
const rows = await q("select snapshot_date::text d, pay_n::int pn, pay_done_n::int pd, pay_v::int pv, refund_n::int rn, refund_done_n::int rd, refund_v::int rv, tips_n::int tn, tips_v::int tv from merchant_snapshots where merchant_account_id = $1 order by 1", [M.a]);
const by = Object.fromEntries(rows.map((r) => [r.d, r]));
eq("day -5: three payments (one declined), two completed", [by[addDays(today, -5)].pn, by[addDays(today, -5)].pd, by[addDays(today, -5)].pv], [3, 2, 2 * 1005]);
eq("day -2: refund and its returned tip are netted: two tips of 150 (one payment, even days) minus 50", [by[addDays(today, -2)].tn, by[addDays(today, -2)].tv, by[addDays(today, -2)].rn, by[addDays(today, -2)].rv], [2, 250, 1, 400]);
eq("day -1: a declined refund counts as a refund row but not as completed", [by[addDays(today, -1)].rn, by[addDays(today, -1)].rd, by[addDays(today, -1)].rv], [1, 0, 0]);
eq("today and other merchants are not in it", [by[today], rows.length, (await q("select count(*)::int c from merchant_snapshots where merchant_account_id <> $1", [M.a]))[0].c], [undefined, 6, 1]);
eq("a snapshot cannot be changed or deleted", await Promise.all([q("update merchant_snapshots set pay_n = 0").then(() => "ok", (e) => String(e.message)), q("delete from merchant_snapshots").then(() => "ok", (e) => String(e.message))]), ["a merchant snapshot is final", "a merchant snapshot is final"]);
eq("writing a day twice adds nothing", (await q("select app_merchant_snapshot($1::date, $2::date)::int c", [addDays(today, -7), addDays(today, -1)]))[0].c, 0);

// the reader gives the same answer from the snapshots as from a live scan, for every kind of period
const ranges: any[] = [{ from: null, to: null }, { from: addDays(today, -5), to: addDays(today, -2) }, { from: null, to: addDays(today, -3) }, { from: addDays(today, -2), to: null }, { from: today, to: today }, { from: addDays(today, -1), to: today }, { from: addDays(today, -9), to: addDays(today, -7) }, { from: addDays(today, -30), to: addDays(today, 1) }];
const fromSnapshots: any[] = [];
for (const r of ranges) { const x = await merchantTransactions(sql as any, M.a, "all", 20, null, r, true); fromSnapshots.push({ c: x.counts, t: x.totals }); }
const saved = (await q("select value from system where key = 'merchant_snapshot_day'"))[0].value;
await q("delete from system where key = 'merchant_snapshot_day'");
const live: any[] = [];
for (const r of ranges) { const x = await merchantTransactions(sql as any, M.a, "all", 20, null, r, true); live.push({ c: x.counts, t: x.totals }); }
await q("insert into system (key, value) values ('merchant_snapshot_day', $1)", [saved]);
ranges.forEach((r, i) => eq(`counts and totals from snapshots equal a live scan for ${r.from ?? "start"} .. ${r.to ?? "end"}`, fromSnapshots[i], live[i]));
eq("the answer is not trivial: 9 completed payments, 1 completed refund of 400, one pending and one rejected request counted", [live[0].t.payments.count, live[0].t.refunds, live[0].c.pending, live[0].c.refunds], [9, { count: 1, volume: 400 }, 1, 3]);
eq("a page after the first carries no counts", (await merchantTransactions(sql as any, M.a, "all", 5, { ts: new Date().toISOString(), id: "00000000-0000-7000-8000-000000000000" }, ranges[0], false)).counts, null);

console.log(`\n${pass} passed, ${fail} failed`); await sql.end(); await adm.end(); process.exit(fail ? 1 : 0);
