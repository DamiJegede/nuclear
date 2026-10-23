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

/**
 * Moves every daily counter one program day into the past, as if all of them were last written yesterday: from then on a wallet's spent_today,
 * a product's sold_today and an account's daily-cap numbers count as a new day (they roll themselves on the next read or write).
 */
export async function newDay(sql: any): Promise<void> {
  await sql`update wallets set spent_day = spent_day - 1`;
  await sql`update products set sold_day = sold_day - 1`;
  await sql`update balances set opening_day = opening_day - 1`;
}

/** The midnight reset for tests that only care about the wallet and product counters: how many had something to reset. */
export async function resetDailyCounters(sql: any): Promise<{ wallets: number; products: number }> {
  const w = await sql`update wallets set spent_day = program_today() - 1 where spent_day = program_today() and spent_today <> 0 returning id`;
  const p = await sql`update products set sold_day = program_today() - 1 where sold_day = program_today() and sold_today <> 0 returning id`;
  return { wallets: w.length, products: p.length };
}
