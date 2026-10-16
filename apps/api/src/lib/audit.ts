import type { Context } from "hono";
import type { Sql } from "../db";
import type { AppContext } from "../env";
import { clientIp } from "./throttle";

/**
 * The audit trail: one row in `logs` per thing that matters (an admin action, a customer security event).
 * Rows are append-only. Writing a log must never break the action it describes, so failures are reported
 * to the console and swallowed.
 */
export type Actor = { type: "admin" | "operator" | "customer" | "agent" | "system"; id?: string | null; label?: string | null };
export type Target = { type: string; id?: string | null; label?: string | null };
export type LogEntry = { actor: Actor; action: string; target?: Target; details?: Record<string, unknown>; ip?: string | null };

export async function log(sql: Sql, e: LogEntry): Promise<void> {
  try {
    await sql`
      insert into logs (actor_type, actor_id, actor_label, action, target_type, target_id, target_label, details, ip)
      values (${e.actor.type}, ${e.actor.id ?? null}, ${e.actor.label ?? null}, ${e.action},
              ${e.target?.type ?? null}, ${e.target?.id ?? null}, ${e.target?.label ?? null},
              ${JSON.stringify(e.details ?? {})}::text::jsonb, ${e.ip ?? null})`;
  } catch (err) {
    console.error("audit log failed", e.action, err);
  }
}

/** Who is making an admin request: a signed-in admin, or the operator token (scripts). */
export function adminActor(c: Context<AppContext>): Actor {
  const a = c.get("adminAuth");
  return a?.kind === "admin" ? { type: "admin", id: a.adminId, label: a.accessId } : { type: "operator", label: "operator" };
}

/** Log an admin action from a route handler. */
export const adminLog = (c: Context<AppContext>, action: string, target?: Target, details?: Record<string, unknown>) =>
  log(c.get("sql"), { actor: adminActor(c), action, ...(target ? { target } : {}), ...(details ? { details } : {}), ip: clientIp(c) });

/** Log a customer security event. */
export const customerLog = (c: Context<AppContext>, accountId: string | null, email: string | null, action: string, details?: Record<string, unknown>, target?: Target) =>
  log(c.get("sql"), { actor: { type: "customer", id: accountId, label: email }, action, ...(target ? { target } : {}), ...(details ? { details } : {}), ip: clientIp(c) });
