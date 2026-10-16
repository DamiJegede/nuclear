import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

// RFC 4226 / 6238 time-based one-time passwords (HMAC-SHA1, 6 digits, 30 s), as every authenticator
// app implements them, plus the encryption used to store the shared secret at rest.

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export const STEP_SECONDS = 30;
export const DIGITS = 6;

export function base32Encode(buf: Buffer): string {
  let bits = 0, value = 0, out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/[\s=-]/g, "");
  let bits = 0, value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new Error("invalid base32");
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

/** A new random 160-bit shared secret, base32 encoded (what the QR code and manual entry carry). */
export const newSecret = (): string => base32Encode(randomBytes(20));

export function hotp(secret: Buffer, counter: number): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = createHmac("sha1", secret).update(msg).digest();
  const o = h[h.length - 1]! & 15;
  const bin = ((h[o]! & 0x7f) << 24) | (h[o + 1]! << 16) | (h[o + 2]! << 8) | h[o + 3]!;
  return String(bin % 10 ** DIGITS).padStart(DIGITS, "0");
}

export const stepAt = (nowMs: number): number => Math.floor(nowMs / 1000 / STEP_SECONDS);
export const totp = (secretB32: string, nowMs: number): string => hotp(base32Decode(secretB32), stepAt(nowMs));

const safeEq = (a: string, b: string) => {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/**
 * Check a 6-digit code against the current step and one step either side (clock drift). A step at or
 * before lastStep is refused, so a code (or an older one) can never be used twice. Returns the
 * matching step, which the caller must store atomically.
 */
export function verifyTotp(
  secretB32: string,
  code: string,
  nowMs: number,
  lastStep: number | null,
  window = 1,
): { ok: true; step: number } | { ok: false } {
  const c = code.replace(/\s/g, "");
  if (!/^\d{6}$/.test(c)) return { ok: false };
  const secret = base32Decode(secretB32);
  const now = stepAt(nowMs);
  let hit: number | null = null;
  for (let d = -window; d <= window; d++) {
    const step = now + d;
    // Evaluate every candidate (no early exit) so timing does not reveal which step matched.
    if (safeEq(hotp(secret, step), c) && (lastStep === null || step > lastStep)) hit = hit === null ? step : Math.max(hit, step);
  }
  return hit === null ? { ok: false } : { ok: true, step: hit };
}

export function otpauthUri(issuer: string, accessId: string, secretB32: string): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(accessId)}`;
  return `otpauth://totp/${label}?secret=${secretB32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${DIGITS}&period=${STEP_SECONDS}`;
}

// ---- Recovery codes ----------------------------------------------------------------------------

const RC = "ABCDEFGHJKMNPQRSTVWXYZ23456789"; // no 0/O/1/I/L/U: easy to read aloud and copy
export const RECOVERY_COUNT = 10;

export function newRecoveryCodes(): string[] {
  return Array.from({ length: RECOVERY_COUNT }, () => {
    const bytes = randomBytes(10);
    const chars = Array.from(bytes, (b) => RC[b % RC.length]).join("");
    return `${chars.slice(0, 5)}-${chars.slice(5)}`;
  });
}

export const normalizeRecovery = (s: string): string => s.toUpperCase().replace(/[^A-Z0-9]/g, "");
export const hashRecovery = (s: string): string => createHash("sha256").update(normalizeRecovery(s)).digest("hex");
export const looksLikeRecovery = (s: string): boolean => normalizeRecovery(s).length === 10;

// ---- Secrets at rest ---------------------------------------------------------------------------
// AES-256-GCM. The stored form is "v1.<base64url(iv | ciphertext | tag)>"; the version prefix lets the
// key be rotated later.

function key(b64: string): Buffer {
  const k = Buffer.from(b64, "base64");
  if (k.length !== 32) throw new Error("MFA_ENCRYPTION_KEY must be 32 bytes, base64 encoded");
  return k;
}

export function encryptSecret(keyB64: string, plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(keyB64), iv);
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return "v1." + Buffer.concat([iv, ct, c.getAuthTag()]).toString("base64url");
}

export function decryptSecret(keyB64: string, blob: string): string {
  if (!blob.startsWith("v1.")) throw new Error("unknown secret version");
  const raw = Buffer.from(blob.slice(3), "base64url");
  const d = createDecipheriv("aes-256-gcm", key(keyB64), raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(raw.length - 16));
  return Buffer.concat([d.update(raw.subarray(12, raw.length - 16)), d.final()]).toString("utf8");
}
