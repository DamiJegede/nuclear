import type { Env } from "../env";

/**
 * NTAG 424 DNA encrypted PICC data (NXP SDM), as used by neo-band's DecryptTagData.
 *
 * URL:        https://tag.nclr.app/<version>/<cipherHex>
 * Cipher:     one 16-byte block, AES-128-CBC, zero IV, no padding (== AES-ECB for one block)
 * Plaintext:  [0] PICCDataTag  [1..7] UID (7 bytes)  [8..10] SDMReadCtr (3 bytes, little endian)
 *             [11..15] ignored
 *
 * Worker WebCrypto has no unpadded CBC mode, so one block is decrypted by appending a second block
 * that decrypts to valid PKCS#7 padding; the first 16 output bytes are the plaintext.
 */
export type TagProof = {
  version: string;
  /** PICCDataTag byte, hex. 0xC7 = UID mirrored + counter mirrored + 7-byte UID. */
  tag: string;
  /** 7-byte UID, uppercase hex (matches tags.uid). */
  uid: string;
  /** Read counter; compare/consume atomically against tags.counter. */
  counter: number;
};

const ZERO_IV = new Uint8Array(16);
const EXPECTED_TAG = 0xc7;

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bytesToHex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

/** Extract {version, cipherHex} from the last two path segments, ignoring query and fragment. */
export function parseTagUrl(input: string): { version: string; cipherHex: string } | null {
  const path = input.split(/[?#]/)[0]!.replace(/\/+$/, "");
  const parts = path.split("/");
  const cipherHex = parts[parts.length - 1] ?? "";
  const version = (parts[parts.length - 2] ?? "").toLowerCase();
  if (!/^v\d{1,3}$/.test(version)) return null;
  if (!/^[0-9a-fA-F]{32}$/.test(cipherHex)) return null; // exactly one AES block
  return { version, cipherHex: cipherHex.toLowerCase() };
}

async function decryptBlock(keyBytes: Uint8Array, block: Uint8Array): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", keyBytes, "AES-CBC", false, ["encrypt", "decrypt"]);
  // P2 = E(K, 0x10*16 XOR C); then D(C) || (D(P2) XOR C) = plaintext || 0x10*16 (valid padding).
  const x = block.map((b) => b ^ 0x10);
  const enc = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-CBC", iv: ZERO_IV }, key, x));
  const joined = new Uint8Array(32);
  joined.set(block, 0);
  joined.set(enc.subarray(0, 16), 16);
  return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-CBC", iv: ZERO_IV }, key, joined));
}

/**
 * Decrypt a tag URL. Returns null for any malformed, unknown-version or implausible input; never
 * throws. This proves the tag holds the key (the UID must then exist and its counter must advance);
 * it does not by itself authorize a payment.
 */
export async function decryptTagUrl(env: Env, url: string): Promise<TagProof | null> {
  try {
    const parsed = parseTagUrl(url);
    if (!parsed) return null;
    const keyHex = env[`TAG_KEY_V${parsed.version.slice(1)}` as `TAG_KEY_V${number}`];
    if (!keyHex || !/^[0-9a-fA-F]{32}$/.test(keyHex)) return null;

    const p = await decryptBlock(hexToBytes(keyHex), hexToBytes(parsed.cipherHex));
    if (p.length !== 16 || p[0] !== EXPECTED_TAG) return null; // wrong key / garbage

    return {
      version: parsed.version,
      tag: bytesToHex(p.subarray(0, 1)),
      uid: bytesToHex(p.subarray(1, 8)).toUpperCase(),
      counter: p[8]! | (p[9]! << 8) | (p[10]! << 16),
    };
  } catch {
    return null;
  }
}
