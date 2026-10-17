import { randomBytes } from "node:crypto";
import postgres from "postgres";
import app from "../src/index.ts";
import { migrate, resetSchema, PG_URL } from "./db.ts";
resetSchema(); migrate();
const adm = postgres(PG_URL, { max: 3, onnotice: () => {} });
const q = async (s: string, p: unknown[] = []) => (await adm.unsafe(s, p as any)) as any[];
const OP = "op-" + randomBytes(16).toString("hex");
const store = new Map<string, { bytes: Uint8Array; httpMetadata?: any }>();
const IMAGES = {
  put: async (k: string, v: Uint8Array, o?: any) => { store.set(k, { bytes: new Uint8Array(v), httpMetadata: o?.httpMetadata }); },
  delete: async (k: string) => { store.delete(k); },
  get: async (k: string) => { const e = store.get(k); return e ? { httpMetadata: e.httpMetadata, arrayBuffer: async () => e.bytes.buffer.slice(e.bytes.byteOffset, e.bytes.byteOffset + e.bytes.byteLength) } : null; },
};
// A fake Cloudflare Images binding: records the transform asked for and returns a small JPEG; an input ending in 0xEE is "unreadable".
const asked: any[] = [];
const JPEG_OUT = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 9, 9, 9, 9]);
const IMG = {
  input: (stream: ReadableStream) => {
    let t: any = null, o: any = null;
    const chain: any = {
      transform: (x: any) => { t = x; return chain; },
      output: async (x: any) => {
        o = x; asked.push({ t, o });
        const buf = new Uint8Array(await new Response(stream).arrayBuffer());
        if (buf[buf.length - 1] === 0xee) throw new Error("bad image");
        return { response: () => new Response(JPEG_OUT) };
      },
    };
    return chain;
  },
};
const env: any = { HYPERDRIVE: { connectionString: PG_URL }, JWT_SECRET: "x".repeat(40), ADMIN_API_TOKEN: OP, SANDBOX_FUNDING: "true", IMAGES, IMG };
const ctx: any = { waitUntil: (p: Promise<unknown>) => void p.catch(() => {}), passThroughOnException() {} };
let pass = 0, fail = 0;
const eq = (l: string, g: unknown, w: unknown) => { const ok = JSON.stringify(g) === JSON.stringify(w); ok ? pass++ : fail++; console.log(ok ? "ok  " : "FAIL", l, ok ? "" : `got ${JSON.stringify(g)} want ${JSON.stringify(w)}`); };
const raw = (method: string, path: string, o: { body?: unknown; token?: string; type?: string; bytes?: Uint8Array; e?: any } = {}) =>
  app.fetch(new Request("http://x" + path, { method, headers: { "content-type": o.type ?? "application/json", ...(o.token ? { authorization: `Bearer ${o.token}` } : {}) }, body: o.bytes ?? (o.body === undefined ? undefined : JSON.stringify(o.body)) }), o.e ?? env, ctx);
const call = async (m: string, p: string, o: any = {}) => { const r = await raw(m, p, o); const t = await r.text(); let j: any = null; try { j = t ? JSON.parse(t) : null; } catch { /* binary */ } return { status: r.status, json: j, headers: r.headers }; };

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const JPG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4]);
const sign = async (name: string, email: string) => (await call("POST", "/v1/auth/signup", { body: { name, email, password: "correct horse battery" } })).json;
const ada = await sign("Ada", "ada@example.com"), bob = await sign("Bob", "bob@example.com");
const A = ada.session_token, B = bob.session_token;
const kid = (await call("POST", "/v1/wallets", { token: A, body: { display_name: "Kid", type: "person", photo: "https://evil.example/x.png" } })).json.wallet;
eq("a photo cannot be set when creating a wallet (upload comes after)", [kid.photo, (await q("select photo from wallets where id=$1", [kid.id]))[0].photo], [null, null]);
eq("nor by patching a wallet", [(await call("PATCH", `/v1/wallets/${kid.id}`, { token: A, body: { photo: "https://evil.example/x.png" } })).status, (await q("select photo from wallets where id=$1", [kid.id]))[0].photo], [400, null]);

// ---- the account's photo
const up = await call("PUT", "/v1/account/photo", { token: A, type: "image/png", bytes: PNG });
const key = (await q("select photo from accounts where id=$1", [ada.account_id]))[0].photo;
eq("an upload is cropped to a 256 x 256 JPEG, saved to R2 and its key is stored", [up.status, asked[0].t, asked[0].o.format, /^accounts\/[0-9a-f-]{36}-\d+\.jpg$/.test(key), key.startsWith(`accounts/${ada.account_id}-`), store.has(key), store.get(key)!.httpMetadata.contentType, Array.from(store.get(key)!.bytes)], [200, { width: 256, height: 256, fit: "cover" }, "image/jpeg", true, true, true, "image/jpeg", Array.from(JPEG_OUT)]);
eq("the response and the account carry the rendered path", [up.json.photo === `http://x/v1/photos/${key}`, (await call("GET", "/v1/account", { token: A })).json.photo === `http://x/v1/photos/${key}`], [true, true]);
const served = await raw("GET", `/v1/photos/${key}`);
eq("the photo is served publicly as a JPEG with a long cache", [served.status, served.headers.get("content-type"), served.headers.get("cache-control"), Array.from(new Uint8Array(await served.arrayBuffer()))], [200, "image/jpeg", "public, max-age=31536000, immutable", Array.from(JPEG_OUT)]);
eq("only well-formed profile keys are served", [(await call("GET", "/v1/photos/accounts/nope.jpg")).status, (await call("GET", "/v1/photos/tags/x.jpg")).status, (await call("GET", `/v1/photos/accounts/${ada.account_id}-1.jpg`)).status], [404, 404, 404]);
await new Promise((r) => setTimeout(r, 5));
await call("PUT", "/v1/account/photo", { token: A, type: "image/jpeg", bytes: JPG });
const key2 = (await q("select photo from accounts where id=$1", [ada.account_id]))[0].photo;
eq("a new upload gets a new key and the old object is deleted", [key2 !== key, store.has(key), store.has(key2)], [true, false, true]);
eq("WebP is accepted too", (await call("PUT", "/v1/account/photo", { token: B, type: "image/webp", bytes: WEBP })).status, 200);
eq("bad uploads: type, signature, empty, oversize, unreadable", [
  (await call("PUT", "/v1/account/photo", { token: A, type: "image/gif", bytes: PNG })).status,
  (await call("PUT", "/v1/account/photo", { token: A, type: "image/png", bytes: JPG })).status,
  (await call("PUT", "/v1/account/photo", { token: A, type: "image/png", bytes: new Uint8Array(0) })).status,
  (await call("PUT", "/v1/account/photo", { token: A, type: "image/png", bytes: new Uint8Array(8 * 1024 * 1024 + 1).fill(0x89) })).status,
  (await call("PUT", "/v1/account/photo", { token: A, type: "image/png", bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0xee]) })).status], [415, 400, 400, 413, 400]);
eq("needs a session; without the Images binding or bucket it is 503", [(await call("PUT", "/v1/account/photo", { type: "image/png", bytes: PNG })).status, (await call("PUT", "/v1/account/photo", { token: A, type: "image/png", bytes: PNG, e: { ...env, IMG: undefined } })).status], [401, 503]);

// ---- a wallet's photo
const wp = await call("PUT", `/v1/wallets/${kid.id}/photo`, { token: A, type: "image/png", bytes: PNG });
const wkey = (await q("select photo from wallets where id=$1", [kid.id]))[0].photo;
eq("a wallet's photo is stored under wallets/<id>-<ms>.jpg and rendered in the wallet JSON", [wp.status, wkey.startsWith(`wallets/${kid.id}-`), store.has(wkey), (await call("GET", "/v1/wallets", { token: A })).json.wallets.find((w: any) => w.id === kid.id).photo === `http://x/v1/photos/${wkey}`], [200, true, true, true]);
eq("another account cannot set it (404), an unknown wallet is 404", [(await call("PUT", `/v1/wallets/${kid.id}/photo`, { token: B, type: "image/png", bytes: PNG })).status, (await call("PUT", `/v1/wallets/00000000-0000-7000-8000-000000000000/photo`, { token: A, type: "image/png", bytes: PNG })).status], [404, 404]);
const agent = (await call("POST", "/v1/wallets", { token: A, body: { display_name: "Bot", type: "agent" } })).json;
eq("an agent key cannot change photos; neither can a delegated wallet session", [(await call("PUT", `/v1/wallets/${agent.wallet.id}/photo`, { token: agent.key, type: "image/png", bytes: PNG })).status, (await call("PUT", "/v1/account/photo", { token: agent.key, type: "image/png", bytes: PNG })).status], [403, 403]);
await call("PATCH", `/v1/wallets/${kid.id}`, { token: A, body: { status: "closed" } });
eq("a closed wallet cannot get a photo", (await call("PUT", `/v1/wallets/${kid.id}/photo`, { token: A, type: "image/png", bytes: PNG })).status, 409);

// ---- elsewhere the key is rendered too
await call("POST", "/v1/sandbox/fundings", { token: A, body: { amount: 5000 }, key: "f1" } as any);
await q("update accounts set handle='bob99' where id=$1", [bob.account_id]);
const bobWallet = (await call("GET", "/v1/wallets", { token: B })).json.wallets[0].id;
const bkey = (await q("select photo from accounts where id=$1", [bob.account_id]))[0].photo;
await q("update wallets set photo=$1 where id=$2", [bkey.replace("accounts/", "wallets/"), bobWallet]);
store.set(bkey.replace("accounts/", "wallets/"), store.get(bkey)!);
eq("a handle lookup shows the full URL built from the key", (await call("GET", "/v1/handles/bob99", { token: A })).json.photo, `http://x/v1/photos/${bkey.replace("accounts/", "wallets/")}`);
eq("the database refuses anything that is not a key in a photo column (a URL, another folder, a bad name)", await Promise.all([
  ["wallets", "https://evil.example/p.png"], ["wallets", `accounts/${bobWallet}-1.jpg`], ["accounts", "junk"],
].map(async ([t, v]) => { try { await q(`update ${t} set photo=$1`, [v]); return "accepted"; } catch { return "refused"; } }).concat((async () => { try { await q("insert into tag_models(type,name,price,quantity,photo) values('band','X',1,1,'tags/x.png')"); return "accepted"; } catch { return "refused"; } })())), ["refused", "refused", "refused", "refused"]);
eq("PUBLIC_URL, when set, is the address in front of every key", (await (async () => { const r = await raw("GET", "/v1/handles/bob99", { token: A, e: { ...env, PUBLIC_URL: "https://api.example.com/" } }); return (await r.json() as any).photo; })()), `https://api.example.com/v1/photos/${bkey.replace("accounts/", "wallets/")}`);
const logs = (await call("GET", "/v1/admin/logs?who=customer&limit=100", { token: OP })).json.logs;
eq("photo changes are logged", logs.filter((l: any) => l.action === "customer.photo_changed").length >= 3, true);
console.log(`\n${pass} passed, ${fail} failed`); await adm.end(); process.exit(fail ? 1 : 0);
