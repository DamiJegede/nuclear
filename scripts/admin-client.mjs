// Shared by the operator scripts: reads API_URL and ADMIN_API_TOKEN from the environment.
// Never put the token on the command line (it would land in shell history).
export function client() {
  const base = (process.env.API_URL ?? "https://nuclear-api.a-space.workers.dev").replace(/\/$/, "");
  const token = process.env.ADMIN_API_TOKEN;
  if (!token) {
    console.error("ADMIN_API_TOKEN is not set. Export it in your shell (do not pass it as an argument).");
    process.exit(1);
  }
  return async function call(method, path, body) {
    const res = await fetch(base + path, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json;
    try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text.slice(0, 200) }; }
    return { status: res.status, json };
  };
}

import { writeFileSync } from "node:fs";

/** The text of a downloadable credentials file (also what the portal offers). */
export function credentialsText(name, creds, portalUrl) {
  return [
    "Nuclear Admin sign-in",
    portalUrl ? `Portal:        ${portalUrl}` : null,
    `Name:          ${name}`,
    `Access ID:     ${creds.access_id}`,
    `Access Token:  ${creds.access_token}`,
    "",
    "Keep this file private and delete it once you have signed in.",
    "At your first sign-in you set up two-step verification with an authenticator app.",
    "and set up two-step verification with an authenticator app. This one then stops working.",
    "",
  ].filter((l) => l !== null).join("\n");
}

/**
 * Show freshly issued credentials exactly once. With --save <file> they go to a private (0600) file and
 * the token is not printed; otherwise they are printed to the terminal.
 */
export function showCredentials(name, creds, saveTo) {
  if (typeof saveTo === "string") {
    writeFileSync(saveTo, credentialsText(name, creds, process.env.PORTAL_URL), { mode: 0o600 });
    console.log(`Access ID:    \x1b[1m\x1b[32m${creds.access_id}\x1b[0m`);
    console.log(`The Access Token was saved to ${saveTo} (readable only by you). It is not shown again.`);
  } else {
    console.log(`Access ID:     \x1b[1m\x1b[32m${creds.access_id}\x1b[0m`);
    console.log(`Access Token:  \x1b[1m\x1b[32m${creds.access_token}\x1b[0m`);
    console.log("This is the only time the Access Token is shown. Copy it now.");
  }
  console.log("They set up two-step verification at first sign-in.");
}

/** Minimal --flag value parser. */
export function flags(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) out[key] = true;
    else { out[key] = next; i++; }
  }
  return out;
}
