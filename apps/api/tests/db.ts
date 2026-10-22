// Shared helpers for the API test suites: a throwaway Postgres 18 on 127.0.0.1:54340 (started by run.mjs).
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";

export const ROOT = new URL("../../../", import.meta.url).pathname;
export const PG_URL = "postgres://postgres@127.0.0.1:54340/nuclear";
const BIN = process.env.PG_BIN ?? "/opt/homebrew/opt/postgresql@18/bin";

export const psql = (args: string[]) =>
  execFileSync(`${BIN}/psql`, ["-h", "127.0.0.1", "-p", "54340", "-U", "postgres", "nuclear", "-v", "ON_ERROR_STOP=1", "-q", ...args], { stdio: "pipe" });

export const resetSchema = () => psql(["-c", "drop schema public cascade; create schema public;"]);

export const migrationFiles = () => readdirSync(ROOT + "migrations").filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
export const applyMigration = (file: string) => psql(["-f", ROOT + "migrations/" + file]);
/** Applies every migration in order (or up to and including `upTo`). */
export const migrate = (upTo?: string) => { for (const f of migrationFiles()) { if (upTo && f > upTo) break; applyMigration(f); } };

/** Zeroes wallets.spent_today and products.sold_today (what the midnight reset does), for tests that move the day by hand. */
export async function resetDailyCounters(sql: any): Promise<{ wallets: number; products: number }> {
  const w = await sql`update wallets set spent_today = 0 where spent_today <> 0 returning id`;
  const p = await sql`update products set sold_today = 0 where sold_today <> 0 returning id`;
  return { wallets: w.length, products: p.length };
}
