import { ROOT, applyMigration, migrate, psql, resetSchema } from "./db.ts";
import { randomBytes } from "node:crypto";
import { base32Decode, base32Encode, decryptSecret, encryptSecret, hashRecovery, hotp, looksLikeRecovery, newRecoveryCodes, newSecret, otpauthUri, totp, verifyTotp } from "../src/lib/totp.ts";
let pass = 0, fail = 0;
const eq = (l: string, g: unknown, w: unknown) => { const ok = JSON.stringify(g) === JSON.stringify(w); ok ? pass++ : fail++; console.log(ok ? "ok  " : "FAIL", l, ok ? "" : `got ${JSON.stringify(g)} want ${JSON.stringify(w)}`); };

// RFC 6238 Appendix B (SHA-1), shared secret "12345678901234567890"; the RFC lists 8 digits, we use the last 6
const SECRET = base32Encode(Buffer.from("12345678901234567890"));
const vectors: [number, string][] = [[59, "287082"], [1111111109, "081804"], [1111111111, "050471"], [1234567890, "005924"], [2000000000, "279037"], [20000000000, "353130"]];
for (const [t, code] of vectors) eq(`RFC 6238 vector at T=${t}`, totp(SECRET, t * 1000), code);
// RFC 4226 Appendix D
const rfc4226 = ["755224", "287082", "359152", "969429", "338314", "254676", "287922", "162583", "399871", "520489"];
eq("RFC 4226 HOTP vectors 0-9", rfc4226.map((_, i) => hotp(Buffer.from("12345678901234567890"), i)), rfc4226);

// base32
eq("base32 known value", base32Encode(Buffer.from("foobar")), "MZXW6YTBOI");
eq("base32 round trip over random lengths", Array.from({ length: 50 }, (_, i) => { const b = randomBytes(i + 1); return base32Decode(base32Encode(b)).equals(b); }).every(Boolean), true);
eq("base32 decode ignores spaces, dashes, case and padding", base32Decode("mzxw 6ytb-oi======").toString(), "foobar");
eq("base32 rejects garbage", (() => { try { base32Decode("1!"); return "accepted"; } catch { return "rejected"; } })(), "rejected");
const s = newSecret();
eq("new secrets are 160-bit base32", [s.length, /^[A-Z2-7]{32}$/.test(s), newSecret() !== s], [32, true, true]);

// verification window and replay
const now = 1_700_000_000_000, step = Math.floor(now / 30000);
const code = (d: number) => hotp(base32Decode(SECRET), step + d);
eq("current code accepted, step returned", verifyTotp(SECRET, code(0), now, null), { ok: true, step });
eq("one step early and late accepted (clock drift)", [verifyTotp(SECRET, code(-1), now, null).ok, verifyTotp(SECRET, code(1), now, null).ok], [true, true]);
eq("two steps away refused", [verifyTotp(SECRET, code(-2), now, null).ok, verifyTotp(SECRET, code(2), now, null).ok], [false, false]);
eq("a used step is refused (replay), also anything older", [verifyTotp(SECRET, code(0), now, step).ok, verifyTotp(SECRET, code(-1), now, step).ok], [false, false]);
eq("the next step is still accepted after using this one", verifyTotp(SECRET, code(1), now, step), { ok: true, step: step + 1 });
eq("spaces in the code are fine; wrong shapes are not", [verifyTotp(SECRET, code(0).slice(0, 3) + " " + code(0).slice(3), now, null).ok, verifyTotp(SECRET, "12345", now, null).ok, verifyTotp(SECRET, "abcdef", now, null).ok, verifyTotp(SECRET, "1234567", now, null).ok], [true, false, false, false]);
eq("a wrong code is refused", verifyTotp(SECRET, code(0) === "000000" ? "000001" : "000000", now, null).ok, false);

// provisioning URI
const uri = otpauthUri("Nuclear Admin", "jane.doe", "ABCDEFGH");
eq("otpauth URI is what authenticator apps read", uri, "otpauth://totp/Nuclear%20Admin:jane.doe?secret=ABCDEFGH&issuer=Nuclear%20Admin&algorithm=SHA1&digits=6&period=30");

// recovery codes
const rc = newRecoveryCodes();
eq("ten distinct readable recovery codes", [rc.length, new Set(rc).size, rc.every((c) => /^[A-HJKMNP-TV-Z2-9]{5}-[A-HJKMNP-TV-Z2-9]{5}$/.test(c))], [10, 10, true]);
eq("recovery matching ignores case, dashes and spaces", [hashRecovery(rc[0]!) === hashRecovery(rc[0]!.toLowerCase().replace("-", " ")), hashRecovery(rc[0]!) === hashRecovery(rc[1]!)], [true, false]);
eq("recovery codes are told apart from 6-digit codes", [looksLikeRecovery(rc[0]!), looksLikeRecovery("123456")], [true, false]);

// encryption at rest
const K = randomBytes(32).toString("base64");
const blob = encryptSecret(K, SECRET);
eq("encrypted secret decrypts and hides the plaintext", [decryptSecret(K, blob), blob.startsWith("v1."), blob.includes(SECRET)], [SECRET, true, false]);
eq("same plaintext encrypts differently each time", encryptSecret(K, SECRET) !== encryptSecret(K, SECRET), true);
eq("a different key cannot decrypt", (() => { try { decryptSecret(randomBytes(32).toString("base64"), blob); return "decrypted"; } catch { return "refused"; } })(), "refused");
eq("tampering is detected", (() => { try { const b = Buffer.from(blob.slice(3), "base64url"); b[20] ^= 1; decryptSecret(K, "v1." + b.toString("base64url")); return "decrypted"; } catch { return "refused"; } })(), "refused");
eq("bad keys are refused", (() => { try { encryptSecret("c2hvcnQ=", "x"); return "accepted"; } catch { return "refused"; } })(), "refused");
eq("unknown version is refused", (() => { try { decryptSecret(K, "v9.abc"); return "accepted"; } catch { return "refused"; } })(), "refused");
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
