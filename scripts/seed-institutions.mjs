#!/usr/bin/env node
// Creates the institutions in scripts/institutions-top50.json (name, website, the aliases the bank directory uses) through the admin API and uploads
// each one's logo from a folder of 256 x 256 PNGs named after the institution (jpmorgan-chase.png ...). Safe to run again: an institution that exists is
// kept, and a logo is only uploaded when it has none (or with --force). Routing numbers that already exist are linked by name as institutions appear.
//
//   ADMIN_API_TOKEN=... node scripts/seed-institutions.mjs <logos-dir> [--force] [--dry-run]     (API_URL overrides the target)
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const dir = args.find((a) => !a.startsWith("--"));
const force = args.includes("--force"), dry = args.includes("--dry-run");
const API = (process.env.API_URL ?? "https://nuclear-api.a-space.workers.dev").replace(/\/$/, "");
const OP = process.env.ADMIN_API_TOKEN;
if (!dir || !OP) { console.error("usage: ADMIN_API_TOKEN=... node scripts/seed-institutions.mjs <logos-dir> [--force] [--dry-run]"); process.exit(2); }
const list = JSON.parse(readFileSync(fileURLToPath(new URL("./institutions-top50.json", import.meta.url)), "utf8"));
const slug = (n) => n.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

async function call(method, path, body, type) {
  const res = await fetch(API + path, { method, headers: { authorization: `Bearer ${OP}`, "x-operator-token": OP, ...(body !== undefined ? { "content-type": type ?? "application/json" } : {}) }, body: body === undefined ? undefined : type ? body : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, json: text && text[0] === "{" ? JSON.parse(text) : null };
}

let created = 0, existed = 0, logos = 0, missing = [], failed = [];
for (const i of list) {
  let id, hasIcon = false;
  if (dry) { console.log("would create", i.name); continue; }
  const r = await call("POST", "/v1/admin/institutions", { name: i.name, domain: i.domain, aliases: i.aliases });
  if (r.status === 201) { id = r.json.institution.id; created += 1; }
  else if (r.status === 409) {
    const f = await call("GET", `/v1/admin/institutions?q=${encodeURIComponent(i.name)}&limit=20`);
    const hit = f.json?.institutions?.find((x) => x.name === i.name);
    if (!hit) { failed.push(`${i.name}: exists but not found`); continue; }
    id = hit.id; hasIcon = !!hit.icon; existed += 1;
  } else { failed.push(`${i.name}: create ${r.status} ${r.json?.error ?? ""}`); continue; }
  const file = join(dir, `${slug(i.name)}.png`);
  if (!existsSync(file)) { missing.push(i.name); continue; }
  if (hasIcon && !force) continue;
  const up = await call("PUT", `/v1/admin/institutions/${id}/icon`, readFileSync(file), "image/png");
  if (up.status === 204) logos += 1; else failed.push(`${i.name}: logo ${up.status} ${up.json?.error ?? ""}`);
}
console.log(`institutions: ${created} created, ${existed} already there; logos uploaded: ${logos}`);
if (missing.length) console.log(`no logo file for: ${missing.join(", ")}`);
if (failed.length) { console.log("problems:\n  " + failed.join("\n  ")); process.exit(1); }
