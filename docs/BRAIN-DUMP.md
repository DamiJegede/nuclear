# Brain Dump

A running record of ideas shared in the brain dump chat. Preserve the original intent, connect related ideas, and record decisions or next steps when discussed. Ideas remain exploratory until explicitly adopted.

## Ideas

### Company employee credit CSV batches

Captured: 2026-10-19.

When a company uploads a CSV listing employees and the amount to credit each employee, calculate the sum of all credits and check the company's wallet balance before running the batch.

- Run the batch only if the company's wallet balance is greater than or equal to the total credits.
- If the balance is less than the total, do not run the batch.

### Employees table

Captured: 2026-10-19.

Add a new table, `employees`, with these fields in this order:

- `id`
- `org_account_id`
- `employee_account_id`
- `employee_id`
- `name`
- `email`
- `amount`
- `balance`
- `claim_token`
- `created_at`
- `updated_at`

Related idea: company employee credit CSV batches above.

### Employee CSV format and matching

Captured: 2026-10-19.

- The CSV contains `employee_id`, `name`, `email`, and `amount`.
- `employee_id` is alphanumeric and immutable.
- If a user with that `employee_id` already exists, update their `name` and `email` from the CSV.

Related ideas: the `employees` table and company employee credit CSV batches above.

### First-time employee credits and claims

Captured: 2026-10-19.

- First-time employees are employees without an `employee_account_id`.
- When these employees receive a credit, email them the amount received and a celebratory message explaining that they can spend it across all participating Nuclear merchants.
- Prompt them to link their Nuclear wallet or sign up with one click.
- For employees without an account, hold the credited funds in the employee's `balance` column.
- Include the employee's `claim_token` in the email so they can claim their credit.
- The proposed `employees` table includes `balance` and `claim_token` immediately before `created_at`, in that order.

Related ideas: the `employees` table, employee CSV matching, and company employee credit CSV batches above.

### Decisions: employees.balance and escrow

Captured: 2026-10-19.

- Decided: keep `employees.balance`. It is the cached held amount for an employee who has no Nuclear wallet yet, checked in reconciliation against the net of the `employee_escrow` ledger bucket (migration 0029, applied to nuclear-dev).
- `amount` is the per-employee amount in the CSV batch. The first list above includes an `amount` column in `employees`, but that was unexpected: no `amount` column is planned unless Dami asks for one (the batch amount does not need to be stored on the employee).
- `employees.balance` increases when a credit is made to an employee who has no wallet; an employee who already has an account is credited straight to their account balance, so their `balance` stays 0.
- Unclaimed credits never expire. Nuclear reminds the person by email every month until they claim.
- Open: what claiming does (assumed: move `balance` into the new account's funded balance and set it to 0), and how the monthly reminder is scheduled (the daily cron could send them).
