#!/usr/bin/env node
// Create a band/card model (replaces the old AddModel.ts).
//
//   ADMIN_API_TOKEN=... node scripts/add-model.mjs --name "NEO Band Lite" --type band \
//     --price 29.99 --quantity 1000 --photo https://neo.band/assets/model/lite.png \
//     [--status available] [--limited] [--country US] [--currency USD]
import { client, flags } from "./admin-client.mjs";

const f = flags(process.argv.slice(2));
const missing = ["name", "type", "price", "quantity"].filter((k) => f[k] === undefined || f[k] === true);
if (missing.length) {
  console.error(`Missing: ${missing.map((m) => "--" + m).join(", ")}`);
  process.exit(1);
}

const dollars = Number(f.price);
if (!Number.isFinite(dollars) || dollars < 0) { console.error("--price must be a number, e.g. 29.99"); process.exit(1); }

const call = client();
const { status, json } = await call("POST", "/v1/admin/tag-models", {
  type: f.type,
  name: f.name,
  photo: typeof f.photo === "string" ? f.photo : undefined,
  currency: typeof f.currency === "string" ? f.currency : undefined,
  price: Math.round(dollars * 100), // minor units (cents)
  country: typeof f.country === "string" ? f.country : undefined,
  quantity: Number(f.quantity),
  limited: f.limited === true,
  status: typeof f.status === "string" ? f.status : undefined,
});

if (status !== 201) { console.error(`Error creating model (${status}):`, JSON.stringify(json)); process.exit(1); }
console.log(`Added model: \x1b[1m\x1b[32m${json.model.name}\x1b[0m  \x1b[31m${json.model.id}\x1b[0m`);
