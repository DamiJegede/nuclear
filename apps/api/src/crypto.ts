import { randomBytes, scrypt, timingSafeEqual, createHash } from "node:crypto";
import { sign, verify } from "hono/jwt";

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 } as const;

function scryptAsync(password: string, salt: Buffer, keylen: number, opts: object): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(password, salt, keylen, opts, (err, key) => (err ? reject(err) : resolve(key))),
  );
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, SCRYPT.keylen, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64url")}$${key.toString("base64url")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [alg, n, r, p, salt, hash] = stored.split("$");
  if (alg !== "scrypt" || !n || !r || !p || !salt || !hash) return false;
  const expected = Buffer.from(hash, "base64url");
  const key = await scryptAsync(password, Buffer.from(salt, "base64url"), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
  });
  return key.length === expected.length && timingSafeEqual(key, expected);
}

/** Opaque 256-bit session token; only its SHA-256 is stored. */
export function newSessionToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: hashToken(token) };
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

// Wallet magic-link JWTs (WALLET-ACCESS-POLICY.md): HS256 pinned, dedicated iss/aud, 300 s lifetime.
const LINK_ISS = "nuclear";
const LINK_AUD = "nuclear:wallet-link";
const LINK_TTL_SECONDS = 300;

export type LinkClaims = { sub: string; device_id: string; jti: string; account_id: string };

export async function signWalletLink(
  secret: string,
  c: { walletId: string; deviceId: string; accountId: string },
): Promise<string> {
  const iat = Math.floor(Date.now() / 1000);
  return sign(
    {
      iss: LINK_ISS,
      aud: LINK_AUD,
      sub: c.walletId,
      device_id: c.deviceId,
      jti: c.deviceId,
      account_id: c.accountId,
      iat,
      exp: iat + LINK_TTL_SECONDS,
    },
    secret,
    "HS256",
  );
}

export async function verifyWalletLink(secret: string, token: string): Promise<LinkClaims | null> {
  try {
    const p = (await verify(token, secret, "HS256")) as Record<string, unknown>;
    if (p.iss !== LINK_ISS || p.aud !== LINK_AUD) return null;
    const { sub, device_id, jti, account_id } = p;
    if (
      typeof sub !== "string" ||
      typeof device_id !== "string" ||
      typeof jti !== "string" ||
      typeof account_id !== "string" ||
      jti !== device_id
    ) {
      return null;
    }
    return { sub, device_id, jti, account_id };
  } catch {
    return null;
  }
}

export const LINK_TTL = LINK_TTL_SECONDS;

// Terminal session JWTs: HS256 pinned, dedicated aud. The JWT carries its own expiry; the SHA-256 of
// the issued token is stored on terminals.session_token_hash so a session can be revoked/replaced.
const TERMINAL_AUD = "nuclear:terminal";
export const TERMINAL_JWT_TTL_SECONDS = 90 * 24 * 60 * 60;

export async function signTerminalJwt(
  secret: string,
  c: { terminalId: string; accountId: string },
): Promise<{ token: string; expiresAt: Date }> {
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + TERMINAL_JWT_TTL_SECONDS;
  const token = await sign(
    { iss: LINK_ISS, aud: TERMINAL_AUD, sub: c.terminalId, account_id: c.accountId, jti: randomBytes(12).toString("base64url"), iat, exp },
    secret,
    "HS256",
  );
  return { token, expiresAt: new Date(exp * 1000) };
}

export async function verifyTerminalJwt(
  secret: string,
  token: string,
): Promise<{ terminalId: string; accountId: string } | null> {
  try {
    const p = (await verify(token, secret, "HS256")) as Record<string, unknown>;
    if (p.iss !== LINK_ISS || p.aud !== TERMINAL_AUD) return null;
    if (typeof p.sub !== "string" || typeof p.account_id !== "string") return null;
    return { terminalId: p.sub, accountId: p.account_id };
  } catch {
    return null;
  }
}

// MFA challenge: proof that the password step succeeded, valid for five minutes and good only for the
// second step. It is not a session: no endpoint accepts it as one.
const MFA_AUD = "nuclear:admin-mfa";
export const MFA_CHALLENGE_SECONDS = 300;

export async function signMfaChallenge(secret: string, adminId: string): Promise<string> {
  const iat = Math.floor(Date.now() / 1000);
  return sign({ iss: LINK_ISS, aud: MFA_AUD, sub: adminId, iat, exp: iat + MFA_CHALLENGE_SECONDS }, secret, "HS256");
}

export async function verifyMfaChallenge(secret: string, token: string): Promise<string | null> {
  try {
    const p = (await verify(token, secret, "HS256")) as Record<string, unknown>;
    if (p.iss !== LINK_ISS || p.aud !== MFA_AUD || typeof p.sub !== "string") return null;
    return p.sub;
  } catch {
    return null;
  }
}
