import { ROOT, applyMigration, migrate, psql, resetSchema } from "./db.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const TMP = mkdtempSync(join(tmpdir(), "nuclear-test-"));
import { createCipheriv, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { execFile, execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import postgres from "postgres";
import app from "../src/index.ts";

psql(["-c", "drop schema public cascade; create schema public;"]);
migrate();
const adm = postgres("postgres://postgres@127.0.0.1:54340/nuclear", { max: 2, onnotice: () => {} });
const q = async (s: string, p: unknown[] = []) => (await adm.unsafe(s, p as any)) as any[];

const tagKey = randomBytes(16);
const TOKEN = "op-" + randomBytes(24).toString("hex");
const env: any = {
  HYPERDRIVE: { connectionString: "postgres://postgres@127.0.0.1:54340/nuclear" },
  JWT_SECRET: "test-secret-test-secret-test-secret!",
  TAG_KEY_V1: tagKey.toString("hex"),
  ADMIN_API_TOKEN: TOKEN,
};
const ctx: any = { waitUntil: (p: Promise<unknown>) => void p.catch(() => {}), passThroughOnException() {} };
let pass = 0, fail = 0;
const eq = (label: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(ok ? "ok  " : "FAIL", label, ok ? "" : `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
};
const call = async (method: string, path: string, o: { body?: unknown; token?: string; env?: any } = {}) => {
  const res = await app.fetch(new Request("http://x" + path, {
    method,
    headers: { "content-type": "application/json", ...(o.token ? { authorization: `Bearer ${o.token}` } : {}) },
    body: o.body === undefined ? undefined : JSON.stringify(o.body),
  }), o.env ?? env, ctx);
  const t = await res.text();
  return { status: res.status, json: t ? JSON.parse(t) : null };
};
const A = (m: string, p: string, body?: unknown) => call(m, p, { token: TOKEN, body });
const urlFor = (uid: string, counter: number) => {
  const pt = Buffer.alloc(16, 0x55);
  pt[0] = 0xc7; Buffer.from(uid, "hex").copy(pt, 1); pt.writeUIntLE(counter, 8, 3);
  const c = createCipheriv("aes-128-cbc", tagKey, Buffer.alloc(16)); c.setAutoPadding(false);
  return `https://tag.nclr.app/v1/${Buffer.concat([c.update(pt), c.final()]).toString("hex")}`;
};

// ---- access
const noToken = { ...env, ADMIN_API_TOKEN: undefined };
eq("with no operator token configured, the token no longer opens anything", (await call("GET", "/v1/admin/tag-models", { token: TOKEN, env: noToken })).status, 401);
eq("no bearer => 401", (await call("GET", "/v1/admin/tag-models")).status, 401);
eq("wrong bearer => 401", (await call("GET", "/v1/admin/tag-models", { token: "nope" })).status, 401);
const user = (await call("POST", "/v1/auth/signup", { body: { name: "Cust", email: "c@example.com", password: "correct horse battery" } })).json;
eq("a customer session is not an operator", (await call("GET", "/v1/admin/tag-models", { token: user.session_token })).status, 401);
eq("operator token is not a customer session", (await call("GET", "/v1/wallets", { token: TOKEN })).status, 401);

// ---- models
eq("invalid model rejected", [
  (await A("POST", "/v1/admin/tag-models", { type: "ring", name: "x", price: 1, quantity: 1 })).status,
  (await A("POST", "/v1/admin/tag-models", { type: "band", name: "x", price: -1, quantity: 1 })).status,
  (await A("POST", "/v1/admin/tag-models", { type: "band", name: "", price: 1, quantity: 1 })).status,
  (await A("POST", "/v1/admin/tag-models", { type: "band", name: "x", price: 1.5, quantity: 1 })).status], [400, 400, 400, 400]);
const m1 = await A("POST", "/v1/admin/tag-models", { type: "band", name: "NEO Band Lite", photo: "https://neo.band/assets/model/lite.png", price: 2999, quantity: 1000 });
eq("model created with defaults", [m1.status, m1.json.model.price, m1.json.model.currency, m1.json.model.status, m1.json.model.limited, m1.json.model.sold, m1.json.model.quantity], [201, 2999, "USD", "pending", false, 0, 1000]);
const MODEL = m1.json.model.id;
const m2 = await A("POST", "/v1/admin/tag-models", { type: "card", name: "NEO Card", price: 1500, quantity: 50, limited: true, status: "available", country: "us" });
eq("second model: card, limited, country normalized", [m2.json.model.type, m2.json.model.limited, m2.json.model.status, m2.json.model.country], ["card", true, "available", "US"]);

// ---- import the supplier list
const list = ["04AE42EAAF1290", "04AE42EAAF1291", "04AE42EAAF1292", "04AE42EAAF1293", "04AE42EAAF1294"];
const imp = await A("POST", `/v1/admin/tag-models/${MODEL}/tags`, { uids: list });
eq("supplier list imported", [imp.status, imp.json.requested, imp.json.inserted, imp.json.already_existing, imp.json.model_name], [201, 5, 5, [], "NEO Band Lite"]);
eq("imported bands are unassigned with no counter", (await q("select count(*)::int n from tags where model_id=$1 and wallet_id is null and counter is null and locked = false", [MODEL]))[0].n, 5);
eq("UIDs are stored uppercase", (await q("select uid from tags where model_id=$1 order by uid limit 1", [MODEL]))[0].uid, "04AE42EAAF1290");
const again = await A("POST", `/v1/admin/tag-models/${MODEL}/tags`, { uids: list });
eq("re-importing the same list changes nothing and reports them", [again.json.inserted, again.json.already_existing.length, (await q("select count(*)::int n from tags"))[0].n], [0, 5, 5]);
const mixed = await A("POST", `/v1/admin/tag-models/${MODEL}/tags`, { uids: ["04ae42eaaf12a0", "04:AE:42:EA:AF:12:A1", "04AE42EAAF12A0", " 04-ae-42-ea-af-12-a2 "] });
eq("lowercase, separators and spaces normalized; repeats within the list ignored", [mixed.json.inserted, mixed.json.duplicates_in_request, (await q("select uid from tags where uid like '04AE42EAAF12A%' order by uid")).map((r: any) => r.uid)], [3, 1, ["04AE42EAAF12A0", "04AE42EAAF12A1", "04AE42EAAF12A2"]]);
const bad = await A("POST", `/v1/admin/tag-models/${MODEL}/tags`, { uids: ["04AE42EAAF12B0", "XYZ", "04AE42EAAF12"] });
eq("one bad UID rejects the whole batch and adds nothing", [bad.status, bad.json.error, bad.json.invalid_count, (await q("select count(*)::int n from tags where uid like '04AE42EAAF12B%'"))[0].n], [400, "invalid_uids", 2, 0]);
eq("unknown model 404", (await A("POST", "/v1/admin/tag-models/0190aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee/tags", { uids: ["04AE42EAAF12C0"] })).status, 404);
eq("empty list and oversize list rejected", [
  (await A("POST", `/v1/admin/tag-models/${MODEL}/tags`, { uids: [] })).status,
  (await A("POST", `/v1/admin/tag-models/${MODEL}/tags`, { uids: Array.from({ length: 5001 }, (_, i) => i.toString(16).padStart(14, "0")) })).status], [400, 400]);
const cross = await A("POST", `/v1/admin/tag-models/${m2.json.model.id}/tags`, { uids: ["04AE42EAAF1290", "04AE42EAAF12D0"] });
eq("a UID already under another model is reported and left alone", [cross.json.inserted, cross.json.already_existing, (await q("select model_id from tags where uid='04AE42EAAF1290'"))[0].model_id === MODEL], [1, [{ uid: "04AE42EAAF1290", model_id: MODEL }], true]);
const big = Array.from({ length: 1200 }, (_, i) => "04BB" + i.toString(16).toUpperCase().padStart(10, "0"));
eq("a large list imports in full", [(await A("POST", `/v1/admin/tag-models/${m2.json.model.id}/tags`, { uids: big })).json.inserted, (await q("select count(*)::int n from tags where model_id=$1", [m2.json.model.id]))[0].n], [1200, 1201]);
const listed = (await A("GET", "/v1/admin/tag-models")).json.models;
eq("models list with counts", listed.map((m: any) => [m.name, m.tags, m.unassigned]), [["NEO Band Lite", 8, 8], ["NEO Card", 1201, 1201]]);

// ---- an imported band can be claimed by tapping it
const claim = await call("POST", "/v1/tags/claim", { token: user.session_token, body: { url: urlFor("04AE42EAAF1291", 1), label: "From the supplier list" } });
eq("an imported band is claimable by tapping it", [claim.status, claim.json.tag.label, claim.json.tag.model.name, claim.json.tag.model.type], [201, "From the supplier list", "NEO Band Lite", "band"]);
const after = (await A("GET", "/v1/admin/tag-models")).json.models.find((m: any) => m.id === MODEL);
eq("counts reflect the claim", [after.tags, after.unassigned], [8, 7]);
eq("re-importing a claimed band does not disturb it", [(await A("POST", `/v1/admin/tag-models/${MODEL}/tags`, { uids: ["04AE42EAAF1291"] })).json.inserted, (await q("select wallet_id is not null as claimed from tags where uid='04AE42EAAF1291'"))[0].claimed], [0, true]);

// ---- the scripts, against a real HTTP server wrapping the app
const server = createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const r = await app.fetch(new Request("http://x" + req.url, { method: req.method, headers: req.headers as any, body: ["GET", "HEAD"].includes(req.method!) ? undefined : Buffer.concat(chunks) }), env, ctx);
  res.writeHead(r.status, { "content-type": "application/json" });
  res.end(await r.text());
});
await new Promise<void>((r) => server.listen(8799, "127.0.0.1", r));
const run = (script: string, args: string[], withToken = true) => new Promise<{ code: number; out: string }>((resolve) => {
  execFile("node", [`${ROOT}scripts/${script}`, ...args], {
    env: { PATH: process.env.PATH, API_URL: "http://127.0.0.1:8799", ...(withToken ? { ADMIN_API_TOKEN: TOKEN } : {}) },
  }, (err, stdout, stderr) => resolve({ code: err ? (err as any).code ?? 1 : 0, out: stdout + stderr }));
});
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

const noTok = await run("add-model.mjs", ["--name", "X", "--type", "band", "--price", "1", "--quantity", "1"], false);
eq("script without a token exits 1 and says why", [noTok.code, /ADMIN_API_TOKEN is not set/.test(noTok.out)], [1, true]);
const noArgs = await run("add-model.mjs", ["--name", "X"]);
eq("script without required flags exits 1", [noArgs.code, /Missing: --type, --price, --quantity/.test(noArgs.out)], [1, true]);
const sm = await run("add-model.mjs", ["--name", "NEO Band Pro", "--type", "band", "--price", "49.99", "--quantity", "250", "--photo", "https://neo.band/assets/model/pro.png", "--limited", "--status", "available"]);
const printed = strip(sm.out);
const newId = /([0-9a-f-]{36})/.exec(printed)?.[1] ?? "";
eq("add-model prints the new id", [sm.code, /^Added model: NEO Band Pro/.test(printed), newId.length], [0, true, 36]);
eq("price 49.99 stored as 4999 cents; flags applied", (await q("select price::int p, limited, status, quantity from tag_models where id=$1", [newId]))[0], { p: 4999, limited: true, status: "available", quantity: 250 });

writeFileSync(TMP + "/uids-ok.txt", "# supplier batch 7\n04CC00000000A0\n04:CC:00:00:00:00:A1\n\n04cc00000000a2\n04CC00000000A0\n");
const sb = await run("add-bands.mjs", ["--model", newId, "--file", TMP + "/uids-ok.txt"]);
eq("add-bands reports inserted of requested for the model", [sb.code, /INSERTED 3 of 4 bands for model NEO Band Pro/.test(strip(sb.out)), /1 duplicate UID\(s\) within your list were ignored/.test(strip(sb.out))], [0, true, true]);
const sb2 = await run("add-bands.mjs", ["--model", newId, "--uids", "04CC00000000A0,04CC00000000A9"]);
eq("re-run lists what already existed", [/INSERTED 1 of 2/.test(strip(sb2.out)), /04CC00000000A0/.test(strip(sb2.out))], [true, true]);
writeFileSync(TMP + "/uids-bad.txt", "04CC00000000B0\nnot-a-uid\n");
const sbBad = await run("add-bands.mjs", ["--model", newId, "--file", TMP + "/uids-bad.txt"]);
eq("a bad UID in the file exits 1 and imports nothing", [sbBad.code, (await q("select count(*)::int n from tags where uid='04CC00000000B0'"))[0].n], [1, 0]);
eq("add-bands needs a model", (await run("add-bands.mjs", ["--uids", "04CC00000000C0"])).code, 1);
eq("secrets never appear in script output", [sm.out, sb.out, sbBad.out].some((o) => o.includes(TOKEN)), false);

console.log(`\n${pass} passed, ${fail} failed`);
server.close();
await adm.end();
process.exit(fail ? 1 : 0);
