/**
 * Orb secure channel, API side (docs/ORB.md §8a; the Rust mirror is apps/orb-firmware/src/secure.rs, the Swift one OrbSecure.swift; all
 * three are tested against docs/orb-protocol-vectors.md). One fleet key `ORB_KEY_V1` is built into every Orb's firmware and held here;
 * Orbs are not provisioned individually. Authorizing a bind means proving to one Orb (its uid), for one fresh connection nonce, that the
 * API approves one binding id.
 */
const enc = new TextEncoder();
const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
export const fromHex = (s: string) => Uint8Array.from(s.match(/../g) ?? [], (h) => parseInt(h, 16));

async function prf(key: Uint8Array, label: string, ...parts: Uint8Array[]): Promise<Uint8Array> {
  const len = label.length + 1 + parts.reduce((n, p) => n + p.length, 0);
  const msg = new Uint8Array(len);
  msg.set(enc.encode(label), 0);
  let at = label.length + 1;                      // the 0x00 separator is already zero
  for (const p of parts) { msg.set(p, at); at += p.length; }
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, msg));
}

export const ORB_UID = /^[0-9A-F]{12}$/;
export const ORB_NONCE = /^[0-9a-f]{32}$/;

export function orbKey(secret: string | undefined): Uint8Array | null {
  return secret && /^[0-9a-fA-F]{64}$/.test(secret) ? fromHex(secret.toLowerCase()) : null;
}

/** A fresh binding id plus everything the terminal needs: the Orb-verifiable `proof` and the per-binding key. */
export async function authorizeBind(kOrb: Uint8Array, uidHex: string, nonceOHex: string, bindingId: Uint8Array = crypto.getRandomValues(new Uint8Array(16))) {
  const uid = fromHex(uidHex.toLowerCase());
  const proof = await prf(kOrb, "bind-auth-v1", uid, bindingId, fromHex(nonceOHex));
  const kBind = await prf(kOrb, "bind-key-v1", uid, bindingId);
  return { binding_id: hex(bindingId), proof: hex(proof), bind_key: hex(kBind) };
}
