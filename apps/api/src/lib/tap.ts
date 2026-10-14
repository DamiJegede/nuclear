import type { TransactionSql } from "postgres";
import type { Sql } from "../db";

type Q = Sql | TransactionSql<{ bigint: bigint }>;

export type TappedTag = {
  id: string;
  counter: bigint | null;
  locked: boolean;
  wallet_id: string | null;
  transaction_limit: bigint | null;
  account_id: string | null;
  account_type: string | null;
  account_status: string | null;
  handle: string | null;
  display_name: string | null;
  photo: string | null;
};

/** Resolve a verified tag UID to its tag row, wallet and owning account. Optionally row-locks the tag. */
export async function loadTag(q: Q, uid: string, lock: boolean): Promise<TappedTag | undefined> {
  const [t] = await q<TappedTag[]>`
    select t.id, t.counter, t.locked, t.wallet_id, t.transaction_limit,
           w.account_id, a.type as account_type, a.status as account_status, a.handle,
           w.display_name, w.photo
      from tags t
      left join wallets w on w.id = t.wallet_id
      left join accounts a on a.id = w.account_id
     where t.uid = ${uid}
     ${lock ? q`for no key update of t` : q``}`;
  return t;
}

/** A proof is single-use: its counter must exceed the last consumed one (NULL = none yet). */
export function isFresh(tag: TappedTag, counter: number): boolean {
  return tag.counter === null || BigInt(counter) > tag.counter;
}

/** Consume the counter. Call inside the same transaction as the outcome it authorizes. */
export async function consumeCounter(q: Q, tagId: string, counter: number): Promise<void> {
  await q`update tags set counter = ${counter}, last_read_at = now() where id = ${tagId}`;
}
