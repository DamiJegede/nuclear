import { randomBytes } from "node:crypto";
import type { Sql } from "../db";
import type { Env } from "../env";
import { hashToken } from "../crypto";
import { passwordChangedEmail, resetPasswordEmail, sendMail, verifyEmail, type MailResult } from "./email";

export type TokenKind = "verify_email" | "reset_password";
const TTL_HOURS: Record<TokenKind, number> = { verify_email: 24, reset_password: 1 };
const PATH: Record<TokenKind, string> = { verify_email: "verify-email", reset_password: "reset-password" };

/** The address an emailed link opens: the merchant or organization portal for those accounts, the customer app otherwise. */
export function accountLink(env: Env, type: string, kind: TokenKind, token: string): string {
  const base = (type === "B" ? env.MERCHANT_PORTAL_URL : type === "O" ? env.ORG_PORTAL_URL : undefined) ?? env.APP_URL ?? "https://app.nuclear.us";
  return `${base.replace(/\/+$/, "")}/${PATH[kind]}?token=${encodeURIComponent(token)}`;
}

type Who = { id: string; type: string; name: string; email: string };

/**
 * Issues a fresh link (older unused ones of that kind stop working) and emails it. The database work is awaited; the email itself goes
 * through `defer` when given (the request's `waitUntil`), so the answer does not wait for the mail service and the database client can
 * close. Returns how the email went, or "queued" when deferred. Never throws on a mail problem.
 */
export async function issueAccountToken(env: Env, sql: Sql, a: Who, kind: TokenKind, defer?: (p: Promise<unknown>) => void): Promise<MailResult | "queued"> {
  const token = randomBytes(32).toString("base64url");
  await sql.begin(async (tx) => {
    await tx`update account_tokens set used_at = now() where account_id = ${a.id} and kind = ${kind} and used_at is null`;
    await tx`
      insert into account_tokens (account_id, kind, email, token_hash, expires_at)
      values (${a.id}, ${kind}, ${a.email}, ${hashToken(token)}, now() + make_interval(hours => ${TTL_HOURS[kind]}))`;
  });
  const link = accountLink(env, a.type, kind, token);
  const send = sendMail(env, { to: a.email, ...(kind === "verify_email" ? verifyEmail(a.name, link) : resetPasswordEmail(a.name, link)) });
  if (!defer) return send;
  defer(send.catch((e) => console.error("account mail", e)));
  return "queued";
}

/** Tells the owner their password changed (after a reset). */
export const sendPasswordChanged = (env: Env, a: { name: string; email: string }) => sendMail(env, { to: a.email, ...passwordChangedEmail(a.name) });

/** Uses a link once. Returns the account it was issued to, or null when it is unknown, used or expired. */
export async function consumeAccountToken(tx: Sql, token: string, kind: TokenKind) {
  const [row] = await tx<{ id: string; account_id: string; email: string }[]>`
    update account_tokens set used_at = now()
     where token_hash = ${hashToken(token)} and kind = ${kind} and used_at is null and expires_at > now()
     returning id, account_id, email`;
  return row ?? null;
}
