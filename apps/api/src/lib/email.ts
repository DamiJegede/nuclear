import type { Env } from "../env";

export type MailResult = "sent" | "failed" | "not_configured";

/**
 * Sends one plain-text email through Cloudflare Email Service. It never throws: the caller records the
 * outcome (and the text) in the audit log, so an email problem never undoes the action that caused it.
 */
export async function sendMail(env: Env, m: { to: string; subject: string; text: string }): Promise<MailResult> {
  if (!env.EMAIL || !env.EMAIL_FROM) return "not_configured";
  try {
    await env.EMAIL.send({ from: env.EMAIL_FROM, to: m.to, subject: m.subject, text: m.text });
    return "sent";
  } catch (err) {
    console.error("email failed", err);
    return "failed";
  }
}

export const approvedEmail = (name: string) => ({
  subject: "Your Nuclear business account is approved",
  text: `Hello ${name},\n\nGood news: your business account on Nuclear has been approved. You can now sign in and start accepting payments.\n\nThe Nuclear team`,
});

export const declinedEmail = (name: string, reason: string) => ({
  subject: "Your Nuclear business account needs attention",
  text: `Hello ${name},\n\nWe could not approve your business account yet.\n\nReason:\n${reason}\n\nWhat to do next: sign in, upload a corrected business document and we will review it again. If you have questions, reply to this email.\n\nThe Nuclear team`,
});

const usd = (cents: bigint | number) => `$${(Number(cents) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Sent when an organization credits an employee who has not claimed yet. The claim link carries a one-time token. */
export const creditEmail = (name: string, org: string, amountCents: bigint, link: string) => ({
  subject: `${org} sent you ${usd(amountCents)} on Nuclear`,
  text: `Hello ${name},\n\nGreat news: ${org} just credited you ${usd(amountCents)} on Nuclear. You can spend it at every participating Nuclear merchant.\n\nClaim it in one step by signing in or signing up with this link:\n${link}\n\nYour credit never expires and is held for you until you claim it.\n\nThe Nuclear team`,
});

/** The monthly nudge while a credit is still unclaimed. */
export const creditReminderEmail = (name: string, org: string, amountCents: bigint, link: string) => ({
  subject: `Your ${usd(amountCents)} from ${org} is waiting on Nuclear`,
  text: `Hello ${name},\n\nYou still have ${usd(amountCents)} from ${org} waiting for you on Nuclear. It never expires, and you can spend it at every participating Nuclear merchant.\n\nClaim it by signing in or signing up with this link:\n${link}\n\nThe Nuclear team`,
});
