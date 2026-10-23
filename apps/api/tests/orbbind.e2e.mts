import { createHmac, randomBytes } from "node:crypto";
import postgres from "postgres";
import app from "../src/index.ts";
import { authorizeBind } from "../src/lib/orbKeys.ts";
import { migrate, resetSchema, PG_URL } from "./db.ts";
resetSchema(); migrate();
const adm = postgres(PG_URL, { max: 2, onnotice: () => {} });
const q = async (s: string, p: unknown[] = []) => (await adm.unsafe(s, p as any)) as any[];
const ROOT = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
const env: any = { STATS_TTL_SECONDS: "0", HYPERDRIVE: { connectionString: PG_URL }, JWT_SECRET: "x".repeat(40), SANDBOX_FUNDING: "true", ORB_ROOT_KEY_V1: ROOT };
const ctx: any = { waitUntil: (p: Promise<unknown>) => void p.catch(() => {}), passThroughOnException() {} };
let pass = 0, fail = 0;
const eq = (l: string, g: unknown, w: unknown) => { const ok = JSON.stringify(g) === JSON.stringify(w); ok ? pass++ : fail++; console.log(ok ? "ok  " : "FAIL", l, ok ? "" : `got ${JSON.stringify(g)} want ${JSON.stringify(w)}`); };
const call = async (m: string, p: string, o: { body?: unknown; token?: string; env?: any } = {}) => {
  const r = await app.fetch(new Request("http://x" + p, { method: m, headers: { "content-type": "application/json", ...(o.token ? { authorization: `Bearer ${o.token}` } : {}) }, body: o.body === undefined ? undefined : JSON.stringify(o.body) }), o.env ?? env, ctx);
  const t = await r.text(); return { status: r.status, json: t ? JSON.parse(t) : null };
};
const signup = async (name: string, email: string, type: string) => (await call("POST", "/v1/auth/signup", { body: { type, name, email, password: "correct horse battery" } })).json;
const prf = (key: Buffer, label: string, ...parts: Buffer[]) => createHmac("sha256", key).update(Buffer.concat([Buffer.from(label), Buffer.from([0]), ...parts])).digest();

// Fixed vectors shared with docs/orb-protocol-vectors.md, Rust and Swift.
const v = await authorizeBind(Buffer.from(ROOT, "hex"), "0211223344FF", "a0a1a2a3a4a5a6a7a8a9aaabacadaeaf", Buffer.from("b0b1b2b3b4b5b6b7b8b9babbbcbdbebf", "hex"));
eq("vector: bind proof", v.proof, "d0194671cdd9ec6989df2fe66d300f9441a8f3451144043b32d177b0d051830e");
eq("vector: binding key", v.bind_key, "a8a92973061b638c991773194f0394ab01e31539a1084f210c547b98eed2481c");

const shop = await signup("Shop", "shop@example.com", "B");
await q("update accounts set status = 'active' where id = $1", [shop.account_id]);
const t1 = (await call("POST", "/v1/terminals", { token: shop.session_token, body: { name: "Counter" } })).json;
const T = t1.session_token as string;
const nonce = randomBytes(16).toString("hex");

const r = await call("POST", "/v1/terminal/orb/bind", { token: T, body: { uid: "02:11:22:33:44:ff".replace(/:/g, "").toUpperCase(), nonce } });
eq("bind: 200 with id, proof and key", [r.status, r.json.binding_id?.length, r.json.proof?.length, r.json.bind_key?.length], [200, 32, 64, 64]);
const kOrb = prf(Buffer.from(ROOT, "hex"), "nuclear-orb-device-v1", Buffer.from("0211223344ff", "hex"));
eq("bind: proof is the HMAC the Orb will check", r.json.proof, prf(kOrb, "bind-auth-v1", Buffer.from("0211223344ff", "hex"), Buffer.from(r.json.binding_id, "hex"), Buffer.from(nonce, "hex")).toString("hex"));
eq("bind: key is K_bind", r.json.bind_key, prf(kOrb, "bind-key-v1", Buffer.from("0211223344ff", "hex"), Buffer.from(r.json.binding_id, "hex")).toString("hex"));
const r2 = await call("POST", "/v1/terminal/orb/bind", { token: T, body: { uid: "0211223344FF", nonce } });
eq("bind: every authorization gets a fresh binding id", r2.json.binding_id !== r.json.binding_id, true);
eq("bind: audited, never with the key", (await q("select details from logs where action = 'orb.bind_authorized'")).map((l) => [Object.keys(l.details).sort(), "bind_key" in l.details]), [[["account_id", "binding_id", "uid"], false], [["account_id", "binding_id", "uid"], false]]);

eq("bad bodies are 400", await Promise.all([{ uid: "xyz", nonce }, { uid: "0211223344FF", nonce: "ab" }, { uid: "0211223344FF" }].map(async (b) => (await call("POST", "/v1/terminal/orb/bind", { token: T, body: b })).status)), [400, 400, 400]);
eq("no terminal session: refused", (await call("POST", "/v1/terminal/orb/bind", { body: { uid: "0211223344FF", nonce } })).status, 401);
eq("an owner session is not a terminal", (await call("POST", "/v1/terminal/orb/bind", { token: shop.session_token, body: { uid: "0211223344FF", nonce } })).status >= 400, true);
eq("without the root key: 503", (await call("POST", "/v1/terminal/orb/bind", { token: T, body: { uid: "0211223344FF", nonce }, env: { ...env, ORB_ROOT_KEY_V1: undefined } })).json.error, "orb_keys_unavailable");

// An Orb already paired to another account cannot be authorized for this one.
const other = await signup("Other", "other@example.com", "B");
await q("update accounts set status = 'active' where id = $1", [other.account_id]);
const t2 = (await call("POST", "/v1/terminals", { token: other.session_token, body: { name: "Bar" } })).json;
await call("PUT", "/v1/terminal/orb", { token: t2.session_token, body: { uid: "AABBCCDDEE01", model: "Orb 1", software: "1.0.0" } });
eq("bind: an Orb held by another account is 409", (await call("POST", "/v1/terminal/orb/bind", { token: T, body: { uid: "AABBCCDDEE01", nonce } })).json.error, "orb_assigned_to_another_account");
eq("bind: its own account may rebind it", (await call("POST", "/v1/terminal/orb/bind", { token: t2.session_token, body: { uid: "AABBCCDDEE01", nonce } })).status, 200);

// Rate limit: 20 per hour per terminal (the earlier successful and refused calls above count too, so go to the limit).
let last = 0; for (let i = 0; i < 25; i++) last = (await call("POST", "/v1/terminal/orb/bind", { token: T, body: { uid: "0211223344FF", nonce } })).status;
eq("bind: rate limited past 20 an hour", last, 429);

console.log(`${pass} passed, ${fail} failed`); await adm.end(); process.exit(fail ? 1 : 0);
