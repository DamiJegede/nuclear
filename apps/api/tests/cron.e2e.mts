import postgres from "postgres";
import app from "../src/index.ts";
import { dailyJobs } from "../src/lib/cron.ts";
import { easternHour } from "../src/lib/ledger.ts";
import { migrate, resetSchema, PG_URL } from "./db.ts";
resetSchema(); migrate();
const adm = postgres(PG_URL, { max: 3, onnotice: () => {} });
const q = async (s: string, p: unknown[] = []) => (await adm.unsafe(s, p as any)) as any[];
const env: any = { HYPERDRIVE: { connectionString: PG_URL }, JWT_SECRET: "x".repeat(40), SANDBOX_FUNDING: "true" };
let pass = 0, fail = 0;
const eq = (l: string, g: unknown, w: unknown) => { const ok = JSON.stringify(g) === JSON.stringify(w); ok ? pass++ : fail++; console.log(ok ? "ok  " : "FAIL", l, ok ? "" : `got ${JSON.stringify(g)} want ${JSON.stringify(w)}`); };
const at = (y: number, m: number, d: number, h: number) => Date.UTC(y, m - 1, d, h, 0);
const local = (ms: number) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(ms));

// ---- which cron run counts as midnight in New York: the two UTC times, across daylight saving
eq("summer (UTC-4): the 04:00 UTC run is midnight, the 05:00 run is 01:00 and does nothing", [easternHour(new Date(at(2026, 7, 15, 4))), easternHour(new Date(at(2026, 7, 15, 5)))], [0, 1]);
eq("winter (UTC-5): the 05:00 UTC run is midnight, the 04:00 run is 23:00 and does nothing", [easternHour(new Date(at(2026, 1, 15, 4))), easternHour(new Date(at(2026, 1, 15, 5)))], [23, 0]);
eq("spring forward, Sunday 8 March 2026: midnight is still EST so the 05:00 run acts; on Monday 9 March (EDT) the 04:00 run acts", [easternHour(new Date(at(2026, 3, 8, 4))), easternHour(new Date(at(2026, 3, 8, 5))), easternHour(new Date(at(2026, 3, 9, 4))), easternHour(new Date(at(2026, 3, 9, 5)))], [23, 0, 0, 1]);
eq("fall back, Sunday 1 November 2026: midnight is still EDT so the 04:00 run acts; on Monday 2 November (EST) the 05:00 run acts", [easternHour(new Date(at(2026, 11, 1, 4))), easternHour(new Date(at(2026, 11, 1, 5))), easternHour(new Date(at(2026, 11, 2, 4))), easternHour(new Date(at(2026, 11, 2, 5)))], [0, 1, 23, 0]);
eq("the instants that act are exactly 00:00 New York time", [local(at(2026, 3, 8, 5)), local(at(2026, 3, 9, 4)), local(at(2026, 11, 1, 4)), local(at(2026, 11, 2, 5))], ["2026-03-08, 00:00", "2026-03-09, 00:00", "2026-11-01, 00:00", "2026-11-02, 00:00"]);
// every day of 2026 and 2027: exactly one of the two runs acts, and each New York date is reset exactly once
const perDate = new Map<string, number>(); let bothOrNeither = 0;
for (let t = at(2026, 1, 2, 0); t < at(2027, 12, 30, 0); t += 86_400_000) {
  const runs = [t + 4 * 3600_000, t + 5 * 3600_000].filter((ms) => easternHour(new Date(ms)) === 0);
  if (runs.length !== 1) bothOrNeither++;
  for (const ms of runs) perDate.set(local(ms).slice(0, 10), (perDate.get(local(ms).slice(0, 10)) ?? 0) + 1);
}
eq("across 2026 and 2027 every day has exactly one acting run, and every New York date is reset once (no skipped or doubled day)", [bothOrNeither, [...perDate.values()].every((n) => n === 1), perDate.size], [0, true, 727]);

// ---- the job itself against a real database
const mk = async (email: string) => (await (await app.fetch(new Request("http://x/v1/auth/signup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "N", email, password: "correct horse battery" }) }), env, { waitUntil() {}, passThroughOnException() {} } as any)).json()) as any;
const ada = await mk("ada@example.com");
await q("update wallets set spent_today = 4200, daily_limit = 5000 where id=$1", [ada.default_wallet_id]);
const wallet = async () => (await q("select spent_today::int s from wallets where id=$1", [ada.default_wallet_id]))[0].s;
const winterNoon = await dailyJobs(at(2026, 1, 15, 4), env);            // 23:00 EST
eq("a run that is not midnight resets nothing", [winterNoon.reset, await wallet()], [false, 4200]);
const summerNoon = await dailyJobs(at(2026, 7, 15, 5), env);            // 01:00 EDT
eq("the 05:00 UTC run in summer resets nothing either", [summerNoon.reset, await wallet()], [false, 4200]);
const acted = await dailyJobs(at(2026, 7, 15, 4), env);                 // 00:00 EDT
eq("the midnight run zeroes spent_today and reports how many wallets it touched", [acted.reset, (acted as any).wallets, await wallet()], [true, 1, 0]);
const again = await dailyJobs(at(2026, 7, 15, 4), env);
eq("running it twice is harmless", [again.reset, (again as any).wallets, await wallet()], [true, 0, 0]);
// the daily limit really does reopen: a wallet at its limit declines, then pays after the reset
const bob = await mk("bob@example.com");
await q("update wallets set daily_limit = 1000, spent_today = 1000 where id=$1", [bob.default_wallet_id]);
await app.fetch(new Request("http://x/v1/sandbox/fundings", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${bob.session_token}`, "idempotency-key": "f" }, body: JSON.stringify({ amount: 5000 }) }), env, { waitUntil() {}, passThroughOnException() {} } as any);
const send = async (key: string) => (await app.fetch(new Request("http://x/v1/transfers", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${bob.session_token}`, "idempotency-key": key }, body: JSON.stringify({ to_wallet_id: ada.default_wallet_id, amount: 100 }) }), env, { waitUntil() {}, passThroughOnException() {} } as any));
const before = await send("limit-1"), beforeJson = await before.json() as any;
await dailyJobs(at(2026, 11, 2, 5), env);                                // 00:00 EST
const after = await send("limit-2");
eq("a wallet at its daily limit is declined, and spends again after the midnight run", [before.status, beforeJson.status_code, after.status], [422, "spend_limit_exceeded", 201]);
// the entry point Cloudflare calls
const worker = (await import("../src/index.ts")).default as any;
await q("update wallets set spent_today = 777 where id=$1", [ada.default_wallet_id]);
let pending: Promise<unknown>[] = [];
await worker.scheduled({ scheduledTime: at(2026, 3, 8, 4), cron: "0 4 * * *" }, env, { waitUntil: (p: Promise<unknown>) => pending.push(p) });
await Promise.all(pending);
eq("scheduled(): the 04:00 UTC run on 8 March (23:00 EST) leaves the counters alone", await wallet(), 777);
pending = [];
await worker.scheduled({ scheduledTime: at(2026, 3, 8, 5), cron: "0 5 * * *" }, env, { waitUntil: (p: Promise<unknown>) => pending.push(p) });
await Promise.all(pending);
eq("scheduled(): the 05:00 UTC run on 8 March (00:00 EST) resets them", await wallet(), 0);
console.log(`\n${pass} passed, ${fail} failed`); await adm.end(); process.exit(fail ? 1 : 0);
