# Funded balance and approved payment credit

Updated October 13, 2026. Schema plan only. Pending ACH availability and the prior early-spend policy are withdrawn.

## Confirmed rules

- balances holds account_id, balance, balance_pending, credit_limit (default 0), credit_spent (default 0) and updated_at. All monetary values are bigint minor units. Wallets share this account-wide balance and credit line.
- Sending uses funded balance only. Before reservations, available to send = max(balance, 0).
- Merchant payment uses balance first, then separately approved credit. Before reservations, available to pay = max(balance, 0) + max(credit_limit - credit_spent, 0), subject to account eligibility and wallet/tag limits.
- balance_pending summarizes qualifying funds awaiting clearance, defaulting to 0. It is never sendable or spendable. Pending loads do not increase balance, credit_limit or available credit. Credit approval is independent of deposit attempts. credit_spent is outstanding principal, not daily usage, and never resets at midnight.
- Pending/failed/returned loads remain in fundings. Credit available funds only on confirmed successful release under the bank/program release policy, with one successful fund transaction and balanced journal. A failure before release grants nothing to reverse, except headroom reservations.
- Reserve funds, approved credit, wallet budgets and program headroom atomically; retries/callback duplicates cannot post twice. Daily associated-value controls remain in scope even though their summary fields are removed from balances. The query/reservation design remains to finalize.
- Business refunds can make the business balance negative. Refund availability does not wait for the daily ACH collection of that merchant's deficit. Full net daily settlement and historical ownership/deletion constraints remain unchanged.

## Proposed credit accounting rules to finalize

1. At payment, journal the exact funded-balance and credit portions. Decrease balance for the first portion; increase credit_spent for the second. Credit draws must not exceed the approved line under concurrent requests.
2. Successfully released funding repays outstanding credit_spent first; only the remainder increases balance. A pending load cannot repay credit. Funding activity still shows its gross amount. Received P2P balance-credit treatment remains to finalize; sends cannot originate from credit.
3. Refund to the original wallet, bounded by original unrefunded amount and linked with related_transaction_id. Restore the original payment's outstanding credit portion first; credit any remainder to balance. If that credit was already repaid, the corresponding refund can credit balance. Every refund immediately restores payment capacity, but must not convert outstanding credit into sendable funds. Journal per-payment credit repayment attribution so this distinction can be enforced without guessing from the aggregate credit_spent.
4. A later return of successfully released funding reverses its actual journal allocation: restore credit principal it had repaid, and reverse the funded-balance portion. Preserve the successful fund transaction. This can leave a negative consumer balance or credit_spent above the current limit; represent the debt explicitly and block outgoing activity rather than clamping it away. Exact repayment attribution and consumer deficit recovery remain to finalize before live use.
5. Restrict risky/returned-funding accounts and pause automatic reload; never initiate an unapproved replacement debit. Cleared/available funds still have later bank-return risk, so removing pending spend reduces exposure rather than eliminating all returns.
6. Credit eligibility, repayment schedule, suspension, limits, cost/terms and approved program support are not defined by these three balance fields. Do not launch the credit feature until those product/integration rules are finalized.

No per-load early allowances remain. balance_pending is informational only; update it atomically with funding recognition, clearance and pre-clearance failure/cancellation, without counting events twice. The proposed credit allocation rules require explicit journal attribution; a storage mechanism is still to be finalized before implementation.
