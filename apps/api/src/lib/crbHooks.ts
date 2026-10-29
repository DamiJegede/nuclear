import type { Sql } from "../db";
import type { Env } from "../env";
import { log } from "./audit";
import { crbClient } from "./crb";
import { crbProvider } from "./crbAch";
import { confirmItems, returnItem } from "./settlement";

/**
 * Cross River's webhooks (docs/CROSS-RIVER.md): a push to our route with the header `cos-signature: t:<timestamp>, v1:<signature>`, the signature being the
 * base64 HMAC-SHA256 of `<timestamp>.<raw body>` with the webhook secret. Events are delivered at least once and in no order, so everything here
 * is safe to repeat: a settlement row finishes once.
 */
const TOLERANCE_MS = 20 * 60 * 1000;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

const b64 = (b: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(b)));
function b64decode(s: string): Uint8Array | null {
  try { return Uint8Array.from(atob(s), (c) => c.charCodeAt(0)); } catch { return null; }
}
const same = (a: string, b: string) => {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
};

/** True when the signature is valid and fresh. The webhook secret is base64: the HMAC key is its decoded bytes (confirmed against the bank's own ping, 2026-10-28). */
export async function verifyCrbSignature(secret: string, header: string | undefined, body: string, now = Date.now()): Promise<boolean> {
  if (!header) return false;
  const parts = Object.fromEntries(header.split(",").map((p) => { const i = p.indexOf(":"); return [p.slice(0, i).trim(), p.slice(i + 1).trim()]; }));
  const t = parts.t, sig = parts.v1;
  if (!t || !sig) return false;
  const n = Number(t);
  const ms = Number.isFinite(n) ? (n < 1e11 ? n * 1000 : n) : Date.parse(t);
  if (!Number.isFinite(ms) || Math.abs(now - ms) > TOLERANCE_MS) return false;
  const raw = b64decode(secret);
  if (!raw || raw.length === 0) return false;
  const key = await crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return same(b64(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${body}`))), sig);
}

export type CrbEvent = { id?: string; eventName?: string; isPing?: boolean; resources?: unknown };

/**
 * Applies one event: every payment it points at that belongs to a settlement row is asked about again (through the same status read the daily catch-up
 * uses), and a return record is traced to the payment it returns. Anything else is ignored. Never throws for an unknown shape: the nightly
 * poll finds whatever this misses.
 */
export async function handleCrbEvent(env: Env, sql: Sql, ev: CrbEvent): Promise<{ matched: number }> {
  if (ev.isPing) return { matched: 0 };
  const crb = crbClient(env), provider = crbProvider(env, sql, crb);
  if (!crb || !provider) return { matched: 0 };
  const ids = [...new Set(JSON.stringify(ev.resources ?? "").match(UUID) ?? [])];
  let matched = 0;
  for (const id of ids) {
    const rows = await sql<{ id: string }[]>`select id from settlements where provider_reference in (${"ach:" + id}, ${"rtp:" + id}) and status = 'submitted'`;
    if (rows.length > 0) {
      await confirmItems(sql, provider, rows.map((r) => r.id));
      matched += rows.length;
      continue;
    }
    if (!/return/i.test(ev.eventName ?? "")) continue;
    // A return is its own payment record: it names the payment it returns.
    const ret = await crb.call<{ original?: { paymentId?: string }; returnCode?: string; reasonCode?: string; postingCode?: string }>("GET", `/ach/v1/payments/${id}`).catch(() => null);
    const orig = ret?.original?.paymentId;
    if (!orig) continue;
    const [row] = await sql<{ id: string }[]>`select id from settlements where provider_reference = ${"ach:" + orig} and status in ('submitted', 'settled')`;
    if (!row) continue;
    const r = await returnItem(sql, row.id, ret?.returnCode ?? ret?.reasonCode ?? ret?.postingCode ?? "returned");
    if (r !== "ignored") matched += 1;
  }
  if (matched === 0 && ids.length > 0) await log(sql, { actor: { type: "system", label: "bank" }, action: "bank.webhook_unmatched", details: { event: ev.eventName ?? null, id: ev.id ?? null } });
  return { matched };
}
