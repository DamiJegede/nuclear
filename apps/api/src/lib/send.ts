import { callMoney, txRowFromJson, type TxRow } from "./txn";
import type { Sql } from "../db";

export type SendInput = {
  actorAccountId: string;
  /** The device of the signed session (null for an agent key): it must still be live. */
  deviceId?: string | null;
  /** Set for delegated (shared-wallet) sessions; the sender must be this wallet. */
  authWalletId: string | null;
  fromWalletId: string | null;
  toWalletId: string;
  amount: bigint;
  idempotencyKey: string;
  dailyCap: bigint;
};

export type SendOutcome =
  | { kind: "ok"; tx: TxRow; replayed: boolean }
  | { kind: "declined"; tx: TxRow; replayed: boolean }
  | { kind: "error"; status: 401 | 404 | 409 | 422; error: string };

type Answer = { kind: "ok" | "declined"; replayed: boolean; tx: Record<string, unknown> } | { kind: "error"; status: 401 | 404 | 409 | 422; error: string };

/**
 * Wallet -> wallet transfer of funded balance (never credit): the `app_send` SQL function, one database call (migrations/0002). It locks
 * the two balance rows and the sender wallet, checks the idempotency key under those locks, applies every rule, and writes either the
 * completed transaction with its balance changes or a `declined` transaction (nothing else changes).
 */
export async function sendFunds(sql: Sql, i: SendInput): Promise<SendOutcome> {
  const arg = {
    actor: i.actorAccountId, device: i.deviceId ?? null, auth_wallet: i.authWalletId, from_wallet: i.fromWalletId, to_wallet: i.toWalletId,
    amount: Number(i.amount), key: i.idempotencyKey, cap: Number(i.dailyCap),
  };
  const a = await callMoney<Answer>(sql, "app_send", arg);
  if (a.kind === "error") return a;
  return { kind: a.kind, tx: txRowFromJson(a.tx), replayed: a.replayed };
}
