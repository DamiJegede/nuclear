import { ROOT, applyMigration, migrate, psql, resetSchema } from "./db.ts";
import { readFileSync } from "node:fs";
import app from "../src/index.ts";
import { resetDailyCounters } from "../src/lib/ledger.ts";
import { easternDate } from "../src/lib/dailyReset.ts";
import { connect } from "../src/db.ts";

import postgres from "postgres";
const URL = "postgres://postgres@127.0.0.1:54340/nuclear";
const adm = postgres(URL, { max: 2, onnotice: () => {} });
import { execFileSync } from "node:child_process";
psql(["-c", "drop schema public cascade; create schema public;"]);
migrate();
const db = { query: async (q: string, p: unknown[] = []) => ({ rows: await adm.unsafe(q, p as any) }) };
const server = { stop: async () => { await adm.end(); } };

const env: any = {
  HYPERDRIVE: { connectionString: "postgres://postgres@127.0.0.1:54340/nuclear" },
  JWT_SECRET: "test-secret-test-secret-test-secret!",
  SANDBOX_FUNDING: "true",
  DAILY_VALUE_CAP_CENTS: "500000",
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
const signup = async (name: string, email: string, type = "C") =>
  (await call("POST", "/v1/auth/signup", { body: { name, email, password: "correct horse battery", type } })).json;

const ada = await signup("Ada", "ada@example.com");
const bob = await signup("Bob", "bob@example.com");
const shop = await signup("Shop", "shop@example.com", "B");
const A = ada.session_token, B = bob.session_token;

// --- handles
const setH = (token: string, handle: unknown) => call("PUT", "/v1/account/handle", { token, body: { handle } });
eq("signup has no handle", [ada.handle, (await call("GET", "/v1/account", { token: A })).json.handle], [undefined, null]);
eq("resolver 404 before handle set", (await call("GET", "/v1/handles/ada01", { token: B })).status, 404);
eq("set handle", (await setH(A, "  ADA01 ")).json.handle, "ada01");
eq("profile shows handle", (await call("GET", "/v1/account", { token: A })).json.handle, "ada01");
eq("set same handle is idempotent", (await setH(A, "ada01")).status, 200);
eq("duplicate handle (case-insens) 409", (await setH(B, "ADA01")).json.error, "handle_taken");
for (const [h, label] of [["abc", "3 chars"], ["abcdefghijklm", "13 chars"], ["ab_cd", "underscore"], ["ab cd", "space"], ["añadir", "non-ascii"], ["admin", "reserved"], ["", "empty"], [123456, "number"]] as const) {
  eq(`handle rejected: ${label}`, (await setH(B, h)).status, 400);
}
eq("4 and 12 chars accepted", [(await setH(B, "abcd")).status, (await setH(B, "abcdefghij12")).status], [200, 200]);
eq("handle can be changed by primary account", (await setH(B, "bob01")).json.handle, "bob01");
eq("old handle released and resolvable by others", (await setH(A, "abcd")).status, 200);
await setH(A, "ada01");
eq("set needs session", (await call("PUT", "/v1/account/handle", { body: { handle: "nope1234" } })).status, 401);
await setH(shop.session_token, "shop01");
const res = await call("GET", "/v1/handles/ADA01", { token: B });
eq("resolver returns ids", [res.status, res.json.account_id, res.json.wallet_id, res.json.handle], [200, ada.account_id, ada.default_wallet_id, "ada01"]);
eq("resolver old handle gone", (await call("GET", "/v1/handles/abcdefghij12", { token: B })).status, 404);
eq("resolver unknown 404", (await call("GET", "/v1/handles/nobody77", { token: B })).status, 404);
eq("resolver invalid 404", (await call("GET", "/v1/handles/a!", { token: B })).status, 404);
eq("resolver needs session", (await call("GET", "/v1/handles/ada01")).status, 401);
eq("resolver business visible", (await call("GET", "/v1/handles/shop01", { token: B })).json.type, "B");
eq("resolver result is sendable", (await call("POST", "/v1/transfers", { token: B, key: "h-1", body: { to_wallet_id: res.json.wallet_id, amount: 1 } })).json.status_code, "insufficient_balance");
// delegated wallet sessions can never have or change handles
const hk = await call("POST", "/v1/wallets", { token: A, body: { display_name: "H", type: "person" } });
const hl = await call("POST", `/v1/wallets/${hk.json.wallet.id}/links`, { token: A });
const hs = (await call("POST", "/v1/devices/redeem", { body: { token: hl.json.url.split("/magic-link/")[1] } })).json.session_token;
eq("delegated cannot set handle", (await setH(hs, "hijack01")).status, 403);
eq("delegated cannot read profile", (await call("GET", "/v1/account", { token: hs })).status, 403);
eq("handle unchanged", (await call("GET", "/v1/account", { token: A })).json.handle, "ada01");
const plan = (await adm.unsafe("set enable_seqscan=off")) && (await db.query("explain select id from accounts where handle = 'ada01'")).rows.map((r: any) => r["QUERY PLAN"]).join(" ");
eq("handle lookup uses unique index", /accounts_handle_key/.test(plan), true);

// --- wallets
const mk = await call("POST", "/v1/wallets", { token: A, body: { display_name: "Kid", type: "person", daily_limit: 2000, allow_send: true } });
eq("create wallet 201", mk.status, 201);
eq("new wallet limit", mk.json.wallet.daily_limit, 2000);
eq("default type rejected", (await call("POST", "/v1/wallets", { token: A, body: { display_name: "x", type: "default" } })).status, 400);
const kid = mk.json.wallet.id;
eq("list wallets (default + handle-test + kid)", (await call("GET", "/v1/wallets", { token: A })).json.wallets.length, 3);
eq("other account cannot read wallet", (await call("GET", `/v1/wallets/${kid}`, { token: B })).status, 404);
eq("other account cannot patch", (await call("PATCH", `/v1/wallets/${kid}`, { token: B, body: { allow_send: false } })).status, 404);
eq("empty patch 400", (await call("PATCH", `/v1/wallets/${kid}`, { token: A, body: {} })).status, 400);
const pt = await call("PATCH", `/v1/wallets/${kid}`, { token: A, body: { display_name: "Kiddo", daily_limit: null } });
eq("patch name + clear limit", [pt.json.wallet.display_name, pt.json.wallet.daily_limit], ["Kiddo", null]);
await call("PATCH", `/v1/wallets/${kid}`, { token: A, body: { daily_limit: 2000 } });

// --- funding (sandbox)
const f1 = await call("POST", "/v1/sandbox/fundings", { token: A, key: "f-1", body: { amount: 10000 } });
eq("fund 201", f1.status, 201);
eq("fund replay 200 same id", (await call("POST", "/v1/sandbox/fundings", { token: A, key: "f-1", body: { amount: 10000 } })).json.funding.id, f1.json.funding.id);
eq("fund mismatch 409", (await call("POST", "/v1/sandbox/fundings", { token: A, key: "f-1", body: { amount: 5 } })).status, 409);
eq("balance after fund", (await call("GET", "/v1/balance", { token: A })).json.available_to_send, 10000);
eq("funding needs key", (await call("POST", "/v1/sandbox/fundings", { token: A, body: { amount: 5 } })).status, 400);

// --- send
const bobDefault = bob.default_wallet_id, adaDefault = ada.default_wallet_id;
const s1 = await call("POST", "/v1/transfers", { token: A, key: "s-1", body: { to_wallet_id: bobDefault, amount: 2500 } });
eq("send 201", [s1.status, s1.json.transaction.status, s1.json.transaction.direction], [201, "completed", "out"]);
eq("sender balance", (await call("GET", "/v1/balance", { token: A })).json.balance, 7500);
eq("recipient balance", (await call("GET", "/v1/balance", { token: B })).json.balance, 2500);
const s1r = await call("POST", "/v1/transfers", { token: A, key: "s-1", body: { to_wallet_id: bobDefault, amount: 2500 } });
eq("replay 200 same tx, no double debit", [s1r.status, s1r.json.transaction.id, (await call("GET", "/v1/balance", { token: A })).json.balance], [200, s1.json.transaction.id, 7500]);
eq("idempotency mismatch 409", (await call("POST", "/v1/transfers", { token: A, key: "s-1", body: { to_wallet_id: bobDefault, amount: 9 } })).status, 409);
eq("needs idempotency key", (await call("POST", "/v1/transfers", { token: A, body: { to_wallet_id: bobDefault, amount: 1 } })).status, 400);
eq("amount 0 rejected", (await call("POST", "/v1/transfers", { token: A, key: "z", body: { to_wallet_id: bobDefault, amount: 0 } })).status, 400);
eq("negative rejected", (await call("POST", "/v1/transfers", { token: A, key: "z2", body: { to_wallet_id: bobDefault, amount: -5 } })).status, 400);
eq("fractional rejected", (await call("POST", "/v1/transfers", { token: A, key: "z3", body: { to_wallet_id: bobDefault, amount: 1.5 } })).status, 400);
eq("self wallet 422", (await call("POST", "/v1/transfers", { token: A, key: "z4", body: { to_wallet_id: adaDefault, amount: 1 } })).json.error, "same_wallet");
eq("same account 422", (await call("POST", "/v1/transfers", { token: A, key: "z5", body: { to_wallet_id: kid, amount: 1 } })).json.error, "same_account");
eq("business recipient 422", (await call("POST", "/v1/transfers", { token: A, key: "z6", body: { to_wallet_id: shop.default_wallet_id, amount: 1 } })).json.error, "recipient_not_eligible");
eq("unknown recipient 404", (await call("POST", "/v1/transfers", { token: A, key: "z7", body: { to_wallet_id: "0190aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee", amount: 1 } })).status, 404);
eq("foreign from_wallet 404", (await call("POST", "/v1/transfers", { token: A, key: "z8", body: { from_wallet_id: bobDefault, to_wallet_id: kid, amount: 1 } })).status, 404);

const big = await call("POST", "/v1/transfers", { token: A, key: "s-big", body: { to_wallet_id: bobDefault, amount: 999999 } });
eq("insufficient 422 recorded failed", [big.status, big.json.status_code, big.json.transaction.status], [422, "insufficient_balance", "failed"]);
eq("failed send moved nothing", (await call("GET", "/v1/balance", { token: A })).json.balance, 7500);
eq("failed replay stays declined", (await call("POST", "/v1/transfers", { token: A, key: "s-big", body: { to_wallet_id: bobDefault, amount: 999999 } })).status, 422);

// --- delegated session (kid wallet)
const link = await call("POST", `/v1/wallets/${kid}/links`, { token: A });
const red = await call("POST", "/v1/devices/redeem", { body: { token: link.json.url.split("/magic-link/")[1] } });
const K = red.json.session_token;
eq("delegated sees only its wallet", (await call("GET", "/v1/wallets", { token: K })).json.wallets.map((w: any) => w.id), [kid]);
eq("delegated balance hides credit", Object.keys((await call("GET", "/v1/balance", { token: K })).json).sort(), ["available_to_pay", "available_to_send", "restricted"]);
eq("delegated cannot create wallet", (await call("POST", "/v1/wallets", { token: K, body: { display_name: "x", type: "person" } })).status, 403);
eq("delegated cannot patch", (await call("PATCH", `/v1/wallets/${kid}`, { token: K, body: { daily_limit: 99999 } })).status, 403);
eq("delegated cannot fund", (await call("POST", "/v1/sandbox/fundings", { token: K, key: "kf", body: { amount: 5 } })).status, 403);
eq("delegated cannot send from owner wallet", (await call("POST", "/v1/transfers", { token: K, key: "k0", body: { from_wallet_id: adaDefault, to_wallet_id: bobDefault, amount: 1 } })).status, 404);
const k1 = await call("POST", "/v1/transfers", { token: K, key: "k1", body: { to_wallet_id: bobDefault, amount: 1500 } });
eq("delegated send ok (default from)", k1.json.transaction.status, "completed");
const k2 = await call("POST", "/v1/transfers", { token: K, key: "k2", body: { to_wallet_id: bobDefault, amount: 600 } });
eq("wallet daily limit enforced", [k2.status, k2.json.status_code], [422, "spend_limit_exceeded"]);
eq("remaining_today", (await call("GET", `/v1/wallets/${kid}`, { token: K })).json.wallet.remaining_today, 500);
eq("delegated sees send in activity", (await call("GET", "/v1/activity", { token: K })).json.items.some((i: any) => i.id === k1.json.transaction.id), true);
eq("delegated does not see owner send", (await call("GET", "/v1/activity", { token: K })).json.items.some((i: any) => i.id === s1.json.transaction.id), false);
eq("delegated cannot read others' transfer", (await call("GET", `/v1/transfers/${s1.json.transaction.id}`, { token: K })).status, 404);

// send disabled on wallet
await call("PATCH", `/v1/wallets/${kid}`, { token: A, body: { allow_send: false } });
eq("allow_send=false declined", (await call("POST", "/v1/transfers", { token: K, key: "k3", body: { to_wallet_id: bobDefault, amount: 100 } })).json.status_code, "send_not_allowed");
await call("PATCH", `/v1/wallets/${kid}`, { token: A, body: { allow_send: true } });

// --- reset job
const sqlc = connect(env);
eq("reset clears spent_today", (await resetDailyCounters(sqlc)).wallets >= 1, true);
eq("limit usable again", (await call("POST", "/v1/transfers", { token: K, key: "k4", body: { to_wallet_id: bobDefault, amount: 600 } })).json.transaction.status, "completed");
eq("program date: 05:00 UTC in winter is the start of that New York day", easternDate(new Date("2026-01-15T05:00:00Z")), "2026-01-15");
eq("program date: 04:00 UTC in summer is the start of that New York day", easternDate(new Date("2026-07-15T04:00:00Z")), "2026-07-15");
await sqlc.end();

// --- recipient daily-value headroom (cap 5000.00 => 500000c)
const rich = await signup("Rich", "rich@example.com");
env.DAILY_VALUE_CAP_CENTS = "5000";
await call("POST", "/v1/sandbox/fundings", { token: rich.session_token, key: "r1", body: { amount: 4000 } });
const cap = await call("POST", "/v1/sandbox/fundings", { token: rich.session_token, key: "r2", body: { amount: 2000 } });
eq("funding over daily cap declined", [cap.status, cap.json.status_code], [422, "daily_value_limit_exceeded"]);
const rc = await call("POST", "/v1/transfers", { token: A, key: "rc", body: { to_wallet_id: rich.default_wallet_id, amount: 2000 } });
eq("recipient headroom enforced", [rc.status, rc.json.status_code], [422, "recipient_limit_exceeded"]);
env.DAILY_VALUE_CAP_CENTS = "500000";

// --- concurrency: 8 parallel sends of 2000 from a 7500-ish balance => never overdraw
const before = (await call("GET", "/v1/balance", { token: A })).json.balance;
const results = await Promise.all(Array.from({ length: 8 }, (_, i) =>
  call("POST", "/v1/transfers", { token: A, key: `par-${i}`, body: { to_wallet_id: bobDefault, amount: 2000 } })));
const okCount = results.filter((r) => r.status === 201).length;
const after = (await call("GET", "/v1/balance", { token: A })).json.balance;
eq("parallel: balance = before - ok*2000 and >= 0", [after, after >= 0, before - okCount * 2000], [before - okCount * 2000, true, after]);
eq("parallel: ok count matches funds", okCount, Math.floor(before / 2000));

// --- parallel duplicate idempotency key => exactly one debit
const b2 = (await call("GET", "/v1/balance", { token: A })).json.balance;
const dup = await Promise.all(Array.from({ length: 5 }, () =>
  call("POST", "/v1/transfers", { token: A, key: "dup-1", body: { to_wallet_id: bobDefault, amount: 100 } })));
eq("parallel duplicate key: single debit", [(await call("GET", "/v1/balance", { token: A })).json.balance, new Set(dup.map((d) => d.json.transaction?.id)).size], [Math.max(b2 - 100, b2 - 100), 1]);

// --- ledger integrity: every posting balances; ledger matches balances table
const lg = await db.query(`select coalesce(sum(case direction when 'debit' then amount else -amount end),0)::int net from ledger_entries`);
eq("ledger nets to zero overall", lg.rows[0].net, 0);
const recon = await db.query(`
  select b.account_id, b.balance,
    coalesce((select sum(case direction when 'credit' then amount else -amount end)
                from ledger_entries l where l.account_id = b.account_id and l.bucket = 'funded_balance'),0)::bigint as ledger
  from balances b`);
eq("balances == ledger funded_balance per account", recon.rows.filter((r: any) => BigInt(r.balance) !== BigInt(r.ledger)).length, 0);

// --- activity + pagination
const p1 = await call("GET", "/v1/activity?limit=3", { token: A });
eq("page1 size", p1.json.items.length, 3);
const seen = new Set(p1.json.items.map((i: any) => i.id));
let cur = p1.json.next_cursor, pages = 1, dupSeen = false;
while (cur && pages < 30) {
  const pn = await call("GET", `/v1/activity?limit=3&cursor=${encodeURIComponent(cur)}`, { token: A });
  for (const it of pn.json.items) { if (seen.has(it.id)) dupSeen = true; seen.add(it.id); }
  cur = pn.json.next_cursor; pages++;
}
const total = (await db.query(`select (select count(*) from transactions where from_account_id=$1 or to_account_id=$1)::int
   + (select count(*) from fundings where account_id=$1 and transaction_id is null)::int n`, [ada.account_id])).rows[0].n;
eq("pagination: no dupes, covers all", [dupSeen, seen.size], [false, total]);
const all100 = (await call("GET", "/v1/activity?limit=100", { token: A })).json.items;
{ let c2: string|null = null; for (let k=0;k<6;k++){ const r = await call("GET", `/v1/activity?limit=3${c2?`&cursor=${encodeURIComponent(c2)}`:""}`, { token: A }); console.log("PAGE", k, JSON.stringify(r.json.items.map((i:any)=>i.id.slice(-4))), "next:", r.json.next_cursor); c2 = r.json.next_cursor; if(!c2) break; } }
console.log("DEBUG all:", all100.map((i:any)=>i.timestamp.slice(17)+"|"+i.id.slice(-4)).join(" "));
console.log("DEBUG limit100:", all100.length, "paged:", seen.size, "pages:", pages, "total:", total);
eq("bad cursor 400", (await call("GET", "/v1/activity?cursor=garbage", { token: A })).status, 400);
const failedItem = (await call("GET", "/v1/activity?limit=100", { token: A })).json.items.find((i: any) => i.status === "failed");
eq("failed item visible with code", typeof failedItem?.status_code, "string");
eq("counterparty name present", (await call("GET", "/v1/activity?limit=100", { token: A })).json.items.find((i: any) => i.id === s1.json.transaction.id).counterparty.display_name, "Bob");

// --- lookup
eq("lookup by email", (await call("POST", "/v1/recipients/lookup", { token: A, body: { email: "BOB@example.com" } })).json.wallet_id, bobDefault);
eq("lookup business 404", (await call("POST", "/v1/recipients/lookup", { token: A, body: { email: "shop@example.com" } })).status, 404);
eq("lookup self 404", (await call("POST", "/v1/recipients/lookup", { token: A, body: { email: "ada@example.com" } })).status, 404);

// --- suspend / close
await call("PATCH", `/v1/wallets/${bobDefault}`, { token: B, body: { status: "suspended" } });
eq("suspended recipient declined", (await call("POST", "/v1/transfers", { token: A, key: "sus", body: { to_wallet_id: bobDefault, amount: 10 } })).json.status_code, "recipient_unavailable");
eq("owner login unaffected by default-wallet suspension", (await call("GET", "/v1/wallets", { token: B })).status, 200);
eq("default wallet cannot close", (await call("PATCH", `/v1/wallets/${adaDefault}`, { token: A, body: { status: "closed" } })).status, 409);
const cl = await call("PATCH", `/v1/wallets/${kid}`, { token: A, body: { status: "closed" } });
eq("close wallet", cl.json.wallet.status, "closed");
eq("closed wallet revokes sessions", (await call("POST", "/v1/devices/session/extend", { token: K })).status, 401);
eq("closed is terminal", (await call("PATCH", `/v1/wallets/${kid}`, { token: A, body: { status: "active" } })).status, 409);
eq("closed wallet link 404", (await call("POST", `/v1/wallets/${kid}/links`, { token: A })).status, 404);

// --- feature flag
env.SANDBOX_FUNDING = "false";
eq("sandbox off => 404", (await call("POST", "/v1/sandbox/fundings", { token: A, key: "off", body: { amount: 1 } })).status, 404);

console.log(`\n${pass} passed, ${fail} failed`);
await server.stop();
process.exit(fail ? 1 : 0);
