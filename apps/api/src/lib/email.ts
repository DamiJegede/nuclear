import type { Env } from "../env";

export type MailResult = "sent" | "failed" | "not_configured" | "suppressed";

/**
 * Addresses on these domains belong to seeded demo and test data and must never receive real mail (the demo scripts create hundreds of
 * them). A message to one is not sent and reports "suppressed", which callers treat as handled, not as a failure.
 */
const SUPPRESSED_DOMAINS = ["seed.nuclear.test"];

export function isSuppressed(address: string): boolean {
  const domain = address.trim().toLowerCase().split("@").pop() ?? "";
  return SUPPRESSED_DOMAINS.some((d) => domain === d || domain.endsWith(`.${d}`));
}

/**
 * Sends one plain-text email through Cloudflare Email Service. It never throws: the caller records the
 * outcome (and the text) in the audit log, so an email problem never undoes the action that caused it.
 */
export async function sendMail(env: Env, m: { to: string; subject: string; text: string }): Promise<MailResult> {
  if (isSuppressed(m.to)) return "suppressed";
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

const dateLabel = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" });

/** To the organization, a few days before a scheduled payment its wallet cannot cover. */
export const lowFundsEmail = (org: string, date: string, total: bigint, balance: bigint) => ({
  subject: `Add funds before ${dateLabel(date)}: your scheduled benefits need ${usd(total)}`,
  text: `Hello ${org},\n\nYour Fixed Benefits payment is scheduled for ${dateLabel(date)} and needs ${usd(total)}. Your Nuclear wallet holds ${usd(balance)}.\n\nAdd funds before then so every employee is paid on time. If the wallet is still short on the day, we try again each day for three days and then mark the payment missed.\n\nThe Nuclear team`,
});

/** To the organization, when a scheduled payment could not be made and the retries are over. */
export const runMissedEmail = (org: string, date: string, total: bigint, reason: string) => ({
  subject: `Your ${dateLabel(date)} benefits payment was missed`,
  text: `Hello ${org},\n\nWe could not make your scheduled Fixed Benefits payment of ${usd(total)} for ${dateLabel(date)} (${reason}). Nobody was charged and no employee was credited.\n\nThe next scheduled payment is unchanged. If you still want to pay these benefits now, you can credit them from the Benefits page or the Benefits API.\n\nThe Nuclear team`,
});

/** Sent at sign-up (and on request): proves the person controls the address. */
export const verifyEmail = (name: string, link: string) => ({
  subject: "Verify your email for Nuclear",
  text: `Hello ${name},\n\nPlease confirm this is your email address by opening this link within 24 hours:\n${link}\n\nIf you did not create a Nuclear account, you can ignore this email.\n\nThe Nuclear team`,
});

/** Sent when someone asks to reset a password. The link works once, for one hour. */
export const resetPasswordEmail = (name: string, link: string) => ({
  subject: "Reset your Nuclear password",
  text: `Hello ${name},\n\nWe received a request to reset your Nuclear password. Open this link within one hour to choose a new one:\n${link}\n\nFor your security, resetting signs you out everywhere. If you did not ask for this, ignore this email and your password stays as it is.\n\nThe Nuclear team`,
});

/** Sent after a password was changed through a reset link, in case it was not the owner. */
export const passwordChangedEmail = (name: string) => ({
  subject: "Your Nuclear password was changed",
  text: `Hello ${name},\n\nYour Nuclear password was just changed with a reset link, and every device was signed out. If this was you, no action is needed. If it was not, reply to this email right away.\n\nThe Nuclear team`,
});
