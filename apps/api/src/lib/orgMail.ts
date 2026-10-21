import { randomBytes } from "node:crypto";
import type { Sql } from "../db";
import type { Env } from "../env";
import { hashToken } from "../crypto";
import { creditEmail, creditReminderEmail, sendMail } from "./email";
import type { Notice } from "./org";

export const claimLink = (env: Env, token: string) => `${(env.APP_URL ?? "https://app.nuclear.us").replace(/\/+$/, "")}/claim?token=${encodeURIComponent(token)}`;

/** Emails the employees a batch left holding money. Returns how each went; never throws. */
export async function sendCreditEmails(env: Env, sql: Sql, orgName: string, notices: Notice[]) {
  const out = { sent: 0, failed: 0, not_configured: 0 };
  for (const x of notices) {
    const m = creditEmail(x.name, orgName, x.amount, claimLink(env, x.token));
    const r = await sendMail(env, { to: x.email, ...m });
    out[r] += 1;
    if (r !== "sent") await sql`update employees set reminded_at = null where claim_token_hash = ${hashToken(x.token)}`;
  }
  return out;
}

/**
 * The monthly nag: every unclaimed employee holding money who was last told 30 or more days ago (or never) gets a fresh claim link.
 * A new token replaces the old one, so only the newest email's link works. Employees who were removed but still have credit held are included: it is still theirs. Runs in the daily cron, at most 200 people per run.
 */
export async function remindUnclaimed(env: Env, sql: Sql, limit = 200) {
  const due = await sql<{ id: string; name: string; email: string; balance: bigint; org_name: string }[]>`
    select e.id, e.name, e.email, e.balance, o.name as org_name
      from employees e join accounts o on o.id = e.org_account_id
     where e.employee_account_id is null and e.balance > 0
       and (e.reminded_at is null or e.reminded_at <= now() - interval '30 days')
     order by e.reminded_at nulls first, e.id limit ${limit}`;
  let sent = 0;
  for (const e of due) {
    const token = randomBytes(32).toString("base64url");
    const m = creditReminderEmail(e.name, e.org_name, e.balance, claimLink(env, token));
    if ((await sendMail(env, { to: e.email, ...m })) === "sent") {
      await sql`update employees set claim_token_hash = ${hashToken(token)}, reminded_at = now() where id = ${e.id} and employee_account_id is null`;
      sent += 1;
    }
  }
  return { due: due.length, sent };
}
