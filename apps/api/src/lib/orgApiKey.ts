import type { MiddlewareHandler } from "hono";
import type { Sql } from "../db";
import type { AppContext } from "../env";
import { ORG_KEY_PREFIX, hashToken, newOrgKey } from "../crypto";
import { RULES, hit, rateLimited } from "./throttle";

export type KeyStatus = { hint: string; name: string; created_at: Date; last_used_at: Date | null } | null;

/** The organization's live key (never the key itself): one per organization, kept on its business row. */
export async function keyStatus(sql: Sql, accountId: string): Promise<KeyStatus> {
  const [k] = await sql<{ api_key_hint: string; api_key_created_at: Date; api_key_last_used_at: Date | null }[]>`
    select api_key_hint, api_key_created_at, api_key_last_used_at from businesses where account_id = ${accountId} and api_key_hash is not null`;
  return k ? { hint: k.api_key_hint, name: "Default", created_at: k.api_key_created_at, last_used_at: k.api_key_last_used_at } : null;
}

/** Generates a new key; the old one stops working at once (it is replaced on the row). The key is returned here and never again. */
export async function rotateKey(sql: Sql, accountId: string): Promise<{ key: string; hint: string; created_at: Date }> {
  const k = newOrgKey();
  const [row] = await sql<{ created_at: Date }[]>`
    insert into businesses (account_id, account_type, api_key_hash, api_key_hint, api_key_created_at, api_key_last_used_at)
    values (${accountId}, 'O', ${k.hash}, ${k.hint}, now(), null)
    on conflict (account_id) do update set api_key_hash = excluded.api_key_hash, api_key_hint = excluded.api_key_hint, api_key_created_at = now(), api_key_last_used_at = null
    returning api_key_created_at as created_at`;
  return { key: k.key, hint: k.hint, created_at: row!.created_at };
}

export async function revokeKey(sql: Sql, accountId: string): Promise<boolean> {
  const r = await sql`update businesses set api_key_hash = null, api_key_hint = null, api_key_created_at = null, api_key_last_used_at = null where account_id = ${accountId} and api_key_hash is not null returning account_id`;
  return r.length > 0;
}

/**
 * Bearer auth for the Benefits API: `Authorization: Bearer nk_org_...`. The key must be live and belong to an active organization
 * (account type O). Every request is counted against the key's rate limit; its last use is stamped at most once a minute (one statement either way).
 */
export const requireOrgKey: MiddlewareHandler<AppContext> = async (c, next) => {
  const h = c.req.header("authorization") ?? "";
  const token = h.startsWith("Bearer ") ? h.slice(7).trim() : "";
  if (!token.startsWith(ORG_KEY_PREFIX)) return c.json({ error: "unauthorized" }, 401);
  const sql = c.get("sql");
  const [k] = await sql<{ account_id: string }[]>`
    with k as (
      select b.account_id from businesses b
       where b.api_key_hash = ${hashToken(token)}
         and exists (select 1 from accounts a where a.id = b.account_id and a.type = 'O' and a.status = 'active')),
    u as (
      update businesses set api_key_last_used_at = now()
       where account_id in (select account_id from k) and (api_key_last_used_at is null or api_key_last_used_at < now() - interval '1 minute'))
    select account_id from k`;
  if (!k) return c.json({ error: "unauthorized" }, 401);
  const rl = await hit(c.get("limiter"), `orgapi:${k.account_id}`, RULES.orgApi);
  if (!rl.ok) return rateLimited(c, rl.retryAfter);
  c.set("orgKey", { accountId: k.account_id, keyId: k.account_id });
  await next();
};
