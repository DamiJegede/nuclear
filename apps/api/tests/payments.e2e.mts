import { ROOT, applyMigration, migrate, psql, resetSchema } from "./db.ts";
import { createCipheriv, createHash, createHmac, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
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
const bob = await signup("Bob", "bob@example.com");
const S = shop.session_token, O = other.session_token, A = ada.session_token, B = bob.session_token;

// ============ terminals ============
eq("consumer cannot create terminal", (await call("POST", "/v1/terminals", { token: A, body: { name: "T" } })).status, 403);
const k1 = await call("POST", `/v1/wallets`, { token: S, body: { display_name: "Staff", type: "person" } });
const kl = await call("POST", `/v1/wallets/${k1.json.wallet.id}/links`, { token: S });
const delegated = (await call("POST", "/v1/devices/redeem", { body: { token: kl.json.url.split("/magic-link/")[1] } })).json.session_token;
eq("delegated device cannot create terminal", (await call("POST", "/v1/terminals", { token: delegated, body: { name: "T" } })).status, 403);
eq("blank name rejected", (await call("POST", "/v1/terminals", { token: S, body: { name: "  " } })).status, 400);
const t1 = await call("POST", "/v1/terminals", { token: S, body: { name: "Front counter" } });
eq("create terminal 201 + JWT, allow_refunds defaults true", [t1.status, t1.json.session_token.split(".").length, t1.json.terminal.name, t1.json.terminal.allow_refunds, t1.json.terminal.orb], [201, 3, "Front counter", true, null]);
const T1 = t1.json.session_token, t1id = t1.json.terminal.id;
eq("terminal is not a device", (await q("select count(*)::int n from devices where account_id=$1 and wallet_id is null", [shop.account_id]))[0].n, 1); // owner login only
eq("only a hash is stored on the terminal", (await q("select length(session_token_hash) l, session_token_hash <> $2 as hashed from terminals where id=$1", [t1id, T1]))[0], { l: 64, hashed: true });
eq("terminal self", (await call("GET", "/v1/terminal", { token: T1 })).json.terminal.id, t1id);
for (const [m, p] of [["GET", "/v1/wallets"], ["GET", "/v1/balance"], ["GET", "/v1/account"], ["GET", "/v1/activity"], ["GET", "/v1/devices"], ["GET", "/v1/terminals"], ["GET", "/v1/orbs"], ["GET", "/v1/staff"], ["GET", "/v1/handles/shop01"]] as const) {
  eq(`terminal JWT is not a device session: ${m} ${p}`, (await call(m, p, { token: T1 })).status, 401);
}
eq("terminal cannot send", (await call("POST", "/v1/transfers", { token: T1, key: "x", body: { to_wallet_id: ada.default_wallet_id, amount: 1 } })).status, 401);
eq("owner session cannot use terminal endpoints", (await call("GET", "/v1/terminal", { token: S })).status, 401);
eq("device session token is not a terminal token", (await call("GET", "/v1/terminal", { token: delegated })).status, 401);
eq("wallet-link JWT is not a terminal token", (await call("GET", "/v1/terminal", { token: kl.json.url.split("/magic-link/")[1] })).status, 401);
eq("no token 401", (await call("GET", "/v1/terminal")).status, 401);
// forged / tampered JWTs
const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
const payload = JSON.parse(Buffer.from(T1.split(".")[1], "base64url").toString());
eq("tampered payload rejected", (await call("GET", "/v1/terminal", { token: `${T1.split(".")[0]}.${b64({ ...payload, sub: "0190aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee" })}.${T1.split(".")[2]}` })).status, 401);
eq("alg none rejected", (await call("GET", "/v1/terminal", { token: `${b64({ alg: "none", typ: "JWT" })}.${b64(payload)}.` })).status, 401);
const forge = (secret: string, p: object) => { const h = b64({ alg: "HS256", typ: "JWT" }), pl = b64(p); return `${h}.${pl}.${createHmac("sha256", secret).update(`${h}.${pl}`).digest("base64url")}`; };
eq("wrong-secret JWT rejected", (await call("GET", "/v1/terminal", { token: forge("not-the-secret-not-the-secret-12345", payload) })).status, 401);
eq("validly signed but never issued (hash mismatch) rejected", (await call("GET", "/v1/terminal", { token: forge(env.JWT_SECRET, { ...payload, jti: "forged", iat: payload.iat + 1 }) })).status, 401);
eq("expired JWT rejected", (await call("GET", "/v1/terminal", { token: forge(env.JWT_SECRET, { ...payload, exp: Math.floor(Date.now() / 1000) - 10 }) })).status, 401);
eq("wrong audience rejected", (await call("GET", "/v1/terminal", { token: forge(env.JWT_SECRET, { ...payload, aud: "nuclear:wallet-link" }) })).status, 401);
await q("update terminals set session_token_hash=$2 where id=$1", [t1id, createHash("sha256").update(forge(env.JWT_SECRET, { ...payload, jti: "stored" })).digest("hex")]);
eq("original JWT dead once hash changed", (await call("GET", "/v1/terminal", { token: T1 })).status, 401);
const T1x = (await call("POST", `/v1/terminals/${t1id}/session`, { token: S })).json.session_token;
eq("list terminals", (await call("GET", "/v1/terminals", { token: S })).json.terminals.map((t: any) => t.name), ["Front counter"]);
eq("rename + allow_refunds", await (async () => { const r = await call("PATCH", `/v1/terminals/${t1id}`, { token: S, body: { name: "Counter 1", allow_refunds: true } }); return [r.json.terminal.name, r.json.terminal.allow_refunds]; })(), ["Counter 1", true]);
eq("empty patch 400", (await call("PATCH", `/v1/terminals/${t1id}`, { token: S, body: {} })).status, 400);
eq("other merchant cannot see terminal", (await call("GET", `/v1/terminals/${t1id}`, { token: O })).status, 404);
eq("other merchant cannot rename", (await call("PATCH", `/v1/terminals/${t1id}`, { token: O, body: { name: "x" } })).status, 404);
eq("other merchant cannot re-session", (await call("POST", `/v1/terminals/${t1id}/session`, { token: O })).status, 404);
const rs = await call("POST", `/v1/terminals/${t1id}/session`, { token: S });
eq("re-issued session revokes previous", [rs.status, (await call("GET", "/v1/terminal", { token: T1x })).status, (await call("GET", "/v1/terminal", { token: rs.json.session_token })).status], [201, 401, 200]);
const ext = await call("POST", "/v1/terminal/session/extend", { token: rs.json.session_token });
eq("extend issues a new JWT and kills the old one", [ext.status, (await call("GET", "/v1/terminal", { token: rs.json.session_token })).status, (await call("GET", "/v1/terminal", { token: ext.json.session_token })).status], [200, 401, 200]);
await call("POST", `/v1/terminals/${t1id}/revoke`, { token: S });
eq("owner revoke kills terminal session", (await call("GET", "/v1/terminal", { token: ext.json.session_token })).status, 401);
const T1c = (await call("POST", `/v1/terminals/${t1id}/session`, { token: S })).json.session_token;
eq("terminal ends its own session", [(await call("DELETE", "/v1/terminal/session", { token: T1c })).status, (await call("GET", "/v1/terminal", { token: T1c })).status], [204, 401]);
const T1d = (await call("POST", `/v1/terminals/${t1id}/session`, { token: S })).json.session_token;

// ============ orbs: paired on a terminal (uid = MAC); the Orb is columns of the terminal ============
const MAC1 = "AA:BB:CC:00:11:01", MAC2 = "aa-bb-cc-00-11-02", MAC3 = "AABBCC001103", MAC4 = "AABBCC001104";
const orbBody = (uid: string, software = "1.0.0", model = "Orb-1") => ({ uid, model, software });
const orbsRows = async () => Number((await q("select count(*)::int n from terminals where orb_uid is not null"))[0].n);
eq("no Orb is paired before the first claim", await orbsRows(), 0);
const reg = await call("PUT", `/v1/terminals/${t1id}/orb`, { token: S, body: orbBody(MAC1) });
eq("an Orb is paired on the terminal (MAC normalized)", [reg.status, reg.json.orb.uid, reg.json.orb.model, reg.json.orb.software, await orbsRows()], [200, "AABBCC001101", "Orb-1", "1.0.0", 1]);
eq("its MAC, model and firmware are columns of that terminal", (await q("select orb_uid, orb_model, orb_software, orb_paired_at is not null as paired from terminals where id=$1", [t1id]))[0], { orb_uid: "AABBCC001101", orb_model: "Orb-1", orb_software: "1.0.0", paired: true });
const o1 = reg.json.orb.id;
eq("the Orb's id is its terminal's id", o1, t1id);
eq("terminal shows its orb", (await call("GET", "/v1/terminal", { token: T1d })).json.terminal.orb.uid, "AABBCC001101");
for (const bad of ["AABBCC0011", "ZZBBCC001101", "AA:BB:CC:00:11:01:02", ""]) {
  eq(`invalid MAC rejected: ${JSON.stringify(bad)}`, (await call("PUT", `/v1/terminals/${t1id}/orb`, { token: S, body: orbBody(bad) })).status, 400);
}
eq("model and software required", [(await call("PUT", `/v1/terminals/${t1id}/orb`, { token: S, body: { uid: MAC2 } })).status, (await call("PUT", `/v1/terminals/${t1id}/orb`, { token: S, body: { uid: MAC2, model: "Orb-1", software: " " } })).status], [400, 400]);
// another account cannot take an Orb that is on a terminal of this account
eq("another account's Orb cannot be claimed", (await call("PUT", `/v1/terminals/${(await call("POST", "/v1/terminals", { token: O, body: { name: "Other T" } })).json.terminal.id}/orb`, { token: O, body: orbBody(MAC1) })).json.error, "orb_assigned_to_another_account");
eq("it is still on our terminal, untouched", (await q("select orb_uid from terminals where id=$1", [t1id]))[0].orb_uid, "AABBCC001101");
eq("other merchant cannot pair my terminal", (await call("PUT", `/v1/terminals/${t1id}/orb`, { token: O, body: orbBody(MAC2) })).status, 404);
// re-claiming records the firmware the terminal read
const reUp = await call("PUT", `/v1/terminals/${t1id}/orb`, { token: S, body: orbBody("AA:BB:CC:00:11:01", "1.2.0") });
eq("re-pairing updates firmware, still one Orb", [reUp.json.orb.software, reUp.json.orb.id === o1, await orbsRows()], ["1.2.0", true, 1]);
// terminal claims by itself; a terminal holds one Orb, the replaced one is gone
const second = await call("PUT", "/v1/terminal/orb", { token: T1d, body: orbBody(MAC2, "1.0.1") });
eq("terminal claims a second Orb itself, replacing the first", [second.status, second.json.orb.uid], [200, "AABBCC001102"]);
eq("the replaced Orb is gone from the system (its MAC is free)", (await q("select count(*)::int n from terminals where orb_uid='AABBCC001101'"))[0].n, 0);
const t2 = await call("POST", "/v1/terminals", { token: S, body: { name: "Bar" } });
const t2id = t2.json.terminal.id, T2 = t2.json.session_token;
await call("PUT", `/v1/terminals/${t2id}/orb`, { token: S, body: orbBody(MAC2) });
eq("orb moved: left old terminal, on new", [(await call("GET", `/v1/terminals/${t1id}`, { token: S })).json.terminal.orb, (await call("GET", `/v1/terminals/${t2id}`, { token: S })).json.terminal.orb.uid], [null, "AABBCC001102"]);
eq("terminal reports new firmware", (await call("PATCH", "/v1/terminal/orb", { token: T2, body: { software: "2.0.0" } })).json.orb.software, "2.0.0");
eq("no orb paired => 404", (await call("PATCH", "/v1/terminal/orb", { token: T1d, body: { software: "9" } })).status, 404);
eq("owner lists the Orbs that are paired", (await call("GET", "/v1/orbs", { token: S })).json.orbs.map((o: any) => [o.uid, o.terminal_id === t2id ? "T2" : o.terminal_id]), [["AABBCC001102", "T2"]]);
eq("terminal frees its own orb: MAC, model and firmware are removed from it", [(await call("DELETE", "/v1/terminal/orb", { token: T2 })).status, (await call("GET", "/v1/terminal", { token: T2 })).json.terminal.orb, (await q("select orb_uid, orb_model, orb_software, orb_paired_at from terminals where id=$1", [t2id]))[0]], [204, null, { orb_uid: null, orb_model: null, orb_software: null, orb_paired_at: null }]);
await call("PUT", `/v1/terminals/${t1id}/orb`, { token: S, body: orbBody(MAC1) });
eq("owner frees it too", (await call("DELETE", `/v1/terminals/${t1id}/orb`, { token: S })).status, 204);
// release: the Orb can then be claimed by someone else
await call("PUT", `/v1/terminals/${t2id}/orb`, { token: S, body: orbBody(MAC2) });
const o2id = (await call("GET", "/v1/orbs", { token: S })).json.orbs.find((o: any) => o.uid === "AABBCC001102").id;
eq("release is owner-only and scoped", [(await call("POST", `/v1/orbs/${o2id}/release`, { token: O })).status, (await call("POST", `/v1/orbs/${o2id}/release`, { token: S })).status], [404, 204]);
const otherTid = (await call("GET", "/v1/terminals", { token: O })).json.terminals[0].id;
eq("a released Orb can be claimed by another account", [(await call("PUT", `/v1/terminals/${otherTid}/orb`, { token: O, body: orbBody(MAC2) })).status, (await q("select orb_uid from terminals where id=$1", [otherTid]))[0].orb_uid], [200, "AABBCC001102"]);
// concurrent first claims of one new MAC: exactly one account wins, one Orb
const raceTerm = (await call("POST", "/v1/terminals", { token: S, body: { name: "Race S" } })).json.terminal.id;
const raceTermO = (await call("POST", "/v1/terminals", { token: O, body: { name: "Race O" } })).json.terminal.id;
const orbRace = await Promise.all([
  call("PUT", `/v1/terminals/${raceTerm}/orb`, { token: S, body: orbBody(MAC3) }),
  call("PUT", `/v1/terminals/${raceTermO}/orb`, { token: O, body: orbBody(MAC3) }),
]);
eq("racing first claims of one MAC: exactly one wins, one Orb", [orbRace.filter((r) => r.status === 200).length, orbRace.filter((r) => r.status === 409).length, (await q("select count(*)::int n from terminals where orb_uid='AABBCC001103'"))[0].n], [1, 1, 1]);
const tryq = async (sql: string, args: unknown[] = []) => { try { await q(sql, args); return "none"; } catch (e: any) { return e.constraint_name ?? e.code; } };
eq("db: an Orb MAC is on one terminal at most", await tryq("update terminals set orb_uid='AABBCC001104', orb_model='m', orb_software='s', orb_paired_at=now() where id in ($1,$2)", [t1id, t2id]), "terminals_orb_uid_key");
eq("db: Orb MAC must be 12 uppercase hex", await tryq("update terminals set orb_uid='aa:bb', orb_model='m', orb_software='s', orb_paired_at=now() where id=$1", [t1id]), "terminals_orb_uid_format");
eq("db: the Orb columns are all set or all empty", await tryq("update terminals set orb_uid='AABBCC0011FE' where id=$1", [t1id]), "terminals_orb_all_or_none");
await call("PUT", `/v1/terminals/${t1id}/orb`, { token: S, body: orbBody(MAC4) }); // leave T1 with an Orb

// ============ funding + tags ============
await fund(A, 10000, "fa");
const adaTag = await newTag(ada.default_wallet_id);
eq("tag payment 201", await (async () => { const r = await tpay(T1d, urlFor(adaTag.uid, 5), 2500, "att-1", { reference: "ORDER-77" }); return [r.status, r.json.payment.status, r.json.payment.amount, r.json.payment.reference, r.json.payment.via, r.json.payment.terminal_id === t1id, r.json.payment.payer.display_name]; })(), [201, "completed", 2500, "ORDER-77", "tag", true, "Ada"]);
eq("payer debited / merchant credited", [(await bal(A)).balance, (await bal(S)).balance], [7500, 2500]);
const first = (await q("select id from txn where idempotency_key like '%:t:att-1'"))[0].id;
const rep = await tpay(T1d, urlFor(adaTag.uid, 5), 2500, "att-1");
eq("same attempt replay 200, same tx, no 2nd debit", [rep.status, rep.json.payment.id, (await bal(A)).balance], [200, first, 7500]);
eq("same attempt, different amount 409", (await tpay(T1d, urlFor(adaTag.uid, 5), 9, "att-1")).status, 409);
eq("same proof, new attempt 409", (await tpay(T1d, urlFor(adaTag.uid, 5), 100, "att-2")).json.error, "proof_replayed");
eq("older counter 409", (await tpay(T1d, urlFor(adaTag.uid, 4), 100, "att-3")).json.error, "proof_replayed");
eq("higher counter ok (gap allowed)", (await tpay(T1d, urlFor(adaTag.uid, 9), 100, "att-4")).status, 201);
eq("counter stored", (await q("select counter::int c from tags where id=$1", [adaTag.id]))[0].c, 9);
const lk = await call("GET", "/v1/terminal/payments/att-1", { token: T1d });
eq("terminal recovers result by attempt id", [lk.status, lk.json.payment.id, lk.json.payment.payer.display_name, JSON.stringify(lk.json).includes("balance")], [200, first, "Ada", false]);
eq("unknown attempt 404", (await call("GET", "/v1/terminal/payments/nope", { token: T1d })).status, 404);
eq("other merchant cannot read attempt", (await call("GET", "/v1/terminal/payments/att-1", { token: (await call("POST", "/v1/terminals", { token: O, body: { name: "O1" } })).json.session_token })).status, 404);

eq("garbage tag 400", (await tpay(T1d, "https://tag.nclr.app/v1/zzzz", 100, "g-1")).json.error, "invalid_tag");
eq("unknown version 400", (await tpay(T1d, urlFor(adaTag.uid, 20, "v9"), 100, "g-2")).json.error, "invalid_tag");
eq("unknown uid 404", (await tpay(T1d, urlFor("04ffffffffffff", 1), 100, "g-3")).json.error, "tag_not_found");
const loose = await newTag(null);
eq("unassigned tag 422", (await tpay(T1d, urlFor(loose.uid, 1), 100, "g-4")).json.error, "tag_unassigned");
eq("unassigned: proof consumed", (await tpay(T1d, urlFor(loose.uid, 1), 100, "g-5")).json.error, "proof_replayed");
const lockedTag = await newTag(ada.default_wallet_id, { locked: true });
eq("locked tag 422", (await tpay(T1d, urlFor(lockedTag.uid, 1), 100, "g-6")).json.error, "tag_locked");
const limTag = await newTag(ada.default_wallet_id, { limit: 500 });
const lim = await tpay(T1d, urlFor(limTag.uid, 1), 501, "g-7");
eq("tag limit declined + recorded", [lim.status, lim.json.status_code, lim.json.payment.status], [422, "tag_limit_exceeded", "failed"]);
eq("declined attempt consumed proof", (await tpay(T1d, urlFor(limTag.uid, 1), 100, "g-8")).json.error, "proof_replayed");
eq("within tag limit ok", (await tpay(T1d, urlFor(limTag.uid, 2), 500, "g-9")).status, 201);
const big = await tpay(T1d, urlFor(adaTag.uid, 30), 99999, "g-10");
eq("insufficient funds declined + recorded", [big.status, big.json.status_code, (await q("select status from txn where idempotency_key like '%:t:g-10'"))[0].status], [422, "insufficient_balance", "failed"]);
eq("decline moved nothing", (await bal(A)).balance, 6900);
const bobTag = await newTag(bob.default_wallet_id);
eq("zero-balance payer declined", (await tpay(T1d, urlFor(bobTag.uid, 1), 100, "g-11")).json.status_code, "insufficient_balance");
const shopOwnTag = await newTag(shop.default_wallet_id);
eq("merchant's own tag rejected", (await tpay(T1d, urlFor(shopOwnTag.uid, 1), 100, "g-12")).json.error, "self_payment");
eq("pass credential not yet supported", (await call("POST", "/v1/terminal/payments", { token: T1d, key: "p-1", body: { amount: 100, credential: { type: "pass", id: "x" } } })).status, 501);
eq("idempotency key required", (await call("POST", "/v1/terminal/payments", { token: T1d, body: { amount: 100, credential: { type: "tag", url: urlFor(adaTag.uid, 40) } } })).status, 400);
eq("amount must be positive int", (await tpay(T1d, urlFor(adaTag.uid, 41), 0, "g-13")).status, 400);

// wallet-level controls on tag payments
const kid = (await call("POST", "/v1/wallets", { token: A, body: { display_name: "Kid", type: "person", daily_limit: 1000, allow_send: false } })).json.wallet.id;
const kidTag = await newTag(kid);
eq("kid tag within daily limit", (await tpay(T1d, urlFor(kidTag.uid, 1), 800, "k-1")).status, 201);
eq("kid daily limit enforced", (await tpay(T1d, urlFor(kidTag.uid, 2), 300, "k-2")).json.status_code, "spend_limit_exceeded");
await call("PATCH", `/v1/wallets/${kid}`, { token: A, body: { allow_pay: false } });
eq("allow_pay=false declined", (await tpay(T1d, urlFor(kidTag.uid, 3), 1, "k-3")).json.status_code, "pay_not_allowed");
await call("PATCH", `/v1/wallets/${kid}`, { token: A, body: { allow_pay: true, status: "suspended" } });
eq("suspended wallet declined", (await tpay(T1d, urlFor(kidTag.uid, 4), 1, "k-4")).json.status_code, "payer_unavailable");

// ============ credit ============
const cy = await signup("Cy", "cy@example.com");
await fund(cy.session_token, 1000, "fc");
await q("update balances set credit_limit=3000 where account_id=$1", [cy.account_id]);
const cyTag = await newTag(cy.default_wallet_id);
eq("available_to_pay includes credit", (await bal(cy.session_token)).available_to_pay, 4000);
eq("available_to_send excludes credit", (await bal(cy.session_token)).available_to_send, 1000);
const cp = await tpay(T1d, urlFor(cyTag.uid, 1), 2500, "c-1");
eq("balance first then credit", [cp.status, (await q("select balance::int b, credit_spent::int c from balances where account_id=$1", [cy.account_id]))[0]], [201, { b: 0, c: 1500 }]);
eq("credit portion recorded on the payment", (await q("select amount::int a, credit_amount::int c from transactions where id=$1", [cp.json.payment.id])), [{ a: 2500, c: 1500 }]);
eq("credit exhausted declines", (await tpay(T1d, urlFor(cyTag.uid, 2), 1600, "c-2")).json.status_code, "insufficient_balance");
eq("cannot send from credit", (await call("POST", "/v1/transfers", { token: cy.session_token, key: "cs", body: { to_wallet_id: bob.default_wallet_id, amount: 1 } })).json.status_code, "insufficient_balance");
const fr = await fund(cy.session_token, 2000, "fc2");
eq("funding repays credit first", [fr.status, (await q("select balance::int b, credit_spent::int c from balances where account_id=$1", [cy.account_id]))[0]], [201, { b: 500, c: 0 }]);
await q("update balances set credit_spent=credit_limit+1 where account_id=$1", [cy.account_id]);
eq("over-limit credit restricts payments", (await tpay(T1d, urlFor(cyTag.uid, 3), 1, "c-3")).json.status_code, "account_restricted");
await q("update balances set credit_spent=0 where account_id=$1", [cy.account_id]);

// ============ customer-confirmed path ============
const bobBefore = (await bal(B)).balance;
await fund(B, 5000, "fb");
const cw = await call("POST", "/v1/payments", { token: B, key: "cw-1", body: { amount: 1200, terminal_id: t1id, reference: "INV-9" } });
eq("customer pays terminal", [cw.status, cw.json.payment.status, cw.json.payment.via, cw.json.payment.merchant.display_name, cw.json.payment.terminal_id === t1id], [201, "completed", "wallet", "Shop", true]);
eq("replay returns original", [(await call("POST", "/v1/payments", { token: B, key: "cw-1", body: { amount: 1200, terminal_id: t1id, reference: "INV-9" } })).json.payment.id === cw.json.payment.id, (await bal(B)).balance], [true, bobBefore + 5000 - 1200]);
eq("mismatched replay 409", (await call("POST", "/v1/payments", { token: B, key: "cw-1", body: { amount: 1, terminal_id: t1id } })).status, 409);
eq("same key, different customer is independent", (await call("POST", "/v1/payments", { token: A, key: "cw-1", body: { amount: 50, terminal_id: t1id } })).status, 201);
eq("terminal_id required (no merchant_handle)", [
  (await call("POST", "/v1/payments", { token: B, key: "x1", body: { amount: 1 } })).status,
  (await call("POST", "/v1/payments", { token: B, key: "x2", body: { amount: 1, merchant_handle: "shop01" } })).status], [400, 400]);
eq("unknown terminal 404", (await call("POST", "/v1/payments", { token: B, key: "x3", body: { amount: 1, terminal_id: "0190aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee" } })).status, 404);
eq("merchant cannot pay its own terminal", (await call("POST", "/v1/payments", { token: S, key: "x5", body: { amount: 1, terminal_id: t1id } })).json.error, "self_payment");
eq("customer-path insufficient funds recorded", (await call("POST", "/v1/payments", { token: B, key: "x6", body: { amount: 999999, terminal_id: t1id } })).json.status_code, "insufficient_balance");
const kl3 = await call("POST", `/v1/wallets/${kid}/links`, { token: A }); // kid wallet is suspended: link refused
eq("suspended wallet gets no link", kl3.status, 404);
await call("PATCH", `/v1/wallets/${kid}`, { token: A, body: { status: "active", daily_limit: null } });
const kl4 = await call("POST", `/v1/wallets/${kid}/links`, { token: A });
const kidSession = (await call("POST", "/v1/devices/redeem", { body: { token: kl4.json.url.split("/magic-link/")[1] } })).json.session_token;
eq("delegated device pays from own wallet", (await call("POST", "/v1/payments", { token: kidSession, key: "kd-1", body: { amount: 40, terminal_id: t1id } })).json.payment.wallet_id, kid);
eq("delegated cannot pay from another wallet", (await call("POST", "/v1/payments", { token: kidSession, key: "kd-2", body: { amount: 40, terminal_id: t1id, from_wallet_id: ada.default_wallet_id } })).status, 404);
eq("payer reads own payment", (await call("GET", `/v1/payments/${cw.json.payment.id}`, { token: B })).json.payment.merchant.display_name, "Shop");
eq("merchant cannot read via payer endpoint", (await call("GET", `/v1/payments/${cw.json.payment.id}`, { token: S })).status, 404);
eq("other customer cannot read", (await call("GET", `/v1/payments/${cw.json.payment.id}`, { token: A })).status, 404);

// ============ tap lookup (who is this?) ============
const lookup = (url: string) => call("POST", "/v1/terminal/lookup", { token: T1d, body: { credential: { type: "tag", url } } });
const lkTag = await newTag(ada.default_wallet_id);
const look = await lookup(urlFor(lkTag.uid, 1));
eq("tap resolves the account (both ids)", [look.status, look.json.account.account_id, look.json.account.wallet_id, look.json.account.display_name, look.json.account.staff], [200, ada.account_id, ada.default_wallet_id, "Ada", null]);
eq("lookup exposes no balance", JSON.stringify(look.json).includes("balance"), false);
eq("lookup burns the proof (counter consumed)", (await q("select counter::int c, last_read_at is not null as r from tags where id=$1", [lkTag.id]))[0], { c: 1, r: true });
eq("same URL cannot be looked up again", (await lookup(urlFor(lkTag.uid, 1))).json.error, "proof_replayed");
eq("same URL cannot then pay", (await tpay(T1d, urlFor(lkTag.uid, 1), 100, "lk-0")).json.error, "proof_replayed");
eq("a fresh tap pays", (await tpay(T1d, urlFor(lkTag.uid, 2), 100, "lk-1")).status, 201);
eq("a paid-with URL cannot be looked up", (await lookup(urlFor(lkTag.uid, 2))).json.error, "proof_replayed");
eq("lookup: garbage 400 (nothing to burn)", (await lookup("https://tag.nclr.app/v1/nope")).json.error, "invalid_tag");
eq("lookup: unknown tag 404", (await lookup(urlFor("04eeeeeeeeeeee", 1))).status, 404);
const lkLoose = await newTag(null);
eq("lookup: unassigned 422", (await lookup(urlFor(lkLoose.uid, 1))).json.error, "tag_unassigned");
eq("lookup: unassigned still burns the proof", (await lookup(urlFor(lkLoose.uid, 1))).json.error, "proof_replayed");
const lkLocked = await newTag(ada.default_wallet_id, { locked: true });
eq("lookup: locked 422", (await lookup(urlFor(lkLocked.uid, 1))).json.error, "tag_locked");
eq("lookup: locked still burns the proof", (await q("select counter::int c from tags where id=$1", [lkLocked.id]))[0].c, 1);
eq("lookup: pass not yet verifiable", (await call("POST", "/v1/terminal/lookup", { token: T1d, body: { credential: { type: "pass", id: "x" } } })).status, 501);
eq("lookup needs terminal JWT", (await call("POST", "/v1/terminal/lookup", { token: A, body: { credential: { type: "tag", url: urlFor(lkTag.uid, 9) } } })).status, 401);
eq("failed lookups burn nothing for unknown/garbage", (await q("select count(*)::int n from tags where counter is not null and uid like '04EE%'"))[0].n, 0);
const parLk = await newTag(ada.default_wallet_id);
const pl = await Promise.all([1, 2, 3, 4].map(() => lookup(urlFor(parLk.uid, 5))));
eq("parallel lookups of one tap: exactly one succeeds", pl.filter((r) => r.status === 200).length, 1);

// ============ activity ============
const bact = (await call("GET", "/v1/activity?limit=100", { token: B })).json.items.find((i: any) => i.id === cw.json.payment.id);
eq("customer activity shows merchant", [bact.type, bact.direction, bact.counterparty.display_name], ["pay", "out", "Shop"]);
const sact = (await call("GET", "/v1/activity?limit=100", { token: S })).json.items.find((i: any) => i.id === cw.json.payment.id);
eq("merchant activity shows paying member", [sact.direction, sact.counterparty.display_name], ["in", "Bob"]);

const otherT0 = (await call("POST", "/v1/terminals", { token: O, body: { name: "O0" } })).json.session_token;

// ============ staff ============
const sam = await signup("Sam", "sam@example.com");       // will be write staff
const rae = await signup("Rae", "rae@example.com");       // read-only staff
const nobody = await signup("Nobody", "nobody@example.com");
await fund(sam.session_token, 100, "fs");                  // creates Sam's (sandbox) bank account
const samBank = (await q("select id from bank_accounts where account_id=$1", [sam.account_id]))[0].id;
const adaBank = (await q("select id from bank_accounts where account_id=$1", [ada.account_id]))[0].id;
eq("consumer cannot manage staff", (await call("GET", "/v1/staff", { token: A })).status, 403);
eq("add write staff with their bank", (await call("POST", "/v1/staff", { token: S, body: { staff_account_id: sam.account_id, role: "write", bank_account_id: samBank } })).status, 201);
eq("another account's bank rejected", (await call("POST", "/v1/staff", { token: S, body: { staff_account_id: rae.account_id, role: "read", bank_account_id: adaBank } })).json.error, "bank_account_not_found");
eq("add read staff (no bank)", (await call("POST", "/v1/staff", { token: S, body: { staff_account_id: rae.account_id, role: "read" } })).status, 201);
eq("duplicate staff 409", (await call("POST", "/v1/staff", { token: S, body: { staff_account_id: sam.account_id, role: "read" } })).json.error, "already_staff");
eq("business cannot be staff", (await call("POST", "/v1/staff", { token: S, body: { staff_account_id: other.account_id, role: "write" } })).status, 404);
eq("unknown account 404", (await call("POST", "/v1/staff", { token: S, body: { staff_account_id: "0190aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee", role: "write" } })).status, 404);
eq("invalid role 400", (await call("POST", "/v1/staff", { token: S, body: { staff_account_id: nobody.account_id, role: "admin" } })).status, 400);
const staffList = (await call("GET", "/v1/staff", { token: S })).json.staff;
eq("list staff", staffList.map((x: any) => [x.name, x.role, x.bank_account_id === samBank ? "bank" : x.bank_account_id]), [["Sam", "write", "bank"], ["Rae", "read", null]]);
eq("other merchant sees none", (await call("GET", "/v1/staff", { token: O })).json.staff.length, 0);
eq("other merchant cannot patch/delete", [(await call("PATCH", `/v1/staff/${staffList[0].id}`, { token: O, body: { role: "read" } })).status, (await call("DELETE", `/v1/staff/${staffList[0].id}`, { token: O })).status], [404, 404]);

// ============ refunds: direct (allow_refunds = true) ============
const adaPay = (await q("select id from txn where idempotency_key like '%:t:att-1'"))[0].id; // 2500 tag payment
const adaB0 = (await bal(A)).balance, shopB0 = (await bal(S)).balance;
eq("terminal required", (await call("POST", "/v1/terminal/refunds", { token: A, key: "r0", body: { attempt: "att-1", mode: "full" } })).status, 401);
eq("key required", (await call("POST", "/v1/terminal/refunds", { token: T1d, body: { attempt: "att-1", mode: "full" } })).status, 400);
eq("partial needs amount", (await call("POST", "/v1/terminal/refunds", { token: T1d, key: "r1", body: { attempt: "att-1", mode: "partial" } })).status, 400);
eq("full must not carry amount", (await call("POST", "/v1/terminal/refunds", { token: T1d, key: "r1", body: { attempt: "att-1", mode: "full", amount: 5 } })).status, 400);
eq("exactly one of payment_id/attempt", (await call("POST", "/v1/terminal/refunds", { token: T1d, key: "r1", body: { mode: "full" } })).status, 400);
const pr = await call("POST", "/v1/terminal/refunds", { token: T1d, key: "r-p1", body: { attempt: "att-1", mode: "partial", amount: 1000 } });
eq("partial refund by attempt id", [pr.status, pr.json.refund.status, pr.json.refund.amount, pr.json.refund.remaining_refundable, pr.json.refund.approver_account_id, pr.json.refund.payment_id], [201, "completed", 1000, 1500, null, adaPay]);
eq("customer credited immediately, merchant debited", [(await bal(A)).balance, (await bal(S)).balance], [adaB0 + 1000, shopB0 - 1000]);
eq("refund replay returns original, no double credit", [(await call("POST", "/v1/terminal/refunds", { token: T1d, key: "r-p1", body: { attempt: "att-1", mode: "partial", amount: 1000 } })).status, (await bal(A)).balance], [200, adaB0 + 1000]);
const full = await call("POST", "/v1/terminal/refunds", { token: T1d, key: "r-f1", body: { payment_id: adaPay, mode: "full" } });
eq("full refunds what is left", [full.status, full.json.refund.amount, full.json.refund.remaining_refundable], [201, 1500, 0]);
eq("nothing left to refund", (await call("POST", "/v1/terminal/refunds", { token: T1d, key: "r-f2", body: { payment_id: adaPay, mode: "full" } })).json.error, "already_refunded");
const over = await call("POST", "/v1/terminal/refunds", { token: T1d, key: "r-x1", body: { payment_id: adaPay, mode: "partial", amount: 1 } });
eq("partial beyond remaining declined + recorded", [over.status, over.json.status_code, (await q("select status from txn where idempotency_key like '%:r-x1'"))[0].status], [422, "exceeds_refundable", "failed"]);
eq("unknown payment 404", (await call("POST", "/v1/terminal/refunds", { token: T1d, key: "r-n", body: { attempt: "nope", mode: "full" } })).status, 404);
eq("other merchant's payment 404", (await call("POST", "/v1/terminal/refunds", { token: otherT0, key: "r-o", body: { payment_id: adaPay, mode: "full" } })).status, 404);
eq("failed/declined payment not refundable", (await call("POST", "/v1/terminal/refunds", { token: T1d, key: "r-d", body: { attempt: "g-10", mode: "full" } })).json.error, "payment_not_refundable");
eq("reused key for another payment 409", (await call("POST", "/v1/terminal/refunds", { token: T1d, key: "r-p1", body: { attempt: "att-4", mode: "full" } })).status, 409);
eq("refund rows carry terminal + related payment", (await q("select terminal_id=$1 as t, related_transaction_id=$2 as r, to_wallet_id=$3 as w, from_wallet_id is not null as nf from txn where idempotency_key like '%:r-p1' and type='refund'", [t1id, adaPay, ada.default_wallet_id]))[0], { t: true, r: true, w: true, nf: true });

// credit restored first, bounded by what is still owed
const dee = await signup("Dee", "dee@example.com");
await fund(dee.session_token, 1000, "fd");
await q("update balances set credit_limit=3000 where account_id=$1", [dee.account_id]);
const deeTag = await newTag(dee.default_wallet_id);
const deePay = await tpay(T1d, urlFor(deeTag.uid, 1), 2500, "dee-1");
const deeState = async () => (await q("select balance::int b, credit_spent::int c from balances where account_id=$1", [dee.account_id]))[0];
eq("dee paid 1000 balance + 1500 credit", [deePay.status, await deeState()], [201, { b: 0, c: 1500 }]);
await call("POST", "/v1/terminal/refunds", { token: T1d, key: "dee-r1", body: { attempt: "dee-1", mode: "partial", amount: 1000 } });
eq("first 1000 restores credit before balance", await deeState(), { b: 0, c: 500 });
await call("POST", "/v1/terminal/refunds", { token: T1d, key: "dee-r2", body: { attempt: "dee-1", mode: "full" } });
eq("rest: 500 credit then 1000 to balance", await deeState(), { b: 1000, c: 0 });
eq("refund restores credit first", (await q("select amount::int a, credit_amount::int c from transactions where idem like '%:dee-r2' and type='refund'")), [{ a: 1500, c: 500 }]);
// credit already repaid: refund goes to balance, never below zero credit
const eli = await signup("Eli", "eli@example.com");
await fund(eli.session_token, 500, "fe");
await q("update balances set credit_limit=2000 where account_id=$1", [eli.account_id]);
const eliTag = await newTag(eli.default_wallet_id);
await tpay(T1d, urlFor(eliTag.uid, 1), 1500, "eli-1");           // 500 balance + 1000 credit
await fund(eli.session_token, 1000, "fe2");                       // repays the 1000 credit
await call("POST", "/v1/terminal/refunds", { token: T1d, key: "eli-r", body: { attempt: "eli-1", mode: "full" } });
eq("repaid credit => refund is funded balance", (await q("select balance::int b, credit_spent::int c from balances where account_id=$1", [eli.account_id]))[0], { b: 1500, c: 0 });
eq("refund funds are immediately payable and sendable", (await bal(eli.session_token)).available_to_send, 1500);

// merchant may go negative (e.g. after its balance was paid out): use a dedicated merchant
const neg = await signup("Neg Shop", "neg@example.com", "B");
const negT = (await call("POST", "/v1/terminals", { token: neg.session_token, body: { name: "N1" } })).json.session_token;
const pat = await signup("Pat", "pat@example.com");
await fund(pat.session_token, 400, "fp");
const patTag = await newTag(pat.default_wallet_id);
eq("pay neg merchant", (await tpay(negT, urlFor(patTag.uid, 1), 400, "pat-1")).status, 201);
await q("update balances set balance = 0 where account_id=$1", [neg.account_id]);   // simulate payout of the 400
eq("refund after payout succeeds", (await call("POST", "/v1/terminal/refunds", { token: negT, key: "pat-r", body: { attempt: "pat-1", mode: "full" } })).status, 201);
eq("merchant balance goes negative; customer paid back immediately", [(await bal(neg.session_token)).balance, (await bal(pat.session_token)).available_to_send], [-400, 400]);

// parallel partial refunds can never exceed the payment
const bigPay = await tpay(T1d, urlFor((await newTag(ada.default_wallet_id)).uid, 1), 1000, "par-pay");
const pres = await Promise.all(Array.from({ length: 6 }, (_, i) => call("POST", "/v1/terminal/refunds", { token: T1d, key: `par-r-${i}`, body: { attempt: "par-pay", mode: "partial", amount: 300 } })));
eq("parallel partial refunds: 3 succeed, total <= payment", [pres.filter((r) => r.status === 201).length, pres.filter((r) => r.status === 422).length, (await q("select coalesce(sum(amount),0)::int s from transactions where related_id=$1 and status='completed'", [bigPay.json.payment.id]))[0].s], [3, 3, 900]);
const dupR = await Promise.all(Array.from({ length: 5 }, () => call("POST", "/v1/terminal/refunds", { token: T1d, key: "par-r-dup", body: { attempt: "par-pay", mode: "partial", amount: 100 } })));
eq("parallel duplicate refund: one refund", [new Set(dupR.map((r) => r.json.refund?.id)).size, (await q("select count(*)::int n from transactions where type='refund' and idem like '%:par-r-dup'"))[0].n], [1, 1]);

// ============ refunds: approval-required terminal ============
await call("PATCH", `/v1/terminals/${t1id}`, { token: S, body: { allow_refunds: false } });
const samTag = await newTag(sam.default_wallet_id), raeTag = await newTag(rae.default_wallet_id), nobodyTag = await newTag(nobody.default_wallet_id);
const ctr = new Map<string, number>();
const next = (t: { uid: string }) => { const n = (ctr.get(t.uid) ?? 0) + 1; ctr.set(t.uid, n); return n; };
const tapUrl = (t: { uid: string }) => urlFor(t.uid, next(t));
const mkPay = async (att: string, amt: number) => (await tpay(T1d, urlFor((await newTag(ada.default_wallet_id)).uid, 1), amt, att)).json.payment.id as string;
const refund = (key: string, body: object, tap?: { uid: string }, token = T1d) =>
  call("POST", "/v1/terminal/refunds", { token, key, body: { ...body, ...(tap ? { approval: { credential: { type: "tag", url: tapUrl(tap) } } } : {}) } });
const act = (id: string, verb: "approve" | "reject", tap?: { uid: string }, token = T1d) =>
  call("POST", `/v1/terminal/refunds/${id}/${verb}`, { token, body: { approval: { credential: tap ? { type: "tag", url: tapUrl(tap) } : { type: "tag", url: "x" } } } });
const adaBal = async () => (await bal(A)).balance;
const ledgerLines = async (id: string) => (await q("select count(*)::int n from transactions where id=$1 and status='completed'", [id]))[0].n;

// -- missing approver => pending request, nothing moves
const pA = await mkPay("rp-A", 1000);
let a0 = await adaBal(), s0 = (await bal(S)).balance;
const rq = await refund("rq-1", { attempt: "rp-A", mode: "partial", amount: 400 });
eq("no tap on approval terminal => pending request (202)", [rq.status, rq.json.refund.status, rq.json.refund.status_code, rq.json.refund.approver_account_id, rq.json.refund.remaining_refundable], [202, "pending", "awaiting_approval", null, 600]);
eq("pending refund moves no money and posts nothing", [await adaBal(), (await bal(S)).balance, await ledgerLines(rq.json.refund.id)], [a0, s0, 0]);
eq("customer does not see the pending refund", (await call("GET", "/v1/activity?limit=100", { token: A })).json.items.some((i: any) => i.id === rq.json.refund.id), false);
eq("merchant sees it in activity", (await call("GET", "/v1/activity?limit=100", { token: S })).json.items.some((i: any) => i.id === rq.json.refund.id && i.status === "pending"), true);
eq("same key returns the same pending request", (await refund("rq-1", { attempt: "rp-A", mode: "partial", amount: 400 })).json.refund.id, rq.json.refund.id);
const pendList = (await call("GET", "/v1/terminal/refunds?status=pending", { token: T1d })).json.refunds;
const mine = pendList.find((r: any) => r.id === rq.json.refund.id);
eq("terminal lists pending refunds with context", [mine.amount, mine.payment_amount, mine.attempt, mine.payer.display_name], [400, 1000, "rp-A", "Ada"]);
eq("reservation: more than what is left is declined", (await refund("rq-2", { attempt: "rp-A", mode: "partial", amount: 700 })).json.status_code, "exceeds_refundable");
const rqFull = await refund("rq-3", { attempt: "rp-A", mode: "full" });
eq("full request reserves exactly the remainder", [rqFull.status, rqFull.json.refund.amount, rqFull.json.refund.remaining_refundable], [202, 600, 0]);
eq("nothing left to request", (await refund("rq-4", { attempt: "rp-A", mode: "full" })).json.error, "refund_pending");
// approve by write-staff tap
eq("approve needs a tap body", (await call("POST", `/v1/terminal/refunds/${rq.json.refund.id}/approve`, { token: T1d, body: {} })).status, 400);
eq("non-staff tap cannot approve", (await act(rq.json.refund.id, "approve", nobodyTag)).json.error, "approver_not_authorized");
eq("read-only staff cannot approve", (await act(rq.json.refund.id, "approve", raeTag)).json.error, "approver_not_authorized");
eq("still pending after refused approvals", (await q("select status from refunds where id=$1", [rq.json.refund.id]))[0].status, "pending");
const ap = await act(rq.json.refund.id, "approve", samTag);
eq("write staff tap approves the pending refund", [ap.status, ap.json.refund.status, ap.json.refund.approver_account_id, ap.json.refund.amount], [201, "completed", sam.account_id, 400]);
eq("approval moved the money", [await adaBal(), (await bal(S)).balance], [a0 + 400, s0 - 400]);
eq("approval wrote the refund transaction under the request's id", (await q("select count(*)::int c, bool_and(account_id = $2) by_approver from transactions where id=$1 and type='refund'", [rq.json.refund.id, sam.account_id]))[0], { c: 1, by_approver: true });
eq("approve replay returns recorded, no tap needed, no 2nd credit", [(await act(rq.json.refund.id, "approve")).status, await adaBal()], [200, a0 + 400]);
eq("cannot reject a completed refund", (await act(rq.json.refund.id, "reject", samTag)).json.error, "refund_not_pending");
eq("no longer in the pending list", (await call("GET", "/v1/terminal/refunds?status=pending", { token: T1d })).json.refunds.some((r: any) => r.id === rq.json.refund.id), false);

// -- unauthorized tap => pending too, and the tap is burned
const pB = await mkPay("rp-B", 500);
const raeUrl = urlFor(raeTag.uid, 50);
const un = await call("POST", "/v1/terminal/refunds", { token: T1d, key: "un-1", body: { attempt: "rp-B", mode: "full", approval: { credential: { type: "tag", url: raeUrl } } } });
eq("read-only staff tap => pending, approver not recorded", [un.status, un.json.refund.status, un.json.refund.approver_account_id], [202, "pending", null]);
eq("unauthorized tap is still burned", (await q("select counter::int c from tags where id=$1", [raeTag.id]))[0].c, 50);
eq("burned tap cannot be reused", (await call("POST", "/v1/terminal/refunds", { token: T1d, key: "un-2", body: { attempt: "rp-A", mode: "full", approval: { credential: { type: "tag", url: raeUrl } } } })).json.error, "proof_replayed");
eq("lost-response retry of the unauthorized tap returns the pending request", (await call("POST", "/v1/terminal/refunds", { token: T1d, key: "un-1", body: { attempt: "rp-B", mode: "full", approval: { credential: { type: "tag", url: raeUrl } } } })).json.refund.id, un.json.refund.id);
eq("unassigned approval tap is an error, not a request", (await refund("un-3", { attempt: "rp-B", mode: "full" }, await newTag(null))).json.error, "tag_unassigned");
eq("garbage approval tap 400", (await call("POST", "/v1/terminal/refunds", { token: T1d, key: "un-4", body: { attempt: "rp-B", mode: "full", approval: { credential: { type: "tag", url: "https://tag.nclr.app/v1/zz" } } } })).json.error, "invalid_tag");
eq("pass approval not yet verifiable", (await call("POST", "/v1/terminal/refunds", { token: T1d, key: "un-5", body: { attempt: "rp-B", mode: "full", approval: { credential: { type: "pass", id: "x" } } } })).status, 501);

// -- reject via terminal tap releases the reservation
const rj = await act(un.json.refund.id, "reject", samTag);
eq("write staff tap rejects", [rj.status, rj.json.refund.status, rj.json.refund.status_code], [200, "failed", "rejected"]);
eq("rejected moved nothing", [await ledgerLines(un.json.refund.id), (await q("select count(*)::int n from refunds where id=$1 and status='rejected' and approved_by_account_id is null", [un.json.refund.id]))[0].n], [0, 1]);
eq("reject is idempotent", (await act(un.json.refund.id, "reject")).status, 200);
eq("cannot approve a rejected refund", (await act(un.json.refund.id, "approve", samTag)).json.error, "refund_not_pending");
eq("reservation released after reject", (await refund("un-6", { attempt: "rp-B", mode: "full" })).json.refund.amount, 500);
eq("reject by non-staff 403", (await act((await refund("un-7", { attempt: "att-4", mode: "partial", amount: 10 })).json.refund.id, "reject", nobodyTag)).json.error, "approver_not_authorized");

// -- no expiry: an old request is still listed and approvable
const pC = await mkPay("rp-C", 300);
const old = await refund("old-1", { attempt: "rp-C", mode: "full" });
await q("update refunds set created_at = now() - interval '90 days' where id=$1", [old.json.refund.id]);
eq("90-day-old request is still pending and listed", (await call("GET", "/v1/terminal/refunds?status=pending&limit=100", { token: T1d })).json.refunds.some((r: any) => r.id === old.json.refund.id), true);
eq("and still approvable", (await act(old.json.refund.id, "approve", samTag)).json.refund.status, "completed");

// -- owner (merchant portal)
const pD = await mkPay("rp-D", 800);
const ownerReq = await refund("own-1", { attempt: "rp-D", mode: "partial", amount: 200 });
const ownerReq2 = await refund("own-2", { attempt: "rp-D", mode: "partial", amount: 100 });
eq("consumer cannot use /v1/refunds", (await call("GET", "/v1/refunds", { token: A })).status, 403);
eq("terminal JWT is not an owner session", (await call("GET", "/v1/refunds", { token: T1d })).status, 401);
eq("owner lists pending refunds", (await call("GET", "/v1/refunds", { token: S })).json.refunds.filter((r: any) => [ownerReq.json.refund.id, ownerReq2.json.refund.id].includes(r.id)).length, 2);
eq("other merchant sees none of them", (await call("GET", "/v1/refunds", { token: O })).json.refunds.length, 0);
eq("other merchant cannot approve", (await call("POST", `/v1/refunds/${ownerReq.json.refund.id}/approve`, { token: O })).status, 404);
const a1 = await adaBal();
const oa = await call("POST", `/v1/refunds/${ownerReq.json.refund.id}/approve`, { token: S });
eq("owner approves; approver is the merchant account", [oa.status, oa.json.refund.status, oa.json.refund.approver_account_id, await adaBal()], [201, "completed", shop.account_id, a1 + 200]);
eq("owner approve is idempotent", [(await call("POST", `/v1/refunds/${ownerReq.json.refund.id}/approve`, { token: S })).status, await adaBal()], [200, a1 + 200]);
const orj = await call("POST", `/v1/refunds/${ownerReq2.json.refund.id}/reject`, { token: S });
eq("owner rejects", [orj.status, orj.json.refund.status_code], [200, "rejected"]);
eq("owner filters by status", (await call("GET", "/v1/refunds?status=completed", { token: S })).json.refunds.some((r: any) => r.id === ownerReq.json.refund.id), true);
eq("bad status filter 400", (await call("GET", "/v1/refunds?status=weird", { token: S })).status, 400);

// -- reservations under concurrency
const pE = await mkPay("rp-E", 1000);
const par = await Promise.all(Array.from({ length: 6 }, (_, i) => refund(`rq-par-${i}`, { attempt: "rp-E", mode: "partial", amount: 300 })));
eq("parallel requests: 3 reserve, 3 declined, never over the payment", [par.filter((r) => r.status === 202).length, par.filter((r) => r.status === 422).length,
  (await q("select (coalesce((select sum(amount) from transactions where related_id=$1 and status='completed'),0) + coalesce((select sum(amount) from refunds where pay_transaction_id=$1 and status='pending'),0))::int s", [pE]))[0].s], [3, 3, 900]);
const parIds = par.filter((r) => r.status === 202).map((r) => r.json.refund.id);
const pa = await Promise.all([...parIds, ...parIds].map((id) => call("POST", `/v1/refunds/${id}/approve`, { token: S })));
eq("parallel duplicate approvals: each refund paid exactly once", [(await q("select count(*)::int n from transactions where related_id=$1 and status='completed'", [pE]))[0].n,
  (await q("select coalesce(sum(amount),0)::int d from transactions where related_id=$1 and status='completed'", [pE]))[0].d, pa.every((r) => [200, 201].includes(r.status))], [3, 900, true]);

// -- removed staff cannot approve
const pF = await mkPay("rp-F", 100);
const rmReq = await refund("rm-1", { attempt: "rp-F", mode: "full" });
await call("DELETE", `/v1/staff/${staffList[0].id}`, { token: S });
eq("removed staff can no longer approve", (await act(rmReq.json.refund.id, "approve", samTag)).json.error, "approver_not_authorized");
await call("POST", "/v1/staff", { token: S, body: { staff_account_id: sam.account_id, role: "write" } });
eq("re-added staff can", (await act(rmReq.json.refund.id, "approve", samTag)).json.refund.status, "completed");

// -- direct-allowed terminal
await call("PATCH", `/v1/terminals/${t1id}`, { token: S, body: { allow_refunds: true } });
const samLook = await lookup(tapUrl(samTag));
eq("lookup reports staff role for this merchant", [samLook.json.account.account_id, samLook.json.account.staff], [sam.account_id, { role: "write" }]);
const pG = await mkPay("rp-G", 200);
const dir = await refund("dir-1", { attempt: "rp-G", mode: "partial", amount: 50 });
eq("direct-allowed terminal refunds immediately, approver null", [dir.status, dir.json.refund.status, dir.json.refund.approver_account_id], [201, "completed", null]);
const tapOk = await refund("dir-2", { attempt: "rp-G", mode: "partial", amount: 50 }, samTag);
eq("a staff tap on a direct-allowed terminal records the approver", [tapOk.status, tapOk.json.refund.approver_account_id], [201, sam.account_id]);
const tapBad = await refund("dir-3", { attempt: "rp-G", mode: "partial", amount: 50 }, nobodyTag);
eq("a non-staff tap on a direct-allowed terminal queues instead of refunding", [tapBad.status, tapBad.json.refund.status], [202, "pending"]);

// ============ refunds in activity ============
const aliAct = (await call("GET", "/v1/activity?limit=100", { token: A })).json.items.find((i: any) => i.id === pr.json.refund.id);
eq("customer sees refund from merchant", [aliAct.type, aliAct.direction, aliAct.counterparty.display_name], ["refund", "in", "Shop"]);
const shopAct = (await call("GET", "/v1/activity?limit=100", { token: S })).json.items.find((i: any) => i.id === pr.json.refund.id);
eq("merchant sees refund to member", [shopAct.direction, shopAct.counterparty.display_name], ["out", "Ada"]);

// ============ catalogue: sales, stock, restock ============
import { resetDailyCounters } from "./db.ts";
const mkProduct = async (acct: string, name: string, price: number, o: { stock?: number | null; discount?: number; active?: boolean; status?: string; currency?: string } = {}) =>
  (await q("insert into products(account_id,name,price,discount,stock,active,status,currency) values($1,$2,$3,$4,$5,$6,$7,$8) returning id",
    [acct, name, price, o.discount ?? 0, o.stock === undefined ? null : o.stock, o.active ?? true, o.status ?? "available", o.currency ?? "USD"]))[0].id as string;
const prod = async (id: string) => (await q("select stock, status, active, total_sold::int total_sold, (case when sold_day = program_today() then sold_today else 0 end) sold_today from products where id=$1", [id]))[0];
const buyer = await signup("Buyer", "buyer@example.com");
await fund(buyer.session_token, 50000, "fbuy");
const buyTag = async () => newTag(buyer.default_wallet_id);
const sale = (items: object[], key: string, tag: { uid: string }, extra: object = {}, counter = 1, token = T1d) =>
  call("POST", "/v1/terminal/payments", { token, key, body: { items, credential: { type: "tag", url: urlFor(tag.uid, counter) }, ...extra } });

const cola = await mkProduct(shop.account_id, "Cola", 300, { stock: 3, discount: 50 });
const water = await mkProduct(shop.account_id, "Water", 150);                       // stock not tracked
const chips = await mkProduct(shop.account_id, "Chips", 200, { stock: 5, active: false });
const gum = await mkProduct(shop.account_id, "Gum", 100, { stock: 2 });
const otherProd = await mkProduct(other.account_id, "Foreign", 100, { stock: 5 });

const plist = (await call("GET", "/v1/terminal/products", { token: T1d })).json.products;
eq("terminal lists active products with effective price, hides inactive", [plist.map((p: any) => p.name).sort(), plist.find((p: any) => p.name === "Cola").effective_price], [["Cola", "Gum", "Water"], 250]);
eq("product list needs terminal JWT", (await call("GET", "/v1/terminal/products", { token: S })).status, 401);
eq("other merchant sees only its own", (await call("GET", "/v1/terminal/products", { token: otherT0 })).json.products.map((p: any) => p.name), ["Foreign"]);

// sale decrements stock, prices from catalogue (price - discount)
const t1x = await buyTag();
const s1 = await sale([{ product_id: cola, quantity: 2 }], "cat-1", t1x);
eq("sale priced from catalogue", [s1.status, s1.json.payment.amount, s1.json.payment.status], [201, 500, "completed"]);
eq("stock decremented, counters bumped", await prod(cola), { stock: 1, status: "available", active: true, total_sold: 2, sold_today: 2 });
eq("replayed attempt does not decrement again", [(await sale([{ product_id: cola, quantity: 2 }], "cat-1", t1x)).status, (await prod(cola)).stock], [200, 1]);
eq("amount that disagrees with the cart is refused", (await sale([{ product_id: cola, quantity: 1 }], "cat-2", await buyTag(), { amount: 999 })).json.error, "amount_mismatch");
const refusedTag = await buyTag();
await sale([{ product_id: cola, quantity: 1 }], "cat-2b", refusedTag, { amount: 999 });
eq("a refused cart does not burn the tap", (await q("select counter from tags where id=$1", [refusedTag.id]))[0].counter, null);
const s2 = await sale([{ product_id: cola, quantity: 1 }], "cat-3", await buyTag(), { amount: 250 });
eq("matching explicit amount accepted; last unit => sold_out", [s2.status, await prod(cola)], [201, { stock: 0, status: "sold_out", active: true, total_sold: 3, sold_today: 3 }]);
eq("sold-out product cannot be sold", (await sale([{ product_id: cola, quantity: 1 }], "cat-4", await buyTag())).json.error, "product_unavailable");
eq("more than the stock refused", (await sale([{ product_id: gum, quantity: 3 }], "cat-5", await buyTag())).json.error, "out_of_stock");
eq("inactive product refused", (await sale([{ product_id: chips, quantity: 1 }], "cat-6", await buyTag())).json.error, "product_unavailable");
eq("unknown product 404", (await sale([{ product_id: "0190aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee", quantity: 1 }], "cat-7", await buyTag())).status, 404);
eq("another merchant's product 404", (await sale([{ product_id: otherProd, quantity: 1 }], "cat-8", await buyTag())).status, 404);
eq("quantity 0 / empty cart rejected", [(await sale([{ product_id: gum, quantity: 0 }], "cat-9", await buyTag())).status, (await sale([], "cat-10", await buyTag())).status], [400, 400]);
eq("neither amount nor items rejected", (await call("POST", "/v1/terminal/payments", { token: T1d, key: "cat-11", body: { credential: { type: "tag", url: urlFor((await buyTag()).uid, 1) } } })).status, 400);
const wsale = await sale([{ product_id: water, quantity: 3 }], "cat-12", await buyTag());
eq("untracked stock sells without limit", [wsale.json.payment.amount, await prod(water)], [450, { stock: null, status: "available", active: true, total_sold: 3, sold_today: 3 }]);
eq("same product on two lines is merged", (await sale([{ product_id: gum, quantity: 1 }, { product_id: gum, quantity: 1 }], "cat-13", await buyTag())).json.payment.amount, 200);
eq("merged lines used all stock => sold_out", (await prod(gum)).status, "sold_out");
const eur = await mkProduct(shop.account_id, "Euro item", 100, { stock: 5, currency: "EUR" });
eq("non-USD product refused", (await sale([{ product_id: eur, quantity: 1 }], "cat-14", await buyTag())).json.error, "currency_unsupported");

// a declined payment (no funds) leaves stock untouched
const broke = await signup("Broke", "broke@example.com");
const brokeTag = await newTag(broke.default_wallet_id);
const pen = await mkProduct(shop.account_id, "Pen", 100, { stock: 4 });
const brokeSale = await sale([{ product_id: pen, quantity: 2 }], "cat-15", brokeTag);
eq("insufficient funds declined, stock untouched", [brokeSale.status, brokeSale.json.status_code, await prod(pen)], [422, "insufficient_balance", { stock: 4, status: "available", active: true, total_sold: 0, sold_today: 0 }]);

// customer-confirmed path with items
const cs = await call("POST", "/v1/payments", { token: buyer.session_token, key: "cc-1", body: { terminal_id: t1id, items: [{ product_id: pen, quantity: 1 }] } });
eq("customer-confirmed payment with items", [cs.status, cs.json.payment.amount, (await prod(pen)).stock], [201, 100, 3]);
eq("customer path: replay does not decrement twice", [(await call("POST", "/v1/payments", { token: buyer.session_token, key: "cc-1", body: { terminal_id: t1id, items: [{ product_id: pen, quantity: 1 }] } })).status, (await prod(pen)).stock], [200, 3]);
eq("customer path: amount mismatch", (await call("POST", "/v1/payments", { token: buyer.session_token, key: "cc-2", body: { terminal_id: t1id, amount: 1, items: [{ product_id: pen, quantity: 1 }] } })).json.error, "amount_mismatch");
eq("customer path: needs amount or items", (await call("POST", "/v1/payments", { token: buyer.session_token, key: "cc-3", body: { terminal_id: t1id } })).status, 400);

// overselling under concurrency: stock 3, six parallel one-unit sales
const hot = await mkProduct(shop.account_id, "Hot item", 100, { stock: 3 });
const hotTags = await Promise.all(Array.from({ length: 6 }, () => buyTag()));
const hr = await Promise.all(hotTags.map((t, i) => sale([{ product_id: hot, quantity: 1 }], `hot-${i}`, t)));
const stockOut = (r: any) => r.status === 422 && (["out_of_stock", "product_unavailable"].includes(r.json.error) || ["out_of_stock", "product_unavailable"].includes(r.json.status_code));
eq("parallel sales never oversell: exactly 3 succeed, the rest are turned away", [hr.filter((r) => r.status === 201).length, hr.filter(stockOut).length, await prod(hot)], [3, 3, { stock: 0, status: "sold_out", active: true, total_sold: 3, sold_today: 3 }]);
eq("any recorded out_of_stock decline moved no money", (await q("select count(*)::int n from transactions t where t.idem like '%:t:hot-%' and t.status='declined' and exists (select 1 from account_effects e where e.tx_id=t.id)"))[0].n, 0);
// force the in-transaction path: all six pass pricing (stock 3), then race for the lock
const hot2 = await mkProduct(shop.account_id, "Hot item 2", 100, { stock: 1 });
const lockTags = await Promise.all(Array.from({ length: 4 }, () => buyTag()));
const lr = await Promise.all(lockTags.map((t, i) => sale([{ product_id: hot2, quantity: 1 }], `hot2-${i}`, t)));
eq("racing for the last unit: exactly one wins", [lr.filter((r) => r.status === 201).length, (await prod(hot2)).stock, (await prod(hot2)).total_sold], [1, 0, 1]);

// restock
const rs1 = await call("POST", `/v1/terminal/products/${cola}/restock`, { token: T1d, body: { quantity: 10 } });
eq("restock a sold-out product: stock up, available again", [rs1.status, rs1.json.product.stock, rs1.json.product.status], [200, 10, "available"]);
eq("sells again after restock", (await sale([{ product_id: cola, quantity: 1 }], "cat-16", await buyTag())).status, 201);
eq("stale expected_stock refused", (await call("POST", `/v1/terminal/products/${cola}/restock`, { token: T1d, body: { quantity: 5, expected_stock: 10 } })).json.error, "stock_changed");
eq("matching expected_stock accepted", (await call("POST", `/v1/terminal/products/${cola}/restock`, { token: T1d, body: { quantity: 5, expected_stock: 9 } })).json.product.stock, 14);
eq("untracked product cannot be restocked", (await call("POST", `/v1/terminal/products/${water}/restock`, { token: T1d, body: { quantity: 5 } })).json.error, "stock_not_tracked");
eq("other merchant's product 404", (await call("POST", `/v1/terminal/products/${otherProd}/restock`, { token: T1d, body: { quantity: 5 } })).status, 404);
eq("inactive product 404", (await call("POST", `/v1/terminal/products/${chips}/restock`, { token: T1d, body: { quantity: 5 } })).status, 404);
for (const bad of [0, -3, 1.5, "5"]) eq(`restock quantity ${JSON.stringify(bad)} rejected`, (await call("POST", `/v1/terminal/products/${cola}/restock`, { token: T1d, body: { quantity: bad } })).status, 400);
await q("update products set stock = 2147483000 where id=$1", [cola]);
eq("stock cannot exceed int range", (await call("POST", `/v1/terminal/products/${cola}/restock`, { token: T1d, body: { quantity: 1000 } })).json.error, "stock_too_large");
await q("update products set stock = 14 where id=$1", [cola]);
eq("restock needs the terminal JWT", (await call("POST", `/v1/terminal/products/${cola}/restock`, { token: S, body: { quantity: 1 } })).status, 401);
const gumBefore = (await prod(gum)).stock;
const pr10 = await Promise.all(Array.from({ length: 5 }, () => call("POST", `/v1/terminal/products/${gum}/restock`, { token: T1d, body: { quantity: 10 } })));
eq("parallel restocks all land (increments, none lost)", [pr10.every((r) => r.status === 200), (await prod(gum)).stock, (await prod(gum)).status], [true, gumBefore! + 50, "available"]);

// database invariants
await q("update products set stock = 0 where id=$1", [cola]);
eq("stock 0 flags sold_out in the database", (await prod(cola)).status, "sold_out");
await q("update products set stock = 7 where id=$1", [cola]);
eq("stock above 0 makes it available", (await prod(cola)).status, "available");
let negErr = "none"; try { await q("update products set stock = -1 where id=$1", [cola]); } catch (e: any) { negErr = e.constraint_name ?? e.code; }
eq("negative stock rejected", negErr, "products_stock_check");
let stErr = "none"; try { await q("update products set status = 'unavailable' where id=$1", [water]); } catch (e: any) { stErr = e.constraint_name ?? e.code; }
eq("only available / sold_out statuses exist", stErr, "products_status_check");
await q("update products set status = 'sold_out' where id=$1", [water]);
eq("untracked product keeps a manual status", (await prod(water)).status, "sold_out");
await q("update products set status = 'available' where id=$1", [water]);

// daily refresh
const beforeReset = await prod(hot);
const reset = await resetDailyCounters(connect(env));
eq("daily reset zeroes sold_today, keeps total_sold", [(await prod(hot)).sold_today, (await prod(hot)).total_sold, reset.products >= 1], [0, beforeReset.total_sold, true]);
eq("reset also cleared wallet counters", (await q("select count(*)::int n from wallets where spent_today <> 0 and spent_day = program_today()"))[0].n, 0);

// ============ checkouts (orders) ============
const mkCo = (body: object, token = T1d) => call("POST", "/v1/terminal/checkouts", { token, body });
const payCo = (coId: string, key: string, tag: { uid: string }, counter = 1, token = T1d) =>
  call("POST", "/v1/terminal/payments", { token, key, body: { checkout_id: coId, credential: { type: "tag", url: urlFor(tag.uid, counter) } } });
const widget = await mkProduct(shop.account_id, "Widget", 500, { stock: 10 });
const gadget = await mkProduct(shop.account_id, "Gadget", 300, { stock: 5, discount: 100 });
const stockOf = async (id: string) => (await prod(id)).stock;

const co1 = await mkCo({ items: [{ product_id: widget, quantity: 2 }, { product_id: gadget, quantity: 1 }], reference: "TABLE-4" });
eq("checkout created with snapshotted items", [co1.status, co1.json.checkout.status, co1.json.checkout.total, co1.json.checkout.reference, co1.json.checkout.items.map((i: any) => [i.name, i.quantity, i.net_price])], [201, "open", 1200, "TABLE-4", [["Widget", 2, 500], ["Gadget", 1, 200]]]);
eq("stock is NOT taken at checkout creation", [await stockOf(widget), await stockOf(gadget)], [10, 5]);
eq("amount-only checkout", (await mkCo({ amount: 750, reference: "KEYED" })).json.checkout.items, []);
eq("checkout amount mismatch 400", (await mkCo({ items: [{ product_id: widget, quantity: 1 }], amount: 1 })).json.error, "amount_mismatch");
eq("checkout unknown product 404", (await mkCo({ items: [{ product_id: "0190aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee", quantity: 1 }] })).status, 404);
eq("checkout needs amount or items", (await mkCo({})).status, 400);
eq("checkout of another merchant's product 404", (await mkCo({ items: [{ product_id: otherProd, quantity: 1 }] })).status, 404);
eq("terminal reads its checkout", (await call("GET", `/v1/terminal/checkouts/${co1.json.checkout.id}`, { token: T1d })).json.checkout.total, 1200);
eq("other merchant cannot read it", (await call("GET", `/v1/terminal/checkouts/${co1.json.checkout.id}`, { token: otherT0 })).status, 404);
eq("open checkouts listed", (await call("GET", "/v1/terminal/checkouts?status=open", { token: T1d })).json.checkouts.some((x: any) => x.id === co1.json.checkout.id), true);
const custView = await call("GET", `/v1/checkouts/${co1.json.checkout.id}`, { token: buyer.session_token });
eq("customer sees merchant, items and total", [custView.json.checkout.merchant.display_name, custView.json.checkout.total, custView.json.checkout.items.length], ["Shop", 1200, 2]);
eq("unknown checkout 404", (await call("GET", "/v1/checkouts/0190aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee", { token: buyer.session_token })).status, 404);
eq("checkout view needs a customer session", (await call("GET", `/v1/checkouts/${co1.json.checkout.id}`, { token: T1d })).status, 401);

// pay it by tap
const coTag = await buyTag();
const paid1 = await payCo(co1.json.checkout.id, "co-pay-1", coTag);
eq("tap pays the checkout for its total", [paid1.status, paid1.json.payment.amount, paid1.json.payment.checkout_id === co1.json.checkout.id, paid1.json.payment.reference], [201, 1200, true, "TABLE-4"]);
eq("stock taken at payment, checkout paid", [await stockOf(widget), await stockOf(gadget), (await call("GET", `/v1/terminal/checkouts/${co1.json.checkout.id}`, { token: T1d })).json.checkout.status], [8, 4, "paid"]);
eq("paid checkout links its payment", (await call("GET", `/v1/terminal/checkouts/${co1.json.checkout.id}`, { token: T1d })).json.payment.attempt, "co-pay-1");
eq("customer sees only the outcome of a paid checkout", Object.keys((await call("GET", `/v1/checkouts/${co1.json.checkout.id}`, { token: buyer.session_token })).json.checkout).sort(), ["id", "merchant", "status"]);
const burnTag = await buyTag();
eq("paying a paid checkout is refused before the tap is used", [(await payCo(co1.json.checkout.id, "co-pay-2", burnTag)).json.error, (await q("select counter from tags where id=$1", [burnTag.id]))[0].counter], ["checkout_paid", null]);
eq("lost-response retry returns the recorded payment", [(await payCo(co1.json.checkout.id, "co-pay-1", coTag)).status, await stockOf(widget)], [200, 8]);
eq("checkout_id cannot be mixed with amount", (await call("POST", "/v1/terminal/payments", { token: T1d, key: "co-x", body: { checkout_id: co1.json.checkout.id, amount: 5, credential: { type: "tag", url: urlFor(burnTag.uid, 1) } } })).status, 400);

// cancel / expire
const coC = (await mkCo({ amount: 100 })).json.checkout.id;
eq("cancel an open checkout", (await call("POST", `/v1/terminal/checkouts/${coC}/cancel`, { token: T1d })).json.checkout.status, "canceled");
eq("cancel is idempotent", (await call("POST", `/v1/terminal/checkouts/${coC}/cancel`, { token: T1d })).status, 200);
eq("canceled checkout cannot be paid", (await payCo(coC, "co-c1", await buyTag())).json.error, "checkout_not_open");
eq("paid checkout cannot be canceled", (await call("POST", `/v1/terminal/checkouts/${co1.json.checkout.id}/cancel`, { token: T1d })).json.error, "checkout_paid");
const coE = (await mkCo({ amount: 100, expires_in: 60 })).json.checkout.id;
await q("update checkouts set expires_at = now() - interval '1 minute' where id=$1", [coE]);
eq("expired checkout refused before the tap is used", (await payCo(coE, "co-e1", await buyTag())).json.error, "checkout_expired");
eq("customer sees an expired checkout as expired", (await call("GET", `/v1/checkouts/${coE}`, { token: buyer.session_token })).json.checkout.status, "expired");
eq("expires_in out of range rejected", (await mkCo({ amount: 100, expires_in: 5 })).status, 400);

// customer pays a checkout in their app; two customers race for one checkout
const coA = (await mkCo({ items: [{ product_id: widget, quantity: 1 }] })).json.checkout.id;
const cap = await call("POST", "/v1/payments", { token: buyer.session_token, key: "cap-1", body: { checkout_id: coA } });
eq("customer pays the checkout (merchant and terminal come from it)", [cap.status, cap.json.payment.amount, cap.json.payment.merchant.display_name, cap.json.payment.terminal_id === t1id, await stockOf(widget)], [201, 500, "Shop", true, 7]);
eq("customer replay returns the original", [(await call("POST", "/v1/payments", { token: buyer.session_token, key: "cap-1", body: { checkout_id: coA } })).status, await stockOf(widget)], [200, 7]);
const rival = await signup("Rival", "rival@example.com");
await fund(rival.session_token, 5000, "frv");
const coR = (await mkCo({ items: [{ product_id: widget, quantity: 1 }] })).json.checkout.id;
const race = await Promise.all([buyer.session_token, rival.session_token].map((t, i) => call("POST", "/v1/payments", { token: t, key: `race-${i}`, body: { checkout_id: coR } })));
eq("two customers, one checkout: exactly one pays", [race.filter((r) => r.status === 201).length, (await q("select count(*)::int n from transactions where checkout_id=$1 and status='completed'", [coR]))[0].n, await stockOf(widget)], [1, 1, 6]);

// a failed attempt leaves the checkout open for another try
const coF = (await mkCo({ amount: 40000 })).json.checkout.id;
const poorTag = await newTag(broke.default_wallet_id);
const failedTry = await payCo(coF, "co-f1", poorTag);
eq("insufficient funds declined, recorded against the checkout", [failedTry.status, failedTry.json.payment.checkout_id === coF, (await call("GET", `/v1/terminal/checkouts/${coF}`, { token: T1d })).json.checkout.status], [422, true, "open"]);
await fund(rival.session_token, 45000, "frv2");
eq("then another customer pays the same checkout", (await call("POST", "/v1/payments", { token: rival.session_token, key: "co-f2", body: { checkout_id: coF } })).status, 201);
// one-step declines do not leave open orders behind
const before1 = (await q("select count(*)::int n from checkouts where status='open'"))[0].n;
await tpay(T1d, urlFor((await newTag(broke.default_wallet_id)).uid, 1), 100, "co-os-1");
eq("a declined one-step payment leaves no open checkout", (await q("select count(*)::int n from checkouts where status='open'"))[0].n, before1);

// price snapshot and last-unit stock
const snap = await mkProduct(shop.account_id, "Snap", 400, { stock: 1 });
const coS1 = (await mkCo({ items: [{ product_id: snap, quantity: 1 }] })).json.checkout.id;
const coS2 = (await mkCo({ items: [{ product_id: snap, quantity: 1 }] })).json.checkout.id;
await q("update products set price = 999 where id=$1", [snap]);
eq("checkout pays its snapshot price, not the new price", (await payCo(coS1, "snap-1", await buyTag())).json.payment.amount, 400);
eq("second open checkout for the last unit is refused (stock taken at payment)", (await payCo(coS2, "snap-2", await buyTag())).json.error, "product_unavailable");
eq("other merchant cannot pay my checkout", (await payCo(coS2, "snap-3", await buyTag(), 1, otherT0)).status, 404);

// ============ item refunds ============
const itemPay = await call("POST", "/v1/terminal/checkouts", { token: T1d, body: { items: [{ product_id: widget, quantity: 3 }, { product_id: gadget, quantity: 2 }] } });
const itemCoId = itemPay.json.checkout.id;
await payCo(itemCoId, "ir-pay", await buyTag());
const view = (await call("GET", "/v1/terminal/payments/ir-pay", { token: T1d })).json;
const wi = view.items.find((i: any) => i.name === "Widget"), gi = view.items.find((i: any) => i.name === "Gadget");
eq("payment lookup lists items with refundable quantities", [wi.quantity, wi.refundable_quantity, gi.net_price], [3, 3, 200]);
const w0 = await stockOf(widget), g0 = await stockOf(gadget);
const lineCounts = async (id: string) => { const it = (await call("GET", "/v1/terminal/payments/ir-pay", { token: T1d })).json.items.find((i: any) => i.id === id); return { r: it.refunded_quantity, p: it.pending_refund_quantity }; };
const ir1 = await refund("ir-1", { attempt: "ir-pay", mode: "items", restock: true, items: [{ checkout_item_id: wi.id, quantity: 1 }] });
eq("item refund with restock:true: amount from the snapshot, restocked", [ir1.status, ir1.json.refund.amount, ir1.json.refund.items.map((x: any) => [x.checkout_item_id === wi.id, x.quantity, x.restock]), await stockOf(widget)], [201, 500, [[true, 1, true]], w0 + 1]);
eq("line counters: 1 refunded, none pending", await lineCounts(wi.id), { r: 1, p: 0 });
eq("item refund row points at the checkout and the pay", (await q("select checkout_id=$1 as co, related_id is not null as rel from transactions where idem like '%:ir-1' and type='refund'", [itemCoId]))[0], { co: true, rel: true });
eq("refundable quantity drops", (await call("GET", "/v1/terminal/payments/ir-pay", { token: T1d })).json.items.find((i: any) => i.name === "Widget").refundable_quantity, 2);
eq("more than what is left refused", (await refund("ir-2", { attempt: "ir-pay", mode: "items", items: [{ checkout_item_id: wi.id, quantity: 3 }] })).json.error, "item_quantity_exceeded");
eq("item from another order refused", (await refund("ir-3", { attempt: "ir-pay", mode: "items", items: [{ checkout_item_id: co1.json.checkout.items[0].id, quantity: 1 }] })).json.error, "item_not_found");
const ir4 = await refund("ir-4", { attempt: "ir-pay", mode: "items", restock: false, items: [{ checkout_item_id: gi.id, quantity: 1 }] });
eq("restock:false leaves stock alone", [ir4.json.refund.amount, ir4.json.refund.items[0].restock, await stockOf(gadget)], [200, false, g0]);
const defCo = await call("POST", "/v1/terminal/checkouts", { token: T1d, body: { items: [{ product_id: widget, quantity: 1 }] } });
await payCo(defCo.json.checkout.id, "ir-def-pay", await buyTag());
const defItem = (await call("GET", "/v1/terminal/payments/ir-def-pay", { token: T1d })).json.items[0];
const wDef = await stockOf(widget);
const irDef = await refund("ir-def", { attempt: "ir-def-pay", mode: "items", items: [{ checkout_item_id: defItem.id, quantity: 1 }] });
eq("restock defaults to false", [irDef.status, irDef.json.refund.items[0].restock, await stockOf(widget)], [201, false, wDef]);
eq("items mode needs items; others must not carry them", [
  (await refund("ir-5", { attempt: "ir-pay", mode: "items" })).status,
  (await refund("ir-6", { attempt: "ir-pay", mode: "full", items: [{ checkout_item_id: wi.id, quantity: 1 }] })).status,
  (await refund("ir-7", { attempt: "ir-pay", mode: "partial", amount: 5, restock: true })).status], [400, 400, 400]);
eq("a payment with no items cannot be item-refunded", (await refund("ir-8", { attempt: "po-none", mode: "items", items: [{ checkout_item_id: wi.id, quantity: 1 }] })).status, 404);
const keyed = await call("POST", "/v1/terminal/payments", { token: T1d, key: "keyed-1", body: { amount: 300, credential: { type: "tag", url: urlFor((await buyTag()).uid, 1) } } });
eq("amount-only order has no items to refund", (await refund("ir-9", { attempt: "keyed-1", mode: "items", items: [{ checkout_item_id: wi.id, quantity: 1 }] })).json.error, "payment_has_no_items");
const wBeforeAmt = await stockOf(widget);
eq("amount refunds do not touch items or stock", [(await refund("ir-10", { attempt: "keyed-1", mode: "partial", amount: 10 })).status, await stockOf(widget)], [201, wBeforeAmt]);

// pending item refund: reserves units, restocks only when approved
await call("PATCH", `/v1/terminals/${t1id}`, { token: S, body: { allow_refunds: false } });
const w1 = await stockOf(widget);
const pIr = await refund("ir-p1", { attempt: "ir-pay", mode: "items", restock: true, items: [{ checkout_item_id: wi.id, quantity: 2 }] });
eq("item refund without approval is pending, nothing moves", [pIr.status, pIr.json.refund.status, await stockOf(widget)], [202, "pending", w1]);
eq("pending units sit in refund_pending_quantity", await lineCounts(wi.id), { r: 1, p: 2 });
eq("pending units are reserved", (await call("GET", "/v1/terminal/payments/ir-pay", { token: T1d })).json.items.find((i: any) => i.name === "Widget").refundable_quantity, 0);
eq("no more can be requested", (await refund("ir-p2", { attempt: "ir-pay", mode: "items", items: [{ checkout_item_id: wi.id, quantity: 1 }] })).json.error, "item_quantity_exceeded");
eq("pending list shows item names", (await call("GET", "/v1/terminal/refunds?status=pending", { token: T1d })).json.refunds.find((r: any) => r.id === pIr.json.refund.id).items[0].name, "Widget");
eq("approval restocks", [(await act(pIr.json.refund.id, "approve", samTag)).json.refund.status, await stockOf(widget)], ["completed", w1 + 2]);
eq("approval moves pending units to refunded", await lineCounts(wi.id), { r: 3, p: 0 });
const gBefore = await lineCounts(gi.id);
const pIr2 = await refund("ir-p3", { attempt: "ir-pay", mode: "items", restock: true, items: [{ checkout_item_id: gi.id, quantity: 1 }] });
eq("reject releases the reserved units, restocks nothing", [(await act(pIr2.json.refund.id, "reject", samTag)).json.refund.status_code, await stockOf(gadget), (await call("GET", "/v1/terminal/payments/ir-pay", { token: T1d })).json.items.find((i: any) => i.name === "Gadget").refundable_quantity], ["rejected", g0, 1]);
eq("reject puts the reserved units back", await lineCounts(gi.id), gBefore);
await call("PATCH", `/v1/terminals/${t1id}`, { token: S, body: { allow_refunds: true } });

// parallel item refunds of one line can never exceed what was bought
const bigCo = await call("POST", "/v1/terminal/checkouts", { token: T1d, body: { items: [{ product_id: widget, quantity: 3 }] } });
await payCo(bigCo.json.checkout.id, "ir-big", await buyTag());
const bigItem = (await call("GET", "/v1/terminal/payments/ir-big", { token: T1d })).json.items[0];
const w2 = await stockOf(widget);
const itemPar = await Promise.all(Array.from({ length: 5 }, (_, i) => refund(`ir-par-${i}`, { attempt: "ir-big", mode: "items", restock: true, items: [{ checkout_item_id: bigItem.id, quantity: 1 }] })));
eq("parallel item refunds: exactly 3 succeed, stock back by 3", [itemPar.filter((r) => r.status === 201).length, itemPar.filter((r) => r.status === 422).length, await stockOf(widget)], [3, 2, w2 + 3]);

// database invariants
const pErr = async (sqlText: string, params: unknown[] = []) => { try { await q(sqlText, params); return "none"; } catch (e: any) { return e.constraint_name ?? e.code; } };
eq("a checkout can be settled by only one completed payment", await pErr("insert into transactions(type,status,from_wallet_id,to_wallet_id,amount,checkout_id,account_id,idem) values ('pay','completed',$1,$2,1,$3,$4,'dup-pay')", [buyer.default_wallet_id, shop.default_wallet_id, itemCoId, shop.account_id]), "transactions_checkout_paid_key");
eq("a refund cannot point at another merchant's checkout", await pErr("insert into transactions(type,status,from_wallet_id,to_wallet_id,amount,related_id,checkout_id,account_id,idem) select 'refund','completed',$1,$2,1,t.id,$3,$4,'bad-co' from transactions t where t.idem like '%:t:ir-pay'", [other.default_wallet_id, buyer.default_wallet_id, itemCoId, other.account_id]), "23514");
eq("a transaction is immutable: no update, no delete", [await pErr("update transactions set amount = amount + 1 where idem like '%:t:ir-pay'"), await pErr("delete from transactions where idem like '%:t:ir-pay'")], ["P0001", "P0001"]);
eq("an amount-only payment has no checkout, and neither has its refund", [keyed.json.payment.checkout_id, (await q("select checkout_id from transactions where idem like '%:ir-10' and type='refund'"))[0].checkout_id], [null, null]);

// ============ tags: claim, assign, lock, reset ============
const claimTag = (token: string, url: string, body: object = {}) => call("POST", "/v1/tags/claim", { token, body: { url, ...body } });
const cust = await signup("Tagger", "tagger@example.com");
const CT = cust.session_token;
const inv = await newTag(null);                 // factory inventory: a band with no owner
const unclaimed = (await q("select wallet_id, counter from tags where id=$1", [inv.id]))[0];
eq("inventory band starts unassigned with no counter", unclaimed, { wallet_id: null, counter: null });

const cl1 = await claimTag(CT, urlFor(inv.uid, 1), { label: "Red band" });
eq("claiming by tap puts the band on the default wallet", [cl1.status, cl1.json.tag.wallet_id === cust.default_wallet_id, cl1.json.tag.label, cl1.json.tag.locked, cl1.json.tag.model.type], [201, true, "Red band", false, "band"]);
eq("claim burned the proof", (await q("select counter::int c, last_read_at is not null as r from tags where id=$1", [inv.id]))[0], { c: 1, r: true });
eq("lost-response retry of the same tap returns the claim (200)", [(await claimTag(CT, urlFor(inv.uid, 1))).status, (await claimTag(CT, urlFor(inv.uid, 1))).json.tag.id === cl1.json.tag.id], [200, true]);
eq("the response never exposes the NFC UID", JSON.stringify(cl1.json).includes(inv.uid), false);
eq("a claimed band cannot be claimed again (tap burned)", [(await claimTag(CT, urlFor(inv.uid, 2))).json.error, (await q("select counter::int c from tags where id=$1", [inv.id]))[0].c], ["tag_already_claimed", 2]);
const stranger = await signup("Stranger", "stranger@example.com");
eq("another account cannot claim an assigned band", (await claimTag(stranger.session_token, urlFor(inv.uid, 3))).json.error, "tag_already_claimed");
eq("counter 0 is a valid first tap", (await claimTag(CT, urlFor((await newTag(null)).uid, 0))).status, 201);   // counter 0 is valid first use
const stale = await newTag(null);
await q("update tags set counter = 10 where id=$1", [stale.id]);
eq("a stale tap is refused and not burned", [(await claimTag(CT, urlFor(stale.uid, 5))).json.error, (await q("select counter::int c, wallet_id from tags where id=$1", [stale.id]))[0]], ["proof_replayed", { c: 10, wallet_id: null }]);
eq("garbage URL 400, unknown tag 404", [(await claimTag(CT, "https://tag.nclr.app/v1/nope")).json.error, (await claimTag(CT, urlFor("04cccccccccccc", 1))).json.error], ["invalid_tag", "tag_not_found"]);
eq("claim needs an owner session", (await claimTag(delegated, urlFor((await newTag(null)).uid, 1))).status, 403);
eq("claim needs a customer session", (await call("POST", "/v1/tags/claim", { token: T1d, body: { url: "x" } })).status, 401);

// claim straight onto a chosen wallet
const kidW = (await call("POST", "/v1/wallets", { token: CT, body: { display_name: "Kid", type: "person" } })).json.wallet.id;
const kidBand = await newTag(null);
const clKid = await claimTag(CT, urlFor(kidBand.uid, 1), { wallet_id: kidW });
eq("claim onto a specific wallet", [clKid.status, clKid.json.tag.wallet_id === kidW], [201, true]);
eq("claim onto another account's wallet refused (tap not burned)", [(await claimTag(CT, urlFor((await newTag(null)).uid, 1), { wallet_id: bob.default_wallet_id })).json.error], ["wallet_not_found"]);
const suspendedW = (await call("POST", "/v1/wallets", { token: CT, body: { display_name: "Frozen", type: "agent" } })).json.wallet.id;
await call("PATCH", `/v1/wallets/${suspendedW}`, { token: CT, body: { status: "suspended" } });
eq("claim onto a suspended wallet refused", (await claimTag(CT, urlFor((await newTag(null)).uid, 1), { wallet_id: suspendedW })).json.error, "wallet_not_found");

// a claimed band pays from its wallet
await fund(CT, 3000, "ftag");
eq("a claimed band can pay at a terminal", (await tpay(T1d, urlFor(inv.uid, 5), 400, "tag-pay-1")).status, 201);

// manage by tag id
const tagId = cl1.json.tag.id, kidTagId = clKid.json.tag.id;
eq("owner lists tags on the account", (await call("GET", "/v1/tags", { token: CT })).json.tags.map((t: any) => t.label).sort(), [null, null, "Red band"].sort());
eq("owner reads one tag by id", (await call("GET", `/v1/tags/${tagId}`, { token: CT })).json.tag.label, "Red band");
eq("someone else cannot read it", [(await call("GET", `/v1/tags/${tagId}`, { token: stranger.session_token })).status, (await call("PATCH", `/v1/tags/${tagId}`, { token: stranger.session_token, body: { locked: true } })).status, (await call("POST", `/v1/tags/${tagId}/reset`, { token: stranger.session_token })).status], [404, 404, 404]);
eq("rename + limit", await (async () => { const r = await call("PATCH", `/v1/tags/${tagId}`, { token: CT, body: { label: "Blue band", transaction_limit: 1000 } }); return [r.json.tag.label, r.json.tag.transaction_limit]; })(), ["Blue band", 1000]);
eq("limit is enforced at payment", (await tpay(T1d, urlFor(inv.uid, 6), 1500, "tag-pay-2")).json.status_code, "tag_limit_exceeded");
eq("limit can be cleared", (await call("PATCH", `/v1/tags/${tagId}`, { token: CT, body: { transaction_limit: null } })).json.tag.transaction_limit, null);
eq("lock blocks payments", [(await call("PATCH", `/v1/tags/${tagId}`, { token: CT, body: { locked: true } })).json.tag.locked, (await tpay(T1d, urlFor(inv.uid, 7), 100, "tag-pay-3")).json.error], [true, "tag_locked"]);
eq("unlock restores it", [(await call("PATCH", `/v1/tags/${tagId}`, { token: CT, body: { locked: false } })).json.tag.locked, (await tpay(T1d, urlFor(inv.uid, 8), 100, "tag-pay-4")).status], [false, 201]);
eq("reassign to another wallet of the same account", [(await call("PATCH", `/v1/tags/${tagId}`, { token: CT, body: { wallet_id: kidW } })).json.tag.wallet_id === kidW, (await call("PATCH", `/v1/tags/${tagId}`, { token: CT, body: { wallet_id: bob.default_wallet_id } })).status], [true, 404]);
eq("empty or invalid patch 400", [(await call("PATCH", `/v1/tags/${tagId}`, { token: CT, body: {} })).status, (await call("PATCH", `/v1/tags/${tagId}`, { token: CT, body: { transaction_limit: 0 } })).status], [400, 400]);
// delegated device: may lock its own wallet's band, nothing else
const kidLink = await call("POST", `/v1/wallets/${kidW}/links`, { token: CT });
const kidDev = (await call("POST", "/v1/devices/redeem", { body: { token: kidLink.json.url.split("/magic-link/")[1] } })).json.session_token;
eq("delegated device sees only its wallet's tags", (await call("GET", "/v1/tags", { token: kidDev })).json.tags.map((t: any) => t.id).sort(), [tagId, kidTagId].sort());
eq("delegated device can lock a lost band", (await call("PATCH", `/v1/tags/${kidTagId}`, { token: kidDev, body: { locked: true } })).json.tag.locked, true);
eq("delegated device cannot unlock, rename, limit or move", await Promise.all([
  call("PATCH", `/v1/tags/${kidTagId}`, { token: kidDev, body: { locked: false } }),
  call("PATCH", `/v1/tags/${kidTagId}`, { token: kidDev, body: { label: "x" } }),
  call("PATCH", `/v1/tags/${kidTagId}`, { token: kidDev, body: { transaction_limit: 5 } }),
  call("PATCH", `/v1/tags/${kidTagId}`, { token: kidDev, body: { locked: true, label: "x" } }),
]).then((r) => r.map((x) => x.status)), [403, 403, 403, 403]);
eq("delegated device cannot reset or claim", [(await call("POST", `/v1/tags/${kidTagId}/reset`, { token: kidDev })).status, (await claimTag(kidDev, urlFor((await newTag(null)).uid, 1))).status], [403, 403]);
eq("delegated device cannot touch another wallet's tag", (await call("PATCH", `/v1/tags/${(await call("GET", "/v1/tags", { token: CT })).json.tags.find((t: any) => t.wallet_id === cust.default_wallet_id)?.id ?? tagId}`, { token: kidDev, body: { locked: true } })).status, 404);
// reset
const lockedKid = (await call("GET", `/v1/tags/${kidTagId}`, { token: CT })).json.tag;
eq("reset unassigns, clears label, lock and limit", [(await call("POST", `/v1/tags/${kidTagId}/reset`, { token: CT })).status, (await q("select wallet_id, label, locked, transaction_limit from tags where id=$1", [kidTagId]))[0]], [204, { wallet_id: null, label: null, locked: false, transaction_limit: null }]);
eq("reset keeps the counter (history) so old taps stay dead", (await q("select counter::int c from tags where id=$1", [kidTagId]))[0].c, 1);
eq("a reset band is no longer manageable by id", (await call("GET", `/v1/tags/${kidTagId}`, { token: CT })).status, 404);
eq("a reset band cannot pay", (await tpay(T1d, urlFor(kidBand.uid, 3), 100, "tag-pay-5")).json.error, "tag_unassigned");
eq("a reset band can be claimed again by tapping, by anyone", (await claimTag(stranger.session_token, urlFor(kidBand.uid, 4), { label: "Hand-me-down" })).json.tag.label, "Hand-me-down");
eq("past payments keep their original wallet", (await q("select count(*)::int n from transactions where type='pay' and from_wallet_id=$1", [cust.default_wallet_id]))[0].n >= 1, true);
eq("tags list shows no UIDs", JSON.stringify((await call("GET", "/v1/tags", { token: CT })).json).includes(inv.uid), false);
eq("parallel claims of one band: exactly one wins", await (async () => {
  const t = await newTag(null);
  const r = await Promise.all([CT, stranger.session_token, CT, stranger.session_token].map((tk, i) => claimTag(tk, urlFor(t.uid, 1))));
  return [r.filter((x) => x.status === 201).length, (await q("select count(*)::int n from tags where id=$1 and wallet_id is not null", [t.id]))[0].n];
})(), [1, 1]);

// ============ idempotency scope across merchants ============
const otherT = (await call("POST", "/v1/terminals", { token: O, body: { name: "O2" } })).json.session_token;
const adaTag2 = await newTag(ada.default_wallet_id);
const x1 = await tpay(T1d, urlFor(adaTag2.uid, 1), 10, "same-key");
const x2 = await tpay(otherT, urlFor(adaTag2.uid, 2), 10, "same-key");
eq("same attempt id at two merchants is independent", [x1.status, x2.status, x1.json.payment.id !== x2.json.payment.id], [201, 201, true]);

// ============ concurrency ============
const racer = await signup("Racer", "racer@example.com");
await fund(racer.session_token, 7000, "fr");
const tags = await Promise.all(Array.from({ length: 8 }, () => newTag(racer.default_wallet_id)));
const res = await Promise.all(tags.map((t, i) => tpay(T1d, urlFor(t.uid, 1), 2000, `par-${i}`)));
const ok = res.filter((r) => r.status === 201).length;
eq("parallel taps: exactly floor(funds/amount) succeed, never overdrawn", [ok, (await bal(racer.session_token)).balance, res.filter((r) => ![201, 422].includes(r.status)).length], [3, 1000, 0]);
const dupTag = await newTag(racer.default_wallet_id);
const before = (await bal(racer.session_token)).balance;
const dups = await Promise.all(Array.from({ length: 6 }, () => tpay(T1d, urlFor(dupTag.uid, 1), 100, "dup-att")));
eq("parallel duplicate attempt: one debit, one tx", [(await bal(racer.session_token)).balance, new Set(dups.filter((d) => d.json.payment).map((d) => d.json.payment.id)).size, (await q("select count(*)::int n from transactions where idem like '%:t:dup-att'"))[0].n], [before - 100, 1, 1]);
const dupCust = await Promise.all(Array.from({ length: 6 }, () => call("POST", "/v1/payments", { token: racer.session_token, key: "dup-c", body: { amount: 10, terminal_id: t1id } })));
eq("parallel duplicate customer payment: one tx", [new Set(dupCust.map((d) => d.json.payment.id)).size, (await q("select count(*)::int n from transactions where idem like '%:c:%:dup-c'"))[0].n], [1, 1]);
const sameProof = await newTag(racer.default_wallet_id);
const sp = await Promise.all([1, 2, 3, 4].map((i) => tpay(T1d, urlFor(sameProof.uid, 7), 5, `sp-${i}`)));
eq("same proof across parallel attempts: exactly one wins", sp.filter((r) => r.status === 201).length, 1);

// ============ ledger integrity ============
eq("balances == the sum of what the transactions did (all accounts except the simulated-payout merchant)", (await q(`
  select count(*)::int n from balances b where b.balance <> coalesce((select sum(delta) from account_effects e where e.account_id=b.account_id),0)
    and b.account_id not in ($1, '00000000-0000-7000-8000-000000000001')`, [neg.account_id]))[0].n, 0);
eq("credit_spent == the credit drawn minus repaid by transactions (all accounts)", (await q(`
  select count(*)::int n from balances b where b.credit_spent <> coalesce((select sum(credit_delta) from account_effects e where e.account_id=b.account_id),0)
    and b.account_id not in ($1, '00000000-0000-7000-8000-000000000001')`, [cy.account_id]))[0].n, 0);
eq("a declined row has no effect on any balance", (await q("select count(*)::int n from account_effects e join transactions t on t.id=e.tx_id where t.status='declined'"))[0].n, 0);
eq("no transaction is left half done: every row is completed or declined", (await q("select count(*)::int n from transactions where status not in ('completed','declined')"))[0].n, 0);
eq("pending refund requests have not moved money (no transaction yet)", (await q("select count(*)::int n from transactions t join refunds r on r.id = t.id where r.status in ('pending','rejected')"))[0].n, 0);

console.log(`\n${pass} passed, ${fail} failed`);
await adm.end();
process.exit(fail ? 1 : 0);
