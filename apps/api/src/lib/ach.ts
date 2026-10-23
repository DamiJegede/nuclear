import type { Env } from "../env";

/** One bank movement in a settlement batch (`itemId` is the `settlements` row). `credit` pays the merchant's bank; `debit` collects from it. */
export type AchItem = { itemId: string; direction: "credit" | "debit"; amountCents: bigint; bankAccountId: string; accountId: string };
export type AchOutcome = { itemId: string; outcome: "settled" | "returned"; code?: string };

/**
 * The bank rail behind settlement. No ACH provider is chosen yet, so this is the seam: a real adapter reads the account numbers it
 * needs with `revealBank()` (audited) and talks to the provider; nothing else in settlement changes. `outcomes` returns only the items
 * whose result is known (a missing item is still in flight, never a failure).
 */
export interface AchProvider {
  readonly name: string;
  /** Sends the batch to the bank and returns its reference. Throws when nothing was accepted. */
  submit(batchKey: string, items: AchItem[]): Promise<{ reference: string }>;
  outcomes(reference: string, items: AchItem[]): Promise<AchOutcome[]>;
}

/** Stands in for the bank in sandbox: accepts every batch and settles every item at the next poll. */
export const sandboxAch: AchProvider = {
  name: "sandbox",
  submit: async (batchKey) => ({ reference: `sandbox-${batchKey}` }),
  outcomes: async (_ref, items) => items.map((i) => ({ itemId: i.itemId, outcome: "settled" as const })),
};

/** The provider for this deployment, or null when none is configured (settlement then does nothing rather than pretending to pay). */
export function achProvider(env: Env): AchProvider | null {
  return env.SANDBOX_FUNDING === "true" ? sandboxAch : null;
}
