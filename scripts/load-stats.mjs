#!/usr/bin/env node
// Measures how many events per second the counter Durable Objects absorb (the Overview's running estimate). It calls the operator probe
// (POST /v1/admin/stats/loadtest), which writes only to the throwaway day "loadtest", then reads the total back and deletes it.
//
//   ADMIN_API_TOKEN=... node scripts/load-stats.mjs [--shards 1] [--requests 40] [--events 200] [--width 6] [--api https://api.nclr.app]
//
// --requests parallel requests are fired together; each makes --events calls to the objects, --width at a time.
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const API = arg("api", process.env.API_URL ?? "https://api.nclr.app");
const TOKEN = process.env.ADMIN_API_TOKEN;
if (!TOKEN) { console.error("Set ADMIN_API_TOKEN"); process.exit(2); }
const shards = Number(arg("shards", 1)), requests = Number(arg("requests", 40)), events = Number(arg("events", 200)), width = Number(arg("width", 6));
const call = (m, p, body) => fetch(API + p, { method: m, headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });

await call("DELETE", `/v1/admin/stats/loadtest?shards=${Math.max(shards, 16)}`);
const t0 = performance.now();
const res = await Promise.all(Array.from({ length: requests }, async () => { const r = await call("POST", "/v1/admin/stats/loadtest", { events, shards, width }); return r.ok ? r.json() : { events, ok: 0, failed: events, ms: 0, p50: 0, p95: 0, max: 0, http: r.status }; }));
const wall = (performance.now() - t0) / 1000;
const ok = res.reduce((a, r) => a + r.ok, 0), failed = res.reduce((a, r) => a + r.failed, 0);
const counted = (await (await call("GET", `/v1/admin/stats/loadtest?shards=${shards}`)).json()).probe_n;
await call("DELETE", `/v1/admin/stats/loadtest?shards=${Math.max(shards, 16)}`);
const med = (k) => res.map((r) => r[k]).sort((a, b) => a - b)[Math.floor(res.length / 2)];
console.log(JSON.stringify({ shards, requests, events_per_request: events, total_events: requests * events, ok, failed, counted_by_objects: counted, wall_seconds: +wall.toFixed(2), events_per_second: Math.round(ok / wall), call_p50_ms: med("p50"), call_p95_ms: med("p95"), worst_call_ms: Math.max(...res.map((r) => r.max)), http_errors: res.filter((r) => r.http).length }));
