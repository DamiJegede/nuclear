// Normalises stored bank numbers: account numbers still in plain digits are encrypted, and routing numbers that were encrypted (v1.…) are
// decrypted back to plain digits (routing numbers are public). One-off conversion; safe to run again.
//   npx tsx scripts/encrypt-bank-numbers.mts            # shows how many rows would change
//   npx tsx scripts/encrypt-bank-numbers.mts --apply    # converts them
// Reads BANK_ENCRYPTION_KEY from apps/api/.dev.vars (never printed) and writes with `pscale` (nuclear-dev main). Placeholder rows (SANDBOX)
// and rows already encrypted are left alone. Apply the CHECK migration (0026) after this has converted every real row.
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { decryptBankField, encryptBankField } from "../apps/api/src/lib/bankCrypto.ts";

const apply = process.argv.includes("--apply");
const vars = Object.fromEntries(
  readFileSync(fileURLToPath(new URL("../apps/api/.dev.vars", import.meta.url)), "utf8")
    .split("\n").filter((l) => l.includes("=") && !l.startsWith("#")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
);
const KEY = vars.BANK_ENCRYPTION_KEY;
if (!KEY) { console.error("BANK_ENCRYPTION_KEY is needed in apps/api/.dev.vars"); process.exit(1); }
const sql = (query: string) => JSON.parse(execFileSync("pscale", ["sql", "nuclear-dev", "main", "--org", "nuclear", "--role", "admin", "--force", "--format", "json", "--query", query], { encoding: "utf8" }));

const rows: { id: string; account_id: string; routing_number: string; account_number: string }[] =
  sql("select id, account_id, routing_number, account_number from bank_accounts where account_number ~ '^[0-9]+$' or routing_number like 'v1.%'").rows ?? [];
console.log(`${rows.length} bank account(s) need converting`);
if (!apply) { console.log("run with --apply to convert them"); process.exit(0); }
for (const r of rows) {
  const routing = r.routing_number.startsWith("v1.") ? decryptBankField(KEY, r.account_id, "routing", r.routing_number) : r.routing_number;
  const account = /^[0-9]+$/.test(r.account_number) ? encryptBankField(KEY, r.account_id, "account", r.account_number) : r.account_number;
  // values are digits, base64url text and uuids, so quoting is safe
  sql(`update bank_accounts set routing_number = '${routing}', account_number = '${account}' where id = '${r.id}'`);
}
const left = sql("select count(*)::int n from bank_accounts where account_number ~ '^[0-9]+$' or routing_number like 'v1.%'").rows?.[0]?.n;
console.log(`converted ${rows.length}; rows still to convert: ${left}`);
