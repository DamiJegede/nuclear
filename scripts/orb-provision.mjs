#!/usr/bin/env node
// Factory step: derive the device key K_orb for one or more Orb UIDs (docs/ORB.md §8a) so it can be written to each Orb's secure storage.
// The root key is read from ORB_ROOT_KEY_V1 in the environment (never an argument); output goes to a 0600 file, never the terminal.
//   export ORB_ROOT_KEY_V1=$(grep ^ORB_ROOT_KEY_V1= apps/api/.dev.vars | cut -d= -f2)
//   node scripts/orb-provision.mjs --out keys.csv AA:BB:CC:00:11:22 [more uids...]
import { createHmac } from "node:crypto";
import { writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const oi = args.indexOf("--out");
if (oi < 0 || !args[oi + 1]) { console.error("usage: orb-provision.mjs --out <file> <uid>..."); process.exit(2); }
const out = args[oi + 1];
const uids = args.filter((_, i) => i !== oi && i !== oi + 1);
const rootHex = process.env.ORB_ROOT_KEY_V1 ?? "";
if (!/^[0-9a-fA-F]{64}$/.test(rootHex)) { console.error("ORB_ROOT_KEY_V1 must be 64 hex characters in the environment"); process.exit(2); }
if (uids.length === 0) { console.error("give at least one Orb UID (MAC address)"); process.exit(2); }

const root = Buffer.from(rootHex, "hex");
const rows = ["uid,k_orb"];
for (const raw of uids) {
  const uid = raw.replace(/[^0-9a-fA-F]/g, "").toUpperCase();
  if (uid.length !== 12) { console.error(`not a 6-byte UID: ${raw}`); process.exit(2); }
  const k = createHmac("sha256", root).update(Buffer.concat([Buffer.from("nuclear-orb-device-v1"), Buffer.from([0]), Buffer.from(uid, "hex")])).digest("hex");
  rows.push(`${uid},${k}`);
}
writeFileSync(out, rows.join("\n") + "\n", { mode: 0o600 });
console.log(`wrote ${uids.length} device key(s) to ${out} (mode 0600)`);
