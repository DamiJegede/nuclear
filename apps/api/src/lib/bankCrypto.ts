import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Bank account numbers are stored encrypted (AES-256-GCM, key `BANK_ENCRYPTION_KEY`), so a copy of the database alone never contains a
 * usable number. (Routing numbers are public and stored as plain digits.) The stored form is "v1.<base64url(iv | ciphertext | tag)>" (the prefix lets the key be rotated).
 * Each value is bound to its account and field as GCM additional data, so an encrypted number copied onto another account or into the
 * other column does not decrypt. Only the future settlement job (and the audited `revealBank`) ever decrypt; nothing in a portal does.
 */
const key = (b64: string): Buffer => {
  const k = Buffer.from(b64, "base64");
  if (k.length !== 32) throw new Error("BANK_ENCRYPTION_KEY must be 32 bytes, base64 encoded");
  return k;
};
const aad = (accountId: string, field: "routing" | "account") => Buffer.from(`bank:${accountId}:${field}`, "utf8");

export function encryptBankField(keyB64: string, accountId: string, field: "routing" | "account", plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(keyB64), iv);
  c.setAAD(aad(accountId, field));
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return "v1." + Buffer.concat([iv, ct, c.getAuthTag()]).toString("base64url");
}

export function decryptBankField(keyB64: string, accountId: string, field: "routing" | "account", blob: string): string {
  if (!blob.startsWith("v1.")) throw new Error("unknown bank number version");
  const raw = Buffer.from(blob.slice(3), "base64url");
  const d = createDecipheriv("aes-256-gcm", key(keyB64), raw.subarray(0, 12));
  d.setAAD(aad(accountId, field));
  d.setAuthTag(raw.subarray(raw.length - 16));
  return Buffer.concat([d.update(raw.subarray(12, raw.length - 16)), d.final()]).toString("utf8");
}
