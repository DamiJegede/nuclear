import type { Env } from "../env";
import { passwordFingerprint, signAccountLink, type AccountLinkKind } from "../crypto";
import { passwordChangedEmail, resetPasswordEmail, sendMail, verifyEmail, type MailResult } from "./email";

export type TokenKind = AccountLinkKind;
const TTL_SECONDS: Record<TokenKind, number> = { verify_email: 24 * 3600, reset_password: 3600 };
const PATH: Record<TokenKind, string> = { verify_email: "verify-email", reset_password: "reset-password" };

/** The address an emailed link opens: the merchant or organization portal for those accounts, the customer app otherwise. */
export function accountLink(env: Env, type: string, kind: TokenKind, token: string): string {
  const base = (type === "B" ? env.MERCHANT_PORTAL_URL : type === "O" ? env.ORG_PORTAL_URL : undefined) ?? env.APP_URL ?? "https://app.nuclear.us";
  return `${base.replace(/\/+$/, "")}/${PATH[kind]}?token=${encodeURIComponent(token)}`;
}

type Who = { id: string; type: string; name: string; email: string; password_hash?: string | null };

/**
 * Signs a link and emails it. Links are signed and expiring (24 hours to verify, one hour to reset), with no table: a reset link carries a fingerprint
 * of the password hash, so it works once. The email goes through `defer` when given (the request's `waitUntil`), so the answer does not wait for
 * the mail service. Returns how the email went, or "queued" when deferred. Never throws on a mail problem.
 */
export async function issueAccountToken(env: Env, a: Who, kind: TokenKind, defer?: (p: Promise<unknown>) => void): Promise<MailResult | "queued"> {
  const token = await signAccountLink(env.JWT_SECRET, { accountId: a.id, kind, email: a.email, ...(kind === "reset_password" ? { pwf: passwordFingerprint(a.password_hash ?? null) } : {}) }, TTL_SECONDS[kind]);
  const link = accountLink(env, a.type, kind, token);
  const send = sendMail(env, { to: a.email, ...(kind === "verify_email" ? verifyEmail(a.name, link) : resetPasswordEmail(a.name, link)) });
  if (!defer) return send;
  defer(send.catch((e) => console.error("account mail", e)));
  return "queued";
}

/** Tells the owner their password changed (after a reset). */
export const sendPasswordChanged = (env: Env, a: { name: string; email: string }) => sendMail(env, { to: a.email, ...passwordChangedEmail(a.name) });
