#!/usr/bin/env node
// Runs the API test suites against a throwaway Postgres 18 (port 54340), then removes it.
//
//   npm run test:api                  all suites
//   npm run test:api -- wallets edge  only suites whose file name contains one of the words
//
// Needs Postgres 18 binaries: PG_BIN (default /opt/homebrew/opt/postgresql@18/bin). Nothing touches PlanetScale.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const BIN = process.env.PG_BIN ?? "/opt/homebrew/opt/postgresql@18/bin";
const here = fileURLToPath(new URL(".", import.meta.url));
const only = process.argv.slice(2);
const files = readdirSync(here).filter((f) => /\.(e2e|test)\.mts$/.test(f)).filter((f) => only.length === 0 || only.some((w) => f.includes(w))).sort();
if (files.length === 0) { console.error("no suites match", only); process.exit(2); }

const dir = mkdtempSync(join(tmpdir(), "nuclear-pg-"));
const run = (cmd, a, opts = {}) => execFileSync(join(BIN, cmd), a, { stdio: "pipe", ...opts });
let started = false;
const stop = () => { if (started) { try { run("pg_ctl", ["-D", dir, "-m", "immediate", "stop"]); } catch { /* already stopped */ } } rmSync(dir, { recursive: true, force: true }); };
process.on("SIGINT", () => { stop(); process.exit(130); });

try {
  run("initdb", ["-D", dir, "-U", "postgres", "--auth=trust", "-E", "UTF8"]);
  run("pg_ctl", ["-D", dir, "-o", `-p 54340 -h 127.0.0.1 -k ${dir}`, "-w", "-l", join(dir, "pg.log"), "start"]);
  started = true;
  run("createdb", ["-h", "127.0.0.1", "-p", "54340", "-U", "postgres", "nuclear"]);
} catch (e) {
  console.error("Could not start Postgres:", String(e.stderr ?? e.message).trim().split("\n").slice(-3).join("\n"));
  stop(); process.exit(2);
}

let failed = 0;
const rows = [];
for (const f of files) {
  const t = Date.now();
  const r = spawnSync("npx", ["tsx", join(here, f)], { encoding: "utf8", cwd: here, maxBuffer: 64 << 20 });
  const out = (r.stdout ?? "") + (r.stderr ?? "");
  const summary = out.trim().split("\n").filter((l) => /passed|failed/i.test(l)).pop() ?? "(no summary)";
  const ok = r.status === 0 && !/^FAIL/m.test(out);
  if (!ok) { failed++; console.log(out.split("\n").filter((l) => /^FAIL|Error|error:/.test(l)).slice(0, 12).join("\n")); }
  rows.push(`${ok ? "PASS" : "FAIL"}  ${f.padEnd(26)} ${summary.trim()}  (${((Date.now() - t) / 1000).toFixed(1)}s)`);
  console.log(rows[rows.length - 1]);
}
stop();
console.log(`\n${files.length - failed}/${files.length} suites passed`);
process.exit(failed ? 1 : 0);
