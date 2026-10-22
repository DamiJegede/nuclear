import { writeFileSync } from "node:fs";
process.on("uncaughtException", (e: any) => { writeFileSync("/tmp/ben.err", String(e?.stack ?? e)); process.exit(1); });
process.on("unhandledRejection", (e: any) => { writeFileSync("/tmp/ben.err", String(e?.stack ?? e)); process.exit(1); });
import { randomBytes } from "node:crypto";
import postgres from "postgres";
import app from "../src/index.ts";
import { migrate, resetSchema, PG_URL } from "./db.ts";
resetSchema(); migrate();
const adm = postgres(PG_URL, { max: 4, onnotice: () => {} });
const q = async (s: string, p: unknown[] = []) => (await adm.unsafe(s, p as any)) as any[];
const OP = "op-" + randomBytes(16).toString("hex");
const mails: { to: string; text: string }[] = [];
const env: any = { HYPERDRIVE: { connectionString: PG_URL }, JWT_SECRET: "x".repeat(40), ADMIN_API_TOKEN: OP, SANDBOX_FUNDING: "true", APP_URL: "https://app.test", EMAIL_FROM: "n <n@test>", EMAIL: { send: async (m: any) => { if (m.subject !== "Verify your email for Nuclear") mails.push(m); } } };
const ctx: any = { waitUntil: (p: Promise<unknown>) => void p.catch(() => {}), passThroughOnException() {} };
let pass = 0, fail = 0;
const eq = (l: string, g: unknown, w: unknown) => { const ok = JSON.stringify(g) === JSON.stringify(w); ok ? pass++ : fail++; console.log(ok ? "ok  " : "FAIL", l, ok ? "" : `got ${JSON.stringify(g)} want ${JSON.stringify(w)}`); };
const call = async (m: string, p: string, o: { body?: unknown; token?: string; key?: string } = {}) => {
  const r = await app.fetch(new Request("http://x" + p, { method: m, headers: { "content-type": "application/json", ...(o.token ? { authorization: `Bearer ${o.token}` } : {}), ...(o.key ? { "idempotency-key": o.key } : {}) }, body: o.body === undefined ? undefined : JSON.stringify(o.body) }), env, ctx);
  const t = await r.text(); return { status: r.status, json: t ? JSON.parse(t) : null };
};
const sign = async (name: string, email: string, type = "C") => (await call("POST", "/v1/auth/signup", { body: { type, name, email, password: "correct horse battery" } })).json;
const fund = (p: any, amount: number, key: string) => call("POST", "/v1/sandbox/fundings", { token: p.session_token, key, body: { amount } });
const balance = async (p: any) => (await call("GET", "/v1/balance", { token: p.session_token })).json;
const wallets = async (p: any) => (await call("GET", "/v1/wallets", { token: p.session_token })).json.wallets as any[];
const defaultWallet = async (p: any) => (await wallets(p)).find((w) => w.type === "default").id as string;
const benefitsWallets = async (p: any) => (await wallets(p)).filter((w) => w.type === "benefits");
const move = (p: any, from: string, to: string, amount: number, key: string) => call("POST", "/v1/wallets/move", { token: p.session_token, key, body: { from_wallet_id: from, to_wallet_id: to, amount } });
const pay = (p: any, body: object, key: string) => call("POST", "/v1/payments", { token: p.session_token, key, body });
const batch = (o: any, rows: any[], key: string) => call("POST", "/v1/org/benefit-runs", { token: o.session_token, key, body: { rows } });
const claim = (p: any, token: string) => call("POST", "/v1/employee/claims", { token: p.session_token, body: { token } });
const tokenOf = (to: string) => decodeURIComponent(mails.filter((m) => m.to === to).at(-1)!.text.match(/claim\?token=([^\s]+)/)![1]);
const reconciled = async () => (await call("GET", "/v1/admin/stats", { token: OP })).json.reconciliation;
// Make everything an account has done so far belong to an earlier program day (the ledger is append-only, so its triggers are lifted for the test).
const earlier = async (accountId: string, days = 2) => {
  await q("alter table ledger_entries disable trigger ledger_entries_no_update");
  await q(`update ledger_entries set created_at = created_at - interval '${days} days' where account_id = $1`, [accountId]);
  await q("alter table ledger_entries enable trigger ledger_entries_no_update");
  await q(`update transactions set "timestamp" = "timestamp" - interval '${days} days', completed_at = completed_at - interval '${days} days' where from_account_id = $1 or to_account_id = $1`, [accountId]);
  await q(`update fundings set created_at = created_at - interval '${days} days', released_at = released_at - interval '${days} days' where account_id = $1`, [accountId]);
  // ... and it is a new program day: what the account holds now is its opening value, with nothing added yet (what ensureDay does for everyone)
  await q("update balances set ordinary_opening = balance - coalesce((select sum(balance) from wallets where account_id = $1 and type = 'benefits'), 0), added_today = 0, opening_day = (now() at time zone 'America/New_York')::date where account_id = $1", [accountId]);
};

const bankroll = async (accountId: string, cents: number) => q(`do $$ declare bank uuid; fid uuid; tid uuid; begin
  insert into bank_accounts (account_id, routing_number, account_number, last4) values ('${accountId}', 'SANDBOX', 'SANDBOX', '0000') returning id into bank;
  insert into fundings (account_id, bank_account_id, amount, idempotency_key, status) values ('${accountId}', bank, ${cents}, 'bk-' || gen_random_uuid(), 'created') returning id into fid;
  insert into transactions (type, from_account_id, to_account_id, from_bank_account_id, amount, status, idempotency_key, completed_at) values ('fund', '${accountId}', '${accountId}', bank, ${cents}, 'completed', 'bk-' || gen_random_uuid(), now()) returning id into tid;
  update balances set balance = balance + ${cents} where account_id = '${accountId}';
  insert into ledger_entries (funding_id, posting_key, line_no, account_id, bucket, direction, amount) values (fid, 'release', 1, null, 'bank_settlement', 'debit', ${cents}), (fid, 'release', 2, '${accountId}', 'funded_balance', 'credit', ${cents});
  update fundings set status = 'completed', released_at = now(), transaction_id = tid where id = fid; end $$`);
const acme = await sign("Acme", "hr@acme.test", "O");
const other = await sign("Globex", "hr@globex.test", "O");
const shop = await sign("Shop", "shop@x.test", "B");
await q("update accounts set status='active' where id=$1", [shop.account_id]);
const term = (await call("POST", "/v1/terminals", { token: shop.session_token, body: { name: "T", allow_refunds: true } })).json;
const termId = term.terminal.id, termTok = term.session_token;
// Organizations hold more than the daily load cap allows through the API, so their wallets are funded directly (a completed funding with its ledger lines).
await bankroll(acme.account_id, 5_000_000); await bankroll(other.account_id, 5_000_000);   // $50,000 each
// ---- 1. claims create the employer-bound Benefits wallet
const newbie = await sign("Nora New", "nora@x.test");                       // no money of her own
const vet = await sign("Vic Veteran", "vic@x.test");                        // already a user with ordinary funds
await fund(vet, 100_000, "f-vet");
const rows = [
  { employee_id: "E1", name: "Nora New", email: "nora@x.test", amount: 700_000 },
  { employee_id: "E2", name: "Vic Veteran", email: "vic@x.test", amount: 300_000 },
];
const b1 = await batch(acme, rows, "b1");
eq("batch: nothing lands in an ordinary wallet before the employee claims; no wallets exist yet", [b1.status, (await benefitsWallets(newbie)).length, (await balance(newbie)).balance], [201, 0, 0]);
const c1 = await claim(newbie, tokenOf("nora@x.test"));
eq("claim: a new user gets an employer-bound Benefits wallet holding the credit", [c1.status, c1.json.claimed, c1.json.wallet.type, c1.json.wallet.balance, c1.json.wallet.display_name], [200, 700_000, "benefits", 700_000, "Acme Benefits"]);
const nb = (await benefitsWallets(newbie))[0];
eq("claim: the wallet shows its employer and real funded amount; sends are switched off", [nb.organization.name, nb.balance, nb.allow_send, nb.earmarked], ["Acme", 700_000, false, true]);
const c2 = await claim(vet, tokenOf("vic@x.test"));
const vb = (await benefitsWallets(vet))[0];
eq("claim: an existing user gets a separate Benefits wallet; ordinary money is untouched", [c2.status, vb.balance, (await balance(vet)).ordinary, (await balance(vet)).balance], [200, 300_000, 100_000, 400_000]);
eq("claim: replaying a used token never creates another wallet or moves money again", [(await claim(vet, tokenOf("vic@x.test"))).status, (await benefitsWallets(vet)).length, (await balance(vet)).balance], [404, 1, 400_000]);
// later credits go to the Benefits wallet, not the default wallet
const b2 = await batch(acme, [{ employee_id: "E2", name: "Vic Veteran", email: "vic@x.test", amount: 50_000 }], "b2");
eq("batch: later credits from the same employer go to the same Benefits wallet", [b2.status, (await benefitsWallets(vet)).length, (await benefitsWallets(vet))[0].balance, (await balance(vet)).ordinary], [201, 1, 350_000, 100_000]);
// two employee records of one consumer for one employer reuse one wallet
await q("insert into employees (org_account_id, employee_account_id, employee_id, name, email) values ($1, $2, 'E9', 'Vic Second', 'vic2@x.test')", [acme.account_id, vet.account_id]);
await batch(acme, [{ employee_id: "E9", name: "Vic Second", email: "vic2@x.test", amount: 10_000 }], "b3");
eq("batch: two records of the same account and employer share one Benefits wallet", [(await benefitsWallets(vet)).length, (await benefitsWallets(vet))[0].balance], [1, 360_000]);
// a second employer gets its own wallet
await batch(other, [{ employee_id: "G1", name: "Vic Veteran", email: "vic@x.test", amount: 20_000 }], "g1");
await claim(vet, tokenOf("vic@x.test"));
eq("claim: a different employer gets its own Benefits wallet", (await benefitsWallets(vet)).map((w) => [w.organization.name, w.balance]).sort(), [["Acme", 360_000], ["Globex", 20_000]]);
// legacy: an already-linked employee without a Benefits wallet keeps old money in place and gets a wallet at the next credit
const legacy = await sign("Lee Legacy", "lee@x.test");
await fund(legacy, 50_000, "f-lee");
await q("insert into employees (org_account_id, employee_account_id, employee_id, name, email) values ($1, $2, 'L1', 'Lee Legacy', 'lee@x.test')", [acme.account_id, legacy.account_id]);
eq("legacy: no Benefits wallet and nothing reclassified before the next credit", [(await benefitsWallets(legacy)).length, (await balance(legacy)).balance], [0, 50_000]);
await batch(acme, [{ employee_id: "L1", name: "Lee Legacy", email: "lee@x.test", amount: 20_000 }], "l1");
eq("legacy: the next credit creates the wallet; older ordinary money stays ordinary", [(await benefitsWallets(legacy))[0].balance, (await balance(legacy)).ordinary, (await balance(legacy)).benefits], [20_000, 50_000, 20_000]);

// ---- 2. totals and who can spend what
const nbal = await balance(newbie);
eq("balances: the total includes Benefits; the breakdown separates the compartments", [nbal.balance, nbal.benefits, nbal.ordinary, nbal.ordinary_shared_available], [700_000, 700_000, 0, 0]);
await fund(newbie, 100_000, "f-nora");
const nb2 = await balance(newbie);
eq("balances: $7,000 Benefits + $1,000 ordinary shows $8,000 total, $1,000 usable by ordinary wallets", [nb2.balance, nb2.benefits, nb2.ordinary, nb2.ordinary_shared_available], [800_000, 700_000, 100_000, 100_000]);
const dw = await defaultWallet(newbie);
eq("pay: an ordinary wallet can spend only the ordinary $1,000, never Benefits", [(await pay(newbie, { terminal_id: termId, amount: 150_000, from_wallet_id: dw }, "p-ord-big")).json.status_code, (await pay(newbie, { terminal_id: termId, amount: 100_000, from_wallet_id: dw }, "p-ord")).status], ["insufficient_balance", 201]);
eq("pay: a Benefits wallet pays a merchant from its own money only", [(await pay(newbie, { terminal_id: termId, amount: 20_000, from_wallet_id: nb.id }, "p-ben")).status, (await benefitsWallets(newbie))[0].balance, (await balance(newbie)).ordinary], [201, 680_000, 0]);
eq("pay: a Benefits wallet cannot exceed its balance or draw ordinary money or credit", (await pay(newbie, { terminal_id: termId, amount: 700_000, from_wallet_id: nb.id }, "p-ben-big")).json.status_code, "wallet_balance_exceeded");
eq("ledger: Benefits postings are attributed to their wallet and every compartment reconciles", [(await reconciled()).balances_match_ledger, (await reconciled()).benefits_match_ledger, (await reconciled()).ledger_balanced], [true, true, true]);

// ---- 3. moves: preserve the total, consume headroom once
const kid = (await call("POST", "/v1/wallets", { token: vet.session_token, body: { display_name: "Kid", type: "person", balance: 0 } })).json.wallet;
const vdw = await defaultWallet(vet);
const vacme = (await benefitsWallets(vet)).find((w) => w.organization.name === "Acme");
const before = await balance(vet);
const m1 = await move(vet, vacme.id, vdw, 30_000, "mv-1");
const after = await balance(vet);
eq("move: to an unearmarked wallet keeps the account total and shifts money to the shared funds", [m1.status, after.balance, after.benefits, after.ordinary_shared_available], [201, before.balance, before.benefits - 30_000, before.ordinary_shared_available + 30_000]);
const m2 = await move(vet, vacme.id, kid.id, 20_000, "mv-2");
eq("move: to an earmarked wallet raises its earmark", [m2.status, (await wallets(vet)).find((w) => w.id === kid.id).balance], [201, 20_000]);
eq("move: a retry replays; the same key with a changed amount or destination is a mismatch", [(await move(vet, vacme.id, vdw, 30_000, "mv-1")).status, (await move(vet, vacme.id, vdw, 31_000, "mv-1")).json.error, (await move(vet, vacme.id, kid.id, 30_000, "mv-1")).json.error, (await balance(vet)).benefits], [200, "idempotency_mismatch", "idempotency_mismatch", after.benefits - 20_000]);
eq("move: books reconcile and the ledger balances", [(await reconciled()).ledger_balanced, (await reconciled()).benefits_match_ledger, (await reconciled()).balances_match_ledger], [true, true, true]);

// ---- 4. headroom: opening value + additions, exact cap, one cent over, simultaneous, rollover
const hana = await sign("Hana Headroom", "hana@x.test");
await batch(acme, [{ employee_id: "H1", name: "Hana Headroom", email: "hana@x.test", amount: 900_000 }], "h1");
await claim(hana, tokenOf("hana@x.test"));
await fund(hana, 150_000, "f-hana");                          // $1,500 ordinary
await earlier(hana.account_id);                               // ... which she already held when today began
const hb = (await benefitsWallets(hana))[0], hdw = await defaultWallet(hana);
// spend $1,000 from ordinary today
await pay(hana, { terminal_id: termId, amount: 100_000, from_wallet_id: hdw }, "h-spend");
const hh = (await balance(hana));
eq("headroom: opening $1,500, $1,000 spent -> $500 of room (spending does not restore it)", [hh.ordinary, hh.daily_headroom], [50_000, 50_000]);
const over = await move(hana, hb.id, hdw, 50_001, "h-over");
eq("headroom: one cent over is declined, recorded, and moves nothing", [over.status, over.json.status_code, (await benefitsWallets(hana))[0].balance, (await q("select status, status_code from transactions where type='move' and idempotency_key='h-over'"))[0]], [422, "daily_value_limit_exceeded", 900_000, { status: "failed", status_code: "daily_value_limit_exceeded" }]);
const [a, b] = await Promise.all([move(hana, hb.id, hdw, 40_000, "h-sim-1"), move(hana, hb.id, hdw, 40_000, "h-sim-2")]);
eq("headroom: two simultaneous $400 moves cannot both succeed", [[a.status, b.status].sort(), (await balance(hana)).daily_headroom], [[201, 422], 10_000]);
const hkid = (await call("POST", "/v1/wallets", { token: hana.session_token, body: { display_name: "K2", type: "person", balance: 0 } })).json.wallet;
eq("headroom: the allowance is account-wide, not per destination wallet (exact cap passes, the next cent fails)", [(await move(hana, hb.id, hkid.id, 10_000, "h-exact")).status, (await move(hana, hb.id, hdw, 1, "h-cent")).json.status_code, (await balance(hana)).daily_headroom], [201, "daily_value_limit_exceeded", 0]);
eq("headroom: moves, loads and incoming sends share ONE rule: with $1,500 held at the start of the day and $500 moved in, there is no room left for a load", [(await fund(hana, 150_001, "f-h2")).status, (await fund(hana, 1, "f-h3")).status, (await balance(hana)).daily_headroom], [422, 422, 0]);
// next program day: the move and the spending become history, and the actual ordinary funds are the new opening value
await earlier(hana.account_id, 2);
const next = await balance(hana);
eq("headroom: rollover carries the actual ordinary value as the new opening value", [next.ordinary, next.daily_headroom], [next.ordinary, Math.max(0, 200_000 - next.ordinary)]);

// ---- 5. nothing else can put money into, or take money out of, a Benefits wallet
const outsider = await sign("Out Sider", "out@x.test");
const ow = await defaultWallet(outsider);
const nbw = (await benefitsWallets(newbie))[0];
const agent = (await call("POST", "/v1/wallets", { token: vet.session_token, body: { display_name: "Bot", type: "agent", balance: 0 } })).json;
const vglobex = (await benefitsWallets(vet)).find((w) => w.organization.name === "Globex");
eq("restrictions: another user cannot send into a Benefits wallet", (await call("POST", "/v1/transfers", { token: outsider.session_token, key: "x1", body: { to_wallet_id: nbw.id, amount: 100 } })).json.error, "recipient_not_eligible");
await fund(outsider, 10_000, "f-out");
eq("restrictions: a send from a Benefits wallet to anyone is refused, even with allow_send turned on", [(await call("PATCH", `/v1/wallets/${nbw.id}`, { token: newbie.session_token, body: { allow_send: true } })).status, (await call("POST", "/v1/transfers", { token: newbie.session_token, key: "x2", body: { to_wallet_id: ow, amount: 100, from_wallet_id: nbw.id } })).json.error], [200, "benefits_wallet_not_transferable"]);
eq("restrictions: the balance cannot be edited or released through the generic endpoint", [(await call("PUT", `/v1/wallets/${nbw.id}/balance`, { token: newbie.session_token, body: { balance: null } })).json.error, (await call("PUT", `/v1/wallets/${nbw.id}/balance`, { token: newbie.session_token, body: { balance: 5 } })).json.error], ["benefits_wallet_locked", "benefits_wallet_locked"]);
eq("restrictions: type and employer cannot change (API and database)", [(await call("PATCH", `/v1/wallets/${nbw.id}`, { token: newbie.session_token, body: { type: "default" } })).status, await q("update wallets set type='person', org_account_id=null where id=$1", [nbw.id]).then(() => "changed", () => "refused"), await q("update wallets set org_account_id=$2 where id=$1", [nbw.id, other.account_id]).then(() => "changed", () => "refused")], [400, "refused", "refused"]);
eq("restrictions: consumers cannot create a Benefits wallet", (await call("POST", "/v1/wallets", { token: newbie.session_token, body: { display_name: "Mine", type: "benefits" } })).status, 400);
eq("restrictions: ordinary -> Benefits and Benefits -> Benefits moves are refused", [(await move(newbie, dw, nbw.id, 100, "y1")).json.error, (await move(vet, vacme.id, vglobex.id, 100, "y2")).json.error], ["source_must_be_benefits", "destination_not_allowed"]);
eq("restrictions: a move to another account's wallet, or from one you do not own, is a 404", [(await move(newbie, nbw.id, ow, 100, "y3")).status, (await move(outsider, nbw.id, ow, 100, "y4")).status], [404, 404]);
eq("restrictions: an agent key cannot move money", (await call("POST", "/v1/wallets/move", { token: agent.key, key: "y5", body: { from_wallet_id: vacme.id, to_wallet_id: agent.wallet.id, amount: 100 } })).status, 403);
const band = (await call("POST", "/v1/admin/tag-models", { token: OP, body: { type: "band", name: "Band", price: 2999, quantity: 50, status: "available" } })).json.model;
const buy = await call("POST", "/v1/shop/orders", { token: newbie.session_token, key: "buy-1", body: { model_id: band.id, quantity: 1, wallet_id: nbw.id, shipping: { name: "Nora", line1: "1 Main", city: "Brooklyn", region: "NY", postal_code: "11201", country: "US" } } });
eq("spending: a Benefits wallet can buy from the Nuclear store like any wallet, and its ledger stays reconciled", [buy.status, (await benefitsWallets(newbie))[0].balance, (await reconciled()).benefits_match_ledger, (await reconciled()).balances_match_ledger], [201, 680_000 - 2_999, true, true]);
eq("restrictions: a Benefits wallet with money cannot be closed", [(await call("PATCH", `/v1/wallets/${nbw.id}`, { token: newbie.session_token, body: { status: "closed" } })).json.error, (await benefitsWallets(newbie))[0].status], ["benefits_wallet_not_empty", "active"]);
eq("restrictions: a move needs the owner and an idempotency key", [(await call("POST", "/v1/wallets/move", { token: newbie.session_token, body: { from_wallet_id: nbw.id, to_wallet_id: dw, amount: 1 } })).status, (await call("POST", "/v1/wallets/move", { token: newbie.session_token, key: "y7", body: { from_wallet_id: nbw.id, to_wallet_id: dw, amount: 0 } })).status], [400, 400]);

// ---- 6. refunds go back where the money came from, are never capped and never counted
const rita = await sign("Rita Refund", "rita@x.test");
await batch(acme, [{ employee_id: "R1", name: "Rita Refund", email: "rita@x.test", amount: 100_000 }], "r1");
await claim(rita, tokenOf("rita@x.test"));
const rb = (await benefitsWallets(rita))[0], rdw = await defaultWallet(rita);
await fund(rita, 100_000, "f-rita"); await earlier(rita.account_id);          // $1,000 ordinary at the start of today
const pb = await pay(rita, { terminal_id: termId, amount: 30_000, from_wallet_id: rb.id }, "r-pb");
const po = await pay(rita, { terminal_id: termId, amount: 40_000, from_wallet_id: rdw }, "r-po");
const room0 = (await balance(rita)).daily_headroom;
const refund = (payment: string, key: string, body: object = { mode: "full" }) => call("POST", "/v1/terminal/refunds", { token: termTok, key, body: { payment_id: payment, ...body } });
const rfb = await refund(pb.json.payment.id, "rf-b");
eq("refund: a Benefits purchase refunds into its Benefits wallet, not ordinary funds", [rfb.status, (await benefitsWallets(rita))[0].balance, (await balance(rita)).ordinary], [201, 100_000, 60_000]);
const rfo = await refund(po.json.payment.id, "rf-o", { mode: "partial", amount: 15_000 });
eq("refund: an ordinary purchase refunds into the ordinary wallet, never Benefits", [rfo.status, (await benefitsWallets(rita))[0].balance, (await balance(rita)).ordinary], [201, 100_000, 75_000]);
eq("refund: refunds never count toward the daily value (headroom is unchanged)", (await balance(rita)).daily_headroom, room0);
eq("refund: a duplicate callback replays and credits once", [(await refund(po.json.payment.id, "rf-o", { mode: "partial", amount: 15_000 })).status, (await balance(rita)).ordinary], [200, 75_000]);
eq("refund: the remainder refunds too (cumulative bounds still hold)", [(await refund(po.json.payment.id, "rf-o2")).json.refund.amount, (await refund(po.json.payment.id, "rf-o3")).json.error], [25_000, "already_refunded"]);
// an over-cap refund is never rejected. Ordinary money above the cap can only arrive through a bank load that settled late (always accepted):
// simulated by funding directly, as a settled provider load would.
const olga = await sign("Olga Over", "olga@x.test");
await bankroll(olga.account_id, 250_000); await earlier(olga.account_id);
const pol = await pay(olga, { terminal_id: termId, amount: 40_000, from_wallet_id: await defaultWallet(olga) }, "o-pay");
const rof = await refund(pol.json.payment.id, "o-ref");
const ob = await balance(olga);
eq("refund: ordinary funds above $2,000 (a late-settled load) are usable, and an approved refund is never rejected or counted", [pol.status, rof.status, ob.ordinary, ob.daily_headroom], [201, 201, 250_000, 0]);
eq("refund: reconciliation holds after all of it", [(await reconciled()).ledger_balanced, (await reconciled()).balances_match_ledger, (await reconciled()).benefits_match_ledger, (await reconciled()).escrow_matches_employees], [true, true, true, true]);
eq("benefits: org-side views expose the Benefits wallet id of claimed employees, never a balance", (await call("GET", "/v1/org/employees?status=claimed", { token: acme.session_token })).json.employees.every((e: any) => typeof e.benefits_wallet_id === "string" && !("benefits_balance" in e)), true);
console.log(`\n${pass} passed, ${fail} failed`);
await adm.end();
process.exit(fail ? 1 : 0);
