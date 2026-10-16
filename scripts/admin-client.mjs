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
