#!/usr/bin/env node
// Creates the institutions in scripts/institutions-top50.json (name, website, the aliases the bank directory uses) through the admin API and uploads
// each one's logo from a folder of 256 x 256 PNGs named after the institution (jpmorgan-chase.png ...). Safe to run again: an institution that exists gets
// the list's website, aliases and partner banks (`hosts`, by name), and a logo is only uploaded when it has none (or with --force). Routing numbers that already exist are linked by name as institutions appear.
//
//   ADMIN_API_TOKEN=... node scripts/seed-institutions.mjs <logos-dir> [--force] [--dry-run] [--list=institutions-neobanks.json]     (API_URL overrides the target)
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const dir = args.find((a) => !a.startsWith("--"));
const force = args.includes("--force"), dry = args.includes("--dry-run");
const API = (process.env.API_URL ?? "https://nuclear-api.a-space.workers.dev").replace(/\/$/, "");
const OP = process.env.ADMIN_API_TOKEN;
if (!dir || !OP) { console.error("usage: ADMIN_API_TOKEN=... node scripts/seed-institutions.mjs <logos-dir> [--force] [--dry-run] [--list=institutions-neobanks.json]"); process.exit(2); }
const listName = args.find((a) => a.startsWith("--list="))?.slice(7) ?? "institutions-top50.json";
const list = JSON.parse(readFileSync(fileURLToPath(new URL("./" + listName, import.meta.url)), "utf8"));
const slug = (n) => n.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

async function call(method, path, body, type) {
  const res = await fetch(API + path, { method, headers: { authorization: `Bearer ${OP}`, "x-operator-token": OP, ...(body !== undefined ? { "content-type": type ?? "application/json" } : {}) }, body: body === undefined ? undefined : type ? body : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, json: text && text[0] === "{" ? JSON.parse(text) : null };
}

const idByName = async (name) => {
  const f = await call("GET", `/v1/admin/institutions?q=${encodeURIComponent(name)}&limit=20`);
  return f.json?.institutions?.find((x) => x.name === name)?.id ?? null;
};

let created = 0, existed = 0, logos = 0, missing = [], failed = [], waiting = [];
for (const i of list) {
  let id, hasIcon = false;
  if (dry) { console.log("would create", i.name); continue; }
  const r = await call("POST", "/v1/admin/institutions", { name: i.name, domain: i.domain, aliases: i.aliases });
  if (r.status === 201) { id = r.json.institution.id; created += 1; }
  else if (r.status === 409 && (r.json?.error === "institution_exists" || (r.json?.error === "alias_taken" && r.json.institution === i.name))) {   // its own name is taken: by itself
    const f = await call("GET", `/v1/admin/institutions?q=${encodeURIComponent(i.name)}&limit=20`);
    const hit = f.json?.institutions?.find((x) => x.name === i.name);
    if (!hit) { failed.push(`${i.name}: exists but not found`); continue; }
    id = hit.id; hasIcon = !!hit.icon; existed += 1;
    // An institution that exists is brought in line with the list (website, aliases): a name or alias moves from one institution to another this way.
    const u = await call("PATCH", `/v1/admin/institutions/${id}`, { domain: i.domain ?? null, aliases: i.aliases });
    if (u.status !== 200) failed.push(`${i.name}: update ${u.status} ${u.json?.error ?? ""}`);
  } else { failed.push(`${i.name}: create ${r.status} ${r.json?.error ?? ""} ${r.json?.alias ?? ""}`); continue; }
  if (i.hosts?.length) {
    // The partner banks it runs on, by name. A partner that is not created yet is reported; run the partners list, then this one again.
    const ids = (await Promise.all(i.hosts.map(idByName))), unknown = i.hosts.filter((_, k) => !ids[k]);
    if (unknown.length) waiting.push(`${i.name}: ${unknown.join(", ")}`);
    else { const h = await call("PATCH", `/v1/admin/institutions/${id}`, { hosts: ids }); if (h.status !== 200) failed.push(`${i.name}: hosts ${h.status} ${h.json?.error ?? ""}`); }
  }
  const file = join(dir, `${slug(i.name)}.png`);
  if (!existsSync(file)) { missing.push(i.name); continue; }
  if (hasIcon && !force) continue;
  const up = await call("PUT", `/v1/admin/institutions/${id}/icon`, readFileSync(file), "image/png");
  if (up.status === 204) logos += 1; else failed.push(`${i.name}: logo ${up.status} ${up.json?.error ?? ""}`);
}
console.log(`institutions: ${created} created, ${existed} already there; logos uploaded: ${logos}`);
if (waiting.length) console.log(`partner banks not created yet (run the partners list, then this one again):\n  ${waiting.join("\n  ")}`);
if (missing.length) console.log(`no logo file for: ${missing.join(", ")}`);
if (failed.length) { console.log("problems:\n  " + failed.join("\n  ")); process.exit(1); }
