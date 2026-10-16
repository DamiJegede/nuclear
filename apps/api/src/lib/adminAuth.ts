import { createHash, randomInt, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { Env } from "../env";
import { hashToken, newSessionToken, verifyPassword } from "../crypto";
import {
  decryptSecret, encryptSecret, hashRecovery, looksLikeRecovery, newRecoveryCodes, newSecret, otpauthUri, verifyTotp,
} from "./totp";
import type { Sql } from "../db";

export const SESSION_HOURS = 8;
export const MAX_FAILED_ATTEMPTS = 5;
export const LOCK_MINUTES = 15;

/** Access IDs are uppercase: 3-32 characters of A-Z, 0-9, '.', '_' or '-', starting with a letter or digit. */
export const accessIdSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9][A-Z0-9._-]{2,31}$/, "invalid_access_id");

/** Access tokens are 32 characters or more. The server generates them at exactly 32. */
export const ACCESS_TOKEN_LENGTH = 32;
export const accessTokenSchema = z
  .string()
  .min(ACCESS_TOKEN_LENGTH, "access_token_too_short")
  .max(128, "access_token_too_long");

const ID_LETTERS = "ABCDEFGHJKMNPQRSTVWXYZ";
const ID_ALPHABET = ID_LETTERS + "23456789"; // no 0/O/1/I/L: easy to read aloud and copy
export const ACCESS_ID_LENGTH = 12;

/** A random 12-character Access ID, always uppercase, starting with a letter. */
export function generateAccessId(): string {
  let id = ID_LETTERS[randomInt(ID_LETTERS.length)]!;
  for (let i = 1; i < ACCESS_ID_LENGTH; i++) id += ID_ALPHABET[randomInt(ID_ALPHABET.length)];
  return id;
}

const T_UPPER = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const T_LOWER = "abcdefghijkmnopqrstuvwxyz";
const T_DIGIT = "23456789";
const T_SYMBOL = "-_.+=";

/** A random 32-character Access token: mixed case, digits and symbols, no look-alike characters. */
export function generateAccessToken(): string {
  const all = T_UPPER + T_LOWER + T_DIGIT + T_SYMBOL;
  for (;;) {
    let t = "";
    for (let i = 0; i < ACCESS_TOKEN_LENGTH; i++) t += all[randomInt(all.length)];
    if ([T_UPPER, T_LOWER, T_DIGIT, T_SYMBOL].every((set) => [...t].some((ch) => set.includes(ch)))) return t;
  }
}

// A fixed hash so an unknown access id costs the same as a wrong access token.
const DUMMY_HASH =
  "scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

const digest = (s: string) => createHash("sha256").update(s).digest();
export const sameSecret = (a: string, b: string) => timingSafeEqual(digest(a), digest(b));

export type Session = {
  token: string;
  expiresAt: Date;
  admin: { id: string; access_id: string; name: string; mfa_enabled: boolean };
};

export type LoginResult = ({ ok: true } & Session) | { ok: "mfa"; adminId: string } | { ok: false };

const lockOnFailure = (sql: Sql, adminId: string) => sql`
  update admins
     set failed_attempts = case when failed_attempts + 1 >= ${MAX_FAILED_ATTEMPTS} then 0 else failed_attempts + 1 end,
         locked_until = case when failed_attempts + 1 >= ${MAX_FAILED_ATTEMPTS}
                             then now() + make_interval(mins => ${LOCK_MINUTES}) else locked_until end
   where id = ${adminId}`;

async function openSession(
  sql: Sql,
  a: { id: string; access_id: string; name: string; mfa: boolean },
): Promise<Session> {
  const { token, hash } = newSessionToken();
  const [s] = await sql<{ expires_at: Date }[]>`
    with ok as (
      update admins set failed_attempts = 0, locked_until = null, last_login_at = now() where id = ${a.id}
    )
    insert into admin_sessions (admin_id, token_hash, expires_at, last_used_at)
    values (${a.id}, ${hash}, now() + make_interval(hours => ${SESSION_HOURS}), now())
    returning expires_at`;
  return {
    token,
    expiresAt: s!.expires_at,
    admin: { id: a.id, access_id: a.access_id, name: a.name, mfa_enabled: a.mfa },
  };
}

/**
 * Step one: check an access id and access token. Every failure is the same answer ("not ok"): unknown id,
 * wrong access token, disabled account and locked account are indistinguishable to the caller. An
 * account with MFA enrolled gets no session here, only a request for the second factor; its failure
 * counter is left alone until the second factor succeeds, so token-then-guess cycles still hit the
 * lock. Repeated failures lock the account for a while.
 */
export async function login(sql: Sql, accessId: string, accessToken: string): Promise<LoginResult> {
  const [a] = await sql<
    { id: string; access_id: string; name: string; access_token_hash: string; status: string; mfa: boolean; locked: boolean }[]
  >`
    select id, access_id, name, access_token_hash, status,
           (mfa_enabled_at is not null) as mfa,
           (locked_until is not null and locked_until > now()) as locked
      from admins where access_id = ${accessId}`;

  const good = await verifyPassword(accessToken, a?.access_token_hash ?? DUMMY_HASH);

  if (!a || a.status !== "active" || a.locked) return { ok: false };
  if (!good) {
    await lockOnFailure(sql, a.id);
    return { ok: false };
  }
  if (a.mfa) return { ok: "mfa", adminId: a.id };
  return { ok: true, ...(await openSession(sql, a)) };
}

export type MfaOutcome = ({ ok: true } & Session) | { ok: false } | { ok: "unavailable" };

/**
 * Step two: a 6-digit authenticator code or one single-use recovery code. A code works once (its
 * time step is recorded atomically), and a wrong code counts toward the same lock as a wrong access token.
 */
export async function completeMfa(sql: Sql, env: Env, adminId: string, code: string): Promise<MfaOutcome> {
  if (!env.MFA_ENCRYPTION_KEY) return { ok: "unavailable" };
  const [a] = await sql<
    { id: string; access_id: string; name: string; status: string; mfa_secret: string | null; mfa_last_step: string | null; mfa: boolean; locked: boolean }[]
  >`
    select id, access_id, name, status, mfa_secret, mfa_last_step,
           (mfa_enabled_at is not null) as mfa,
           (locked_until is not null and locked_until > now()) as locked
      from admins where id = ${adminId}`;
  if (!a || a.status !== "active" || a.locked || !a.mfa || !a.mfa_secret) return { ok: false };

  let accepted = false;
  if (looksLikeRecovery(code)) {
    const h = hashRecovery(code);
    const used = await sql`
      update admins set mfa_recovery = mfa_recovery - ${h}::text
       where id = ${a.id} and mfa_recovery ? ${h}::text returning id`;
    accepted = used.length > 0;
  } else {
    const v = verifyTotp(decryptSecret(env.MFA_ENCRYPTION_KEY, a.mfa_secret), code, Date.now(), a.mfa_last_step === null ? null : Number(a.mfa_last_step));
    if (v.ok) {
      // Atomic: two requests carrying the same code cannot both pass.
      const took = await sql`
        update admins set mfa_last_step = ${v.step}
         where id = ${a.id} and (mfa_last_step is null or mfa_last_step < ${v.step}) returning id`;
      accepted = took.length > 0;
    }
  }
  if (!accepted) {
    await lockOnFailure(sql, a.id);
    return { ok: false };
  }
  return { ok: true, ...(await openSession(sql, { ...a, mfa: true })) };
}

// ---- Enrollment (an admin who is signed in with an access token only) ------------------------------

export const MFA_ISSUER = "Nuclear Admin";

/** Start (or restart) enrollment: a fresh secret, held encrypted and inactive until a code proves it. */
export async function mfaSetup(sql: Sql, env: Env, adminId: string, accessId: string) {
  const [cur] = await sql<{ enabled: boolean }[]>`select (mfa_enabled_at is not null) as enabled from admins where id = ${adminId}`;
  if (!cur) return { error: "not_found" as const };
  if (cur.enabled) return { error: "already_enrolled" as const };
  const secret = newSecret();
  await sql`update admins set mfa_secret = ${encryptSecret(env.MFA_ENCRYPTION_KEY!, secret)} where id = ${adminId} and mfa_enabled_at is null`;
  return { secret, uri: otpauthUri(MFA_ISSUER, accessId, secret) };
}

/** Confirm enrollment with a code from the new authenticator. Returns the recovery codes, once. */
export async function mfaEnable(sql: Sql, env: Env, adminId: string, code: string, keepSessionId: string) {
  const [a] = await sql<{ mfa_secret: string | null; enabled: boolean }[]>`
    select mfa_secret, (mfa_enabled_at is not null) as enabled from admins where id = ${adminId}`;
  if (!a) return { error: "not_found" as const };
  if (a.enabled) return { error: "already_enrolled" as const };
  if (!a.mfa_secret) return { error: "setup_first" as const };
  const v = verifyTotp(decryptSecret(env.MFA_ENCRYPTION_KEY!, a.mfa_secret), code, Date.now(), null);
  if (!v.ok) return { error: "invalid_code" as const };

  const codes = newRecoveryCodes();
  const done = await sql`
    update admins set mfa_enabled_at = now(), mfa_last_step = ${v.step},
                      mfa_recovery = ${JSON.stringify(codes.map(hashRecovery))}::text::jsonb
     where id = ${adminId} and mfa_enabled_at is null returning id`;
  if (done.length === 0) return { error: "already_enrolled" as const };
  await revokeSessions(sql, adminId, keepSessionId);
  return { recoveryCodes: codes };
}

/** Replace the recovery codes (needs a current authenticator code). The old codes stop working. */
export async function mfaNewRecoveryCodes(sql: Sql, env: Env, adminId: string, code: string) {
  const [a] = await sql<{ mfa_secret: string | null; mfa_last_step: string | null; enabled: boolean }[]>`
    select mfa_secret, mfa_last_step, (mfa_enabled_at is not null) as enabled from admins where id = ${adminId}`;
  if (!a || !a.enabled || !a.mfa_secret) return { error: "not_enrolled" as const };
  const v = verifyTotp(decryptSecret(env.MFA_ENCRYPTION_KEY!, a.mfa_secret), code, Date.now(), a.mfa_last_step === null ? null : Number(a.mfa_last_step));
  const took = v.ok
    ? await sql`update admins set mfa_last_step = ${v.step} where id = ${adminId} and (mfa_last_step is null or mfa_last_step < ${v.step}) returning id`
    : [];
  if (took.length === 0) {
    await lockOnFailure(sql, adminId);
    return { error: "invalid_code" as const };
  }
  const codes = newRecoveryCodes();
  await sql`update admins set mfa_recovery = ${JSON.stringify(codes.map(hashRecovery))}::text::jsonb where id = ${adminId}`;
  return { recoveryCodes: codes };
}

export async function findSession(sql: Sql, token: string) {
  const [s] = await sql<
    { session_id: string; admin_id: string; access_id: string; name: string; mfa_enabled: boolean }[]
  >`
    select s.id as session_id, a.id as admin_id, a.access_id, a.name,
           (a.mfa_enabled_at is not null) as mfa_enabled
      from admin_sessions s join admins a on a.id = s.admin_id
     where s.token_hash = ${hashToken(token)} and s.revoked_at is null and s.expires_at > now()
       and a.status = 'active'`;
  if (s) await sql`update admin_sessions set last_used_at = now() where id = ${s.session_id}`;
  return s;
}

export const revokeSessions = (sql: Sql, adminId: string, exceptSessionId?: string) =>
  sql`
    update admin_sessions set revoked_at = now()
     where admin_id = ${adminId} and revoked_at is null
       ${exceptSessionId ? sql`and id <> ${exceptSessionId}` : sql``}`;
