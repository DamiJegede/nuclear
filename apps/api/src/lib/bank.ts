import type { Sql } from "../db";
import type { Env } from "../env";
import { decryptBankField } from "./bankCrypto";
import { log, type Actor } from "./audit";

/**
 * The only way to read a full bank number: returns one bank account's routing number (stored plain) and decrypted account number and writes a `bank.revealed` audit row
 * saying who asked and why. The future settlement job uses it; no route or portal does.
 */
export async function revealBank(sql: Sql, env: Env, bankAccountId: string, actor: Actor, reason: string): Promise<{ routing_number: string; account_number: string } | null> {
  if (!env.BANK_ENCRYPTION_KEY) throw new Error("BANK_ENCRYPTION_KEY is not set");
  const [r] = await sql<{ account_id: string; routing_number: string; account_number: string }[]>`
    select account_id, routing_number, account_number from bank_accounts where id = ${bankAccountId} and status = 'active'`;
  if (!r || !r.account_number.startsWith("v1.")) return null;                     // sandbox placeholders have no real number
  const out = {
    routing_number: r.routing_number,                                             // public: stored as plain digits
    account_number: decryptBankField(env.BANK_ENCRYPTION_KEY, r.account_id, "account", r.account_number),
  };
  await log(sql, { actor, action: "bank.revealed", target: { type: "bank_account", id: bankAccountId }, details: { account_id: r.account_id, reason } });
  return out;
}
