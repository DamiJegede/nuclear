#!/usr/bin/env node
// Create an admin portal account. The server generates the Access ID (12 characters, uppercase) and
// the Access Token (32 characters) and returns them once; only a hash of the token is kept.
//
//   ADMIN_API_TOKEN=... node scripts/add-admin.mjs --name "Jane Doe"
//   ADMIN_API_TOKEN=... node scripts/add-admin.mjs --name "Jane Doe" --save jane-credentials.txt
//
// The person must replace the token with their own and set up two-step verification at first sign-in.
import { client, flags, showCredentials } from "./admin-client.mjs";

const f = flags(process.argv.slice(2));
if (typeof f.name !== "string" || !f.name.trim()) {
  console.error('Usage: add-admin.mjs --name "<full name>" [--save <file>]');
  process.exit(1);
}

const call = client();
const { status, json } = await call("POST", "/v1/admin/admins", { name: f.name.trim() });
if (status !== 201) {
  console.error(`Error creating the account (${status}): ${JSON.stringify(json)}`);
  process.exit(1);
}
console.log(`Created ${json.admin.name}.`);
showCredentials(json.admin.name, json.credentials, f.save);
