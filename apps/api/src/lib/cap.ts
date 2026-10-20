/**
 * The daily value cap (docs/BALANCE-POLICY.md): ONE rule for every addition to a consumer's ordinary money (released bank loads, incoming
 * sends, Benefits-to-ordinary moves). Headroom = cap - ordinary opening value - added today - pending loads, never below 0. The numbers sit on
 * the account's balances row (ordinary_opening, opening_day, added_today), which every money movement already locks, so the check is one read.
 *  - Refunds, claims and employer credits into Benefits wallets are not additions: never capped, never counted.
 *  - Spending, sending and reversals never reduce added_today.
 *  - Organizations and businesses are exempt (the cap is a consumer rule).
 *  - A bank load that settles after the room is gone is still credited (headroom just reads 0); only new additions are held to the cap.
 */
export type CapRow = {
  account_type: string;
  balance: bigint;
  balance_pending: bigint;
  ordinary_opening: bigint;
  opening_day: string;
  added_today: bigint;
  /** Today's program day, and the account's Benefits balances, read in the same statement as the row. */
  today: string;
  benefits: bigint;
};

/** The SQL columns a money path adds to its balances read (use with `from balances b join accounts a on a.id = b.account_id`). */
export const CAP_COLS = `a.type as account_type, b.balance_pending, b.ordinary_opening, b.opening_day::text as opening_day, b.added_today,
  (now() at time zone 'America/New_York')::date::text as today,
  coalesce((select sum(w.balance) from wallets w where w.account_id = b.account_id and w.type = 'benefits'), 0)::bigint as benefits`;

export const capApplies = (r: Pick<CapRow, "account_type">) => r.account_type === "C";

/** The row's numbers for today: a row from an earlier day rolls itself (ensureDay normally has done this for everyone already). */
export function capToday(r: CapRow): { opening: bigint; added: bigint } {
  return r.opening_day < r.today ? { opening: r.balance - r.benefits, added: 0n } : { opening: r.ordinary_opening, added: r.added_today };
}

export function capHeadroom(r: CapRow, cap: bigint): bigint {
  const { opening, added } = capToday(r);
  const left = cap - opening - added - r.balance_pending;
  return left > 0n ? left : 0n;
}
