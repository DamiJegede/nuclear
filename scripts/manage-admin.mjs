#!/usr/bin/env node
// List admin accounts, or disable / enable one, issue a new Access Token, or reset its two-step verification.
//
//   ADMIN_API_TOKEN=... node scripts/manage-admin.mjs --list
//   ADMIN_API_TOKEN=... node scripts/manage-admin.mjs --access-id JANEDOE0001 --disable
//   ADMIN_API_TOKEN=... node scripts/manage-admin.mjs --access-id JANEDOE0001 --enable
//   ADMIN_API_TOKEN=... node scripts/manage-admin.mjs --access-id JANEDOE0001 --reset-token [--save file]
//   ADMIN_API_TOKEN=... node scripts/manage-admin.mjs --access-id JANEDOE0001 --reset-mfa
//   ADMIN_API_TOKEN=... node scripts/manage-admin.mjs --access-id JANEDOE0001 --role sales
//
// --reset-token generates a fresh 32-character Access Token (shown once) and signs the person out
// everywhere; --reset-mfa is for a lost phone: the
// authenticator and recovery codes are forgotten and they enrol a new one at their next sign-in.
import { client, flags, showCredentials } from "./admin-client.mjs";

const f = flags(process.argv.slice(2));
const call = client();

const list = await call("GET", "/v1/admin/admins");
if (list.status !== 200) { console.error(`Error (${list.status}):`, JSON.stringify(list.json)); process.exit(1); }

if (f.list) {
  if (list.json.admins.length === 0) console.log("No admin accounts yet. Create one with add-admin.mjs.");
  for (const a of list.json.admins) {
    const flagsOut = [a.role.toUpperCase(), a.status, a.mfa_enabled ? "2-step on" : "2-step NOT set up", a.locked ? "LOCKED" : null].filter(Boolean).join(", ");
    console.log(`${a.access_id.padEnd(16)} ${a.name.padEnd(24)} ${flagsOut}${a.last_login_at ? `  (last sign-in ${a.last_login_at})` : ""}${a.created_by ? `  (added by ${a.created_by})` : ""}`);
  }
  process.exit(0);
}

const accessId = typeof f["access-id"] === "string" ? f["access-id"].trim().toUpperCase() : null;
const action = typeof f.role === "string" ? "role" : f.disable ? "disable" : f.enable ? "enable" : f["reset-token"] ? "reset-token" : f["reset-mfa"] ? "reset-mfa" : null;
if (!accessId || !action) {
  console.error("Usage: manage-admin.mjs --list | --access-id <ID> (--disable | --enable | --reset-token [--save <file>] | --reset-mfa | --role <role>)");
  process.exit(1);
}
const target = list.json.admins.find((a) => a.access_id === accessId);
if (!target) { console.error(`No admin with access ID "${accessId}".`); process.exit(1); }

const body = action === "disable" ? { status: "disabled" }
  : action === "enable" ? { status: "active" }
  : action === "reset-token" ? { reset_access_token: true }
  : { reset_mfa: true };

const { status, json } = action === "role"
  ? await call("PUT", `/v1/admin/admins/${target.id}/role`, { role: f.role })
  : await call("PATCH", `/v1/admin/admins/${target.id}`, body);
if (status !== 200) { console.error(`Error (${status}): ${JSON.stringify(json)}`); process.exit(1); }

if (action === "role") console.log(`${accessId} is now ${json.admin.role}.`);
else if (action === "disable") console.log(`Disabled ${accessId}; they are signed out everywhere.`);
else if (action === "enable") console.log(`Enabled ${accessId}.`);
else if (action === "reset-mfa") console.log(`Two-step verification reset for ${accessId}; they are signed out everywhere and must set up a new authenticator at their next sign-in.`);
else {
  console.log(`New Access Token issued for ${accessId}; they are signed out everywhere.`);
  showCredentials(target.name, json.credentials, f.save);
}
