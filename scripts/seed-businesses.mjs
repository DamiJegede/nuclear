#!/usr/bin/env node
// Gives about 70% of the test merchants a `businesses` profile (legal name, address, website, map position) and adds a few
// brand-new PENDING businesses, each with an uploaded business document, so approving and declining can be tried in the admin portal.
//   node scripts/seed-businesses.mjs [--pending 6] [--banks-only]
// It also gives every ACTIVE merchant that has a profile a test payout bank account (routing 110000000, a random 11-digit account number).
// Reads ADMIN_API_TOKEN from apps/api/.dev.vars (never printed). Profiles are written with `pscale` (there is no API for them yet);
// the pending businesses sign up and upload through the real API. API_URL overrides the target. Safe to run again: it only tops up.
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf("--" + n); return i >= 0 ? args[i + 1] : d; };
const N_PENDING = Number(flag("pending", 6));
const RUN = Date.now().toString(36);
const API = (process.env.API_URL ?? "https://nuclear-api.a-space.workers.dev").replace(/\/$/, "");
const PASSWORD = "Seed-demo-password-1";
const vars = Object.fromEntries(
  readFileSync(fileURLToPath(new URL("../apps/api/.dev.vars", import.meta.url)), "utf8")
    .split("\n").filter((l) => l.includes("=") && !l.startsWith("#")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
);
const OP = vars.ADMIN_API_TOKEN;
if (!OP) { console.error("ADMIN_API_TOKEN is needed in apps/api/.dev.vars"); process.exit(1); }

let seed = 0x1234abcd;
const rnd = () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const pick = (a) => a[Math.floor(rnd() * a.length)];
const digits = (n) => Array.from({ length: n }, () => Math.floor(rnd() * 10)).join("");
const q = (s) => `'${String(s).replace(/'/g, "''")}'`;

async function api(method, path, { token, body, type, bytes } = {}) {
  const res = await fetch(API + path, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined || bytes ? { "content-type": type ?? "application/json" } : {}) },
    body: bytes ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
  const text = await res.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  return { status: res.status, json };
}
const sql = (query) => execFileSync("pscale", ["sql", "nuclear-dev", "main", "--org", "nuclear", "--role", "admin", "--force", "--format", "json", "--query", query], { encoding: "utf8" });

const PLACES = [
  ["New York", "NY", "10001", 40.7506, -73.9972], ["Brooklyn", "NY", "11201", 40.6937, -73.9903], ["Newark", "NJ", "07102", 40.7357, -74.1724],
  ["Boston", "MA", "02108", 42.3573, -71.0632], ["Philadelphia", "PA", "19103", 39.9526, -75.1745], ["Washington", "DC", "20001", 38.9101, -77.0147],
  ["Chicago", "IL", "60601", 41.8858, -87.6181], ["Austin", "TX", "78701", 30.2711, -97.7437], ["Denver", "CO", "80202", 39.7508, -104.9966],
  ["Seattle", "WA", "98101", 47.6111, -122.3344], ["Portland", "OR", "97204", 45.5202, -122.6742], ["Oakland", "CA", "94607", 37.8044, -122.2712],
];
const STREETS = ["Main St", "Market St", "Oak Ave", "Maple Ave", "Broad St", "Park Ave", "Elm St", "Pine St", "Lake Rd", "River Rd"];
const SUFFIX = ["LLC", "Inc.", "Ltd.", "Co.", "Group LLC"];
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 24);

function profileRow(id, name) {
  const [city, state, zip, lat, lng] = pick(PLACES);
  const jitter = () => (rnd() - 0.5) * 0.02;
  const line2 = rnd() < 0.3 ? `\nSuite ${int(2, 40)}` : "";
  return `(${q(id)}, ${q(`${name} ${pick(SUFFIX)}`)}, ${q(name)}, ${q(`99-${digits(7)}`)}, ${q(`${int(10, 998)} ${pick(STREETS)}${line2}`)}, ${q(city)}, ${q(state)}, ${q(zip)}, 'US', ${q(`https://www.${slug(name)}.example`)}, ${(lat + jitter()).toFixed(6)}, ${(lng + jitter()).toFixed(6)})`;
}
function int(lo, hi) { return lo + Math.floor(rnd() * (hi - lo + 1)); }
const insertProfiles = (rows) => rows.length ? sql(`INSERT INTO businesses (account_id, legal_name, display_name, tax_id, address, city, state, post_code, country, website, latitude, longitude) VALUES ${rows.join(", ")} ON CONFLICT (account_id) DO NOTHING`) : null;

// A small, valid one-page PDF that says what it is.
function pdf(title, lines) {
  const esc = (s) => s.replace(/[\\()]/g, "\\$&");
  const text = [`BT /F1 20 Tf 60 740 Td (${esc(title)}) Tj ET`, ...lines.map((l, i) => `BT /F1 12 Tf 60 ${700 - i * 20} Td (${esc(l)}) Tj ET`)].join("\n");
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${text.length} >>\nstream\n${text}\nendstream`, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n"; const offs = [];
  objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => String(o).padStart(10, "0") + " 00000 n \n").join("")}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

const BANKS_ONLY = args.includes("--banks-only");
if (!BANKS_ONLY) {
// ---- 1. profiles for about 70% of the existing merchants ---------------------------------------
const list = (await api("GET", "/v1/admin/merchants", { token: OP })).json?.merchants ?? [];
const have = new Set((JSON.parse(sql("SELECT account_id FROM businesses")).rows ?? []).map((r) => r.account_id));
const target = Math.ceil(list.length * 0.7);
const need = Math.max(0, target - list.filter((m) => have.has(m.id)).length);
const candidates = list.filter((m) => !have.has(m.id)).sort(() => rnd() - 0.5).slice(0, need);
insertProfiles(candidates.map((m) => profileRow(m.id, m.name)));
console.log(`merchants: ${list.length}; profiles now ${list.filter((m) => have.has(m.id)).length + candidates.length} (target ${target})`);

// ---- 2. new pending businesses, each with a document -----------------------------------------
const NAMES = ["Juniper Bookshop", "Salt & Sage Kitchen", "Redwood Cycles", "Harbor Light Coffee", "Quill & Ink Stationers", "Meadow Lane Florist", "Copperfield Hardware", "Northstar Tailors", "Sunrise Bagels", "Pebble Street Toys"];
const made = [];
for (let i = 0; i < N_PENDING; i++) {
  const name = `${NAMES[i % NAMES.length]}${i >= NAMES.length ? " " + (Math.floor(i / NAMES.length) + 1) : ""}`;
  const r = await api("POST", "/v1/auth/signup", { body: { type: "B", name, email: `pending${i}.${RUN}@seed.nuclear.test`, password: PASSWORD } });
  if (r.status !== 201) { console.log("signup failed", name, r.status, r.json?.error); continue; }
  const docs = i % 3 === 0 ? 2 : 1;
  for (let d = 0; d < docs; d++) {
    const up = await api("POST", "/v1/account/documents", {
      token: r.json.session_token, type: "application/pdf",
      bytes: pdf(d === 0 ? "Certificate of Business Registration" : "Proof of Address", [`Business: ${name}`, `Registration no: R-${digits(8)}`, `Issued: 2026-0${int(1, 9)}-${String(int(1, 28)).padStart(2, "0")}`, "Sample document for testing the approval flow."]),
    });
    if (up.status !== 201) console.log("upload failed", name, up.status, up.json?.error);
  }
  made.push({ id: r.json.account_id, name });
}
const withProfile = made.slice(0, Math.ceil(made.length * 0.7));
insertProfiles(withProfile.map((m) => profileRow(m.id, m.name)));
console.log(`pending businesses: ${made.length} (${withProfile.length} with a profile), password ${PASSWORD}`);
for (const m of made) console.log("  -", m.name);
}

// ---- 3. a test payout bank for every active merchant that has a profile and no bank yet ----------
const banked = JSON.parse(sql(`
  WITH targets AS (
    SELECT b.account_id FROM businesses b JOIN accounts a ON a.id = b.account_id
     WHERE a.status = 'active' AND a.type = 'B' AND b.bank_account_id IS NULL),
  nums AS (SELECT account_id, lpad((floor(random() * 99999999999))::bigint::text, 11, '0') AS num FROM targets),
  ins AS (
    INSERT INTO bank_accounts (account_id, routing_number, account_number, last4)
    SELECT account_id, '110000000', num, right(num, 4) FROM nums RETURNING id, account_id, last4)
  UPDATE businesses b SET bank_account_id = ins.id FROM ins WHERE b.account_id = ins.account_id RETURNING b.account_id`)).rows ?? [];
console.log(`payout banks added: ${banked.length}`);
