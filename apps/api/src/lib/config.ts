/** Program daily associated-value cap in cents: $2,000 by default (spec target, not final), `DAILY_VALUE_CAP_CENTS` overrides it. */
export const DEFAULT_DAILY_VALUE_CAP = 200_000n;

export function dailyCap(env: { DAILY_VALUE_CAP_CENTS?: string }): bigint {
  const v = env.DAILY_VALUE_CAP_CENTS;
  return v && /^\d+$/.test(v) ? BigInt(v) : DEFAULT_DAILY_VALUE_CAP;
}
