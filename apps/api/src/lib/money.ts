import { z } from "zod";

/** $10,000,000.00 in cents: a hard sanity bound far below 2^53, so Number() is always exact. */
export const MAX_AMOUNT = 1_000_000_000n;

/** Positive integer minor units, as a JSON integer or digit string. Output is bigint. */
export const amount = z
  .union([z.number().int(), z.string().regex(/^\d{1,12}$/)])
  .transform((v) => BigInt(v))
  .refine((v) => v > 0n && v <= MAX_AMOUNT, { message: "amount_out_of_range" });

/** Non-negative variant (limits). */
export const amountOrZero = z
  .union([z.number().int(), z.string().regex(/^\d{1,12}$/)])
  .transform((v) => BigInt(v))
  .refine((v) => v >= 0n && v <= MAX_AMOUNT, { message: "amount_out_of_range" });

/** bigint (or null) -> JSON number. Safe because every stored amount is bounded well below 2^53. */
export function n(v: bigint | number | null | undefined): number | null {
  return v === null || v === undefined ? null : Number(v);
}
