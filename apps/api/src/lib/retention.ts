import type { Sql } from "../db";

/**
 * The nightly purge: finished sessions, so these tables stop growing without bound.
 * Each table is deleted in small batches (a night's work is capped), oldest first, so one run never holds a long lock.
 *
 *   devices           revoked, expired, or never redeemed (a magic link not opened) more than 30 days / a day ago
 *   admin_sessions    expired or revoked more than 30 days ago
 *   transactions      declined ones older than 90 days: the only permitted delete (the immutability trigger allows exactly this). Each night takes the
 *                     week that just passed 90 days, so the read is a short range on the created_at index; completed transactions are never touched
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
  return { devices, admin_sessions: adminSessions, declined_transactions: declined };
}
