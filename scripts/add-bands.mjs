#!/usr/bin/env node
// Import the supplier's UID list for a model as unassigned bands/cards (replaces the old AddBands.ts).
//
//   ADMIN_API_TOKEN=... node scripts/add-bands.mjs --model <model-id> --file uids.txt
//   ADMIN_API_TOKEN=... node scripts/add-bands.mjs --model <model-id> --uids 04AE42EAAF1290,04AE42EAAF1291
//
// The file holds one UID per line (7-byte NFC UID, 14 hex characters; ':' separators and lower case
// are fine). The whole list is validated first: one bad UID rejects the batch and nothing is added.
import { readFileSync } from "node:fs";
import { client, flags } from "./admin-client.mjs";

const f = flags(process.argv.slice(2));
if (typeof f.model !== "string") { console.error("Missing --model <model-id>"); process.exit(1); }

let uids;
if (typeof f.file === "string") {
  uids = readFileSync(f.file, "utf8").split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
} else if (typeof f.uids === "string") {
  uids = f.uids.split(",").map((u) => u.trim()).filter(Boolean);
} else {
  console.error("Give --file <path> or --uids <comma-separated>");
  process.exit(1);
}

const call = client();
let inserted = 0, requested = 0, duplicatesInList = 0;
const existing = [];
// The API accepts up to 5000 per request.
for (let i = 0; i < uids.length; i += 5000) {
  const { status, json } = await call("POST", `/v1/admin/tag-models/${f.model}/tags`, { uids: uids.slice(i, i + 5000) });
  if (status !== 201) {
    console.error(`Error adding bands (${status}):`, JSON.stringify(json));
    if (i > 0) console.error(`Note: the first ${i} UIDs were already imported.`);
    process.exit(1);
  }
  inserted += json.inserted;
  requested += json.requested;
  duplicatesInList += json.duplicates_in_request;
  existing.push(...json.already_existing);
  var modelName = json.model_name;
}

console.log(`\x1b[1m\x1b[92mINSERTED ${inserted} of ${requested} bands for model ${modelName}\x1b[0m`);
if (duplicatesInList) console.log(`  ${duplicatesInList} duplicate UID(s) within your list were ignored`);
if (existing.length) {
  console.log(`  ${existing.length} UID(s) already existed and were left unchanged:`);
  for (const e of existing.slice(0, 20)) console.log(`    ${e.uid} (model ${e.model_id})`);
  if (existing.length > 20) console.log(`    ... and ${existing.length - 20} more`);
}
