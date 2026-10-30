import type { Sql } from "../db";

/**
 * The nightly purge: finished sessions, so these tables stop growing without bound.
 * Each table is deleted in small batches (a night's work is capped), oldest first, so one run never holds a long lock.
 *
 *   devices           revoked, expired, or never redeemed (a magic link not opened) more than 30 days / a day ago
 *   admin_sessions    expired or revoked more than 30 days ago
 *   transactions      declined ones older than 90 days: the only permitted delete (the immutability trigger allows exactly this). Each night takes the
 *                     week that just passed 90 days, so the read is a short range on the created_at index; completed transactions are never touched
 *   checkouts         canceled ones older than 97 days (the failed one-step attempts every payment now leaves behind; the declined transaction that
 *                     pointed at one is gone by then) and open ones that expired more than 97 days ago, when no transaction references them
 *
 * Audit logs are not purged (decided 2026-10-22: leave them for now; note GET /v1/account reads a declined business's reason from them).
 * Deleting a device only drops the session record; nothing about money is touched.
 */
const BATCH = 5_000;
const MAX_BATCHES = 20;

async function batched(run: () => Promise<number>): Promise<number> {
  let total = 0;
  for (let i = 0; i < MAX_BATCHES; i++) {
    const n = await run();
    total += n;
    if (n < BATCH) break;
  }
  return total;
}

export async function purge(sql: Sql) {
  const devices =
    (await batched(async () => (await sql`delete from devices where id in (select id from devices where revoked_at < now() - interval '30 days' limit ${BATCH}) returning id`).length)) +
    (await batched(async () => (await sql`delete from devices where id in (select id from devices where session_expires_at < now() - interval '30 days' limit ${BATCH}) returning id`).length)) +
    (await batched(async () => (await sql`delete from devices where id in (select id from devices where redeemed_at is null and created_at < now() - interval '1 day' limit ${BATCH}) returning id`).length));
  const adminSessions =
    (await batched(async () => (await sql`delete from admin_sessions where id in (select id from admin_sessions where expires_at < now() - interval '30 days' limit ${BATCH}) returning id`).length)) +
    (await batched(async () => (await sql`delete from admin_sessions where id in (select id from admin_sessions where revoked_at < now() - interval '30 days' limit ${BATCH}) returning id`).length));
  const declined = await batched(async () => (await sql`
    delete from transactions where id in (
      select id from transactions
       where status = 'declined' and created_at >= now() - interval '97 days' and created_at < now() - interval '90 days' limit ${BATCH}) returning id`).length);
  const dead = await batched(async () => (await sql`
    delete from checkouts where id in (
      select c.id from checkouts c
       where ((c.status = 'canceled' and c.created_at < now() - interval '97 days') or (c.status = 'open' and c.expires_at is not null and c.expires_at < now() - interval '97 days'))
         and not exists (select 1 from transactions t where t.checkout_id = c.id) limit ${BATCH}) returning id`).length);
  return { devices, admin_sessions: adminSessions, declined_transactions: declined, dead_checkouts: dead };
}
