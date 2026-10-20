import type { MiddlewareHandler } from "hono";
import type { Sql } from "../db";
import type { AppContext } from "../env";
import { ORG_KEY_PREFIX, hashToken, newOrgKey } from "../crypto";
import { RULES, hit, rateLimited } from "./throttle";

export type KeyStatus = { hint: string; name: string; created_at: Date; last_used_at: Date | null } | null;

/** The organization's live key (never the key itself). */
export async function keyStatus(sql: Sql, accountId: string): Promise<KeyStatus> {
  const [k] = await sql<{ key_hint: string; name: string; created_at: Date; last_used_at: Date | null }[]>`
    select key_hint, name, created_at, last_used_at from api_keys where account_id = ${accountId} and revoked_at is null`;
  return k ? { hint: k.key_hint, name: k.name, created_at: k.created_at, last_used_at: k.last_used_at } : null;
}

/** Generates a new key and revokes the old one at once, in one transaction. The key is returned here and never again. */
export async function rotateKey(sql: Sql, accountId: string): Promise<{ key: string; hint: string; created_at: Date }> {
  const k = newOrgKey();
  return sql.begin(async (tx) => {
    await tx`update api_keys set revoked_at = now() where account_id = ${accountId} and revoked_at is null`;
    const [row] = await tx<{ created_at: Date }[]>`
      insert into api_keys (account_id, key_hash, key_hint) values (${accountId}, ${k.hash}, ${k.hint}) returning created_at`;
    return { key: k.key, hint: k.hint, created_at: row!.created_at };
  });
}

export async function revokeKey(sql: Sql, accountId: string): Promise<boolean> {
  const r = await sql`update api_keys set revoked_at = now() where account_id = ${accountId} and revoked_at is null returning id`;
  return r.length > 0;
}

/**
 * Bearer auth for the Benefits API: `Authorization: Bearer nk_org_...`. The key must be live and belong to an active organization
 * (account type O). Every request is counted against the key's rate limit and stamps its last use.
 */
export const requireOrgKey: MiddlewareHandler<AppContext> = async (c, next) => {
  const h = c.req.header("authorization") ?? "";
  const token = h.startsWith("Bearer ") ? h.slice(7).trim() : "";
  if (!token.startsWith(ORG_KEY_PREFIX)) return c.json({ error: "unauthorized" }, 401);
  const sql = c.get("sql");
  const [k] = await sql<{ id: string; account_id: string }[]>`
    update api_keys k set last_used_at = now()
     where k.key_hash = ${hashToken(token)} and k.revoked_at is null
       and exists (select 1 from accounts a where a.id = k.account_id and a.type = 'O' and a.status = 'active')
    returning k.id, k.account_id`;
  if (!k) return c.json({ error: "unauthorized" }, 401);
  const rl = await hit(sql, `orgapi:${k.id}`, RULES.orgApi);
  if (!rl.ok) return rateLimited(c, rl.retryAfter);
  c.set("orgKey", { accountId: k.account_id, keyId: k.id });
  await next();
};
