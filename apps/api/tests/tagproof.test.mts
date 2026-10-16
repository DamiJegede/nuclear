import { ROOT, applyMigration, migrate, psql, resetSchema } from "./db.ts";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { decryptTagUrl, parseTagUrl } from "../src/lib/tagproof.ts";

let pass = 0, fail = 0;
const eq = (l: string, g: unknown, w: unknown) => { const ok = JSON.stringify(g) === JSON.stringify(w); ok ? pass++ : fail++; console.log(ok ? "ok  " : "FAIL", l, ok ? "" : `got ${JSON.stringify(g)} want ${JSON.stringify(w)}`); };

const key = randomBytes(16);
const env: any = { TAG_KEY_V1: key.toString("hex") };
const mk = (uid: Buffer, ctr: number, tag = 0xc7) => {
  const pt = Buffer.alloc(16, 0xaa);
  pt[0] = tag; uid.copy(pt, 1); pt.writeUIntLE(ctr, 8, 3);
  const c = createCipheriv("aes-128-cbc", key, Buffer.alloc(16)); c.setAutoPadding(false);
  return Buffer.concat([c.update(pt), c.final()]).toString("hex");
};
// Reference: the original neo-band implementation, verbatim semantics.
const reference = (url: string) => {
  const parts = url.split("/");
  const d = createDecipheriv("aes-128-cbc", key, Buffer.alloc(16)); d.setAutoPadding(false);
  const dec = Buffer.concat([d.update(Buffer.from(parts[parts.length - 1]!, "hex")), d.final()]);
  return { tag: dec.subarray(0, 1).toString("hex"), uid: dec.subarray(1, 8).toString("hex").toUpperCase(), counter: dec.readUIntLE(8, 3) };
};

const uid = Buffer.from("04a1b2c3d4e5f6", "hex");
const url = `https://tag.nclr.app/v1/${mk(uid, 42)}`;
eq("decrypts uid/counter/tag", await decryptTagUrl(env, url), { version: "v1", tag: "c7", uid: "04A1B2C3D4E5F6", counter: 42 });
eq("max 24-bit counter", (await decryptTagUrl(env, `https://tag.nclr.app/v1/${mk(uid, 0xffffff)}`))?.counter, 0xffffff);
eq("counter byte order (little endian)", (await decryptTagUrl(env, `https://tag.nclr.app/v1/${mk(uid, 0x010203)}`))?.counter, 0x010203);

let agree = 0;
for (let i = 0; i < 200; i++) {
  const u = randomBytes(7), c = randomBytes(3).readUIntBE(0, 3);
  const link = `https://tag.nclr.app/v1/${mk(u, c)}`;
  const mine = await decryptTagUrl(env, link), ref = reference(link);
  if (mine && mine.uid === ref.uid && mine.counter === ref.counter && mine.tag === ref.tag) agree++;
}
eq("matches original implementation on 200 random tags", agree, 200);

eq("query/fragment/trailing slash tolerated", (await decryptTagUrl(env, url + "?x=1#y"))?.uid, "04A1B2C3D4E5F6");
eq("unknown version null", await decryptTagUrl(env, url.replace("/v1/", "/v2/")), null);
eq("bad version format null", await decryptTagUrl(env, url.replace("/v1/", "/x1/")), null);
eq("wrong key null", await decryptTagUrl({ TAG_KEY_V1: randomBytes(16).toString("hex") } as any, url), null);
eq("missing key null", await decryptTagUrl({} as any, url), null);
eq("two blocks rejected", await decryptTagUrl(env, url + "00".repeat(16)), null);
eq("short rejected", await decryptTagUrl(env, "https://tag.nclr.app/v1/abcd"), null);
eq("non-hex rejected", await decryptTagUrl(env, "https://tag.nclr.app/v1/" + "zz".repeat(16)), null);
eq("unexpected flags byte rejected", await decryptTagUrl(env, `https://tag.nclr.app/v1/${mk(uid, 1, 0x00)}`), null);
eq("tampered ciphertext null", await decryptTagUrl(env, url.slice(0, -1) + (url.endsWith("0") ? "1" : "0")), null);
eq("empty/garbage null", [await decryptTagUrl(env, ""), await decryptTagUrl(env, "////")], [null, null]);
eq("parse keeps version lowercase", parseTagUrl("https://tag.nclr.app/V1/" + "ab".repeat(16))?.version, "v1");
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
