import { track } from "../lib/tracker";
import { Hono } from "hono";
import type { TransactionSql } from "postgres";
import { z } from "zod";
import type { AppContext, Env } from "../env";
import type { Sql } from "../db";
import { amount, n } from "../lib/money";
import { decryptTagUrl, type TagProof } from "../lib/tagproof";
import { consumeCounter, isFresh, loadTag } from "../lib/tap";
import {
  approvePending, findRefund, refundCore, rejectPending,
  type OriginalRef, type RefundOutcome, type RefundRow,
} from "../lib/refund";
import { requireOwner, requireSession, requireTerminal } from "../session";

const uuid = z.string().uuid();

const credential = z.discriminatedUnion("type", [
  z.object({ type: z.literal("tag"), url: z.string().min(1).max(512) }),
  z.object({ type: z.literal("pass"), id: z.string().max(128).optional(), proof: z.string().max(4096).optional() }),
]);
const approval = z.object({ credential });

function refundJson(r: RefundRow, remaining: bigint | null) {
  return {
    id: r.id,
    status: r.status,
    status_code: r.status_code,
    amount: n(r.amount),
    payment_id: r.related_transaction_id,
    terminal_id: r.terminal_id,
    /** The approving staff/owner account id; null for a direct refund or while pending. */
    approver_account_id: r.approved_by_account_id,
    items: r.items,
    remaining_refundable: remaining === null ? null : n(remaining),
    timestamp: r.timestamp,
    completed_at: r.completed_at,
  };
}

function respond(c: any, out: RefundOutcome) {
  if (out.kind === "error") return c.json({ error: out.error }, out.status);
  if (out.kind === "ok" && !out.replayed && out.row.status === "completed") track(c, { refunds_n: 1, refunds_v: Number(out.row.amount) });   // today's running estimate
  const refund = refundJson(out.row, out.remaining);
  // Rejecting a pending refund is a successful action; report the rejected request itself.
  if (out.kind === "declined" && out.row.status_code === "rejected") return c.json({ refund }, 200);
  if (out.kind === "declined") return c.json({ error: "declined", status_code: out.row.status_code, refund }, 422);
  if (out.kind === "pending") return c.json({ refund }, 202);
  return c.json({ refund }, out.replayed ? 200 : 201);
}

type Tapped =
  | { kind: "staff"; accountId: string }
  | { kind: "not_staff" }
  | { kind: "error"; error: string; status: 404 | 409 | 422 };

/**
 * Resolve a staff tap inside the caller's transaction. The proof is burned (counter consumed) as soon
 * as its counter checks out, even when the tag is unassigned/locked or the person is not authorized.
 */
async function tapStaff(tx: TransactionSql<{ bigint: bigint }>, proof: TagProof, merchantId: string): Promise<Tapped> {
  const tag = await loadTag(tx, proof.uid, true);
  if (!tag) return { kind: "error", error: "tag_not_found", status: 404 };
  if (!isFresh(tag, proof.counter)) return { kind: "error", error: "proof_replayed", status: 409 };
  await consumeCounter(tx, tag.id, proof.counter);

  if (!tag.wallet_id || !tag.account_id || tag.account_status !== "active") {
    return { kind: "error", error: "tag_unassigned", status: 422 };
  }
  if (tag.locked) return { kind: "error", error: "tag_locked", status: 422 };

  const [st] = await tx<{ id: string }[]>`
    select id from staff
     where account_id = ${merchantId} and staff_account_id = ${tag.account_id} and role = 'write'`;
  return st ? { kind: "staff", accountId: tag.account_id } : { kind: "not_staff" };
}

async function proofFrom(env: Env, cred: z.infer<typeof credential>): Promise<TagProof | "pass" | null> {
  if (cred.type === "pass") return "pass";
  return decryptTagUrl(env, cred.url);
}

const rowSelect = (sql: Sql) => sql`
  select r.id, r.status, r.status_code, r.amount, r.terminal_id, r.timestamp, r.completed_at,
         r.approved_by_account_id, r.related_transaction_id,
         p.amount as payment_amount, p.reference, p.idempotency_key as payment_key,
         w.display_name as payer_name,
         (select json_agg(json_build_object('checkout_item_id', e.value ->> 'checkout_item_id',
                                            'name', ci.name,
                                            'quantity', (e.value ->> 'quantity')::int,
                                            'restock', (e.value ->> 'restock')::boolean))
            from jsonb_array_elements(r.items) e
            join checkout_items ci on ci.id = (e.value ->> 'checkout_item_id')::uuid) as items
    from transactions r
    join transactions p on p.id = r.related_transaction_id
    left join wallets w on w.id = p.from_wallet_id`;

type ListRow = {
  id: string; status: string; status_code: string | null; amount: bigint; terminal_id: string | null;
  timestamp: Date; completed_at: Date | null; approved_by_account_id: string | null;
  related_transaction_id: string; payment_amount: bigint; reference: string | null;
  payment_key: string; payer_name: string | null; items: unknown[] | null;
};

const listJson = (r: ListRow) => ({
  id: r.id,
  status: r.status,
  status_code: r.status_code,
  amount: n(r.amount),
  payment_id: r.related_transaction_id,
  payment_amount: n(r.payment_amount),
  attempt: r.payment_key.startsWith("t:") ? r.payment_key.slice(2) : null,
  reference: r.reference,
  payer: r.payer_name ? { display_name: r.payer_name } : null,
  items: r.items,
  requested_on_terminal_id: r.terminal_id,
  approver_account_id: r.approved_by_account_id,
  timestamp: r.timestamp,
  completed_at: r.completed_at,
});

const statusParam = z.enum(["pending", "completed", "failed"]).default("pending");

// ---- Terminal: /v1/terminal/refunds -----------------------------------------------------------

export const terminalRefunds = new Hono<AppContext>();
terminalRefunds.use("*", requireTerminal);

const createBody = z
  .object({
    payment_id: uuid.optional(),
    attempt: z.string().min(1).max(128).optional(),
    mode: z.enum(["full", "partial", "items"]),
    amount: amount.optional(),
    items: z
      .array(z.object({ checkout_item_id: uuid, quantity: z.number().int().min(1).max(1000) }))
      .min(1)
      .max(50)
      .optional(),
    restock: z.boolean().optional(),
    approval: approval.optional(),
  })
  .refine((b) => (b.payment_id === undefined) !== (b.attempt === undefined), { message: "exactly_one_of_payment_id_or_attempt" })
  .refine((b) => (b.mode === "partial") === (b.amount !== undefined), { message: "amount_only_for_partial" })
  .refine((b) => (b.mode === "items") === (b.items !== undefined), { message: "items_only_for_items_mode" })
  .refine((b) => b.restock === undefined || b.mode === "items", { message: "restock_only_for_items_mode" });

type CreateResult = { error: string; status: 404 | 409 | 422 } | { out: RefundOutcome };

// Create a refund. With an authorized tap (or a terminal that allows direct refunds) it executes now.
// With no tap on an approval-required terminal, or a tap by someone who is not write staff, it is
// recorded as a pending request (202) that a write-staff tap or the owner can approve later.
terminalRefunds.post("/", async (c) => {
  const key = c.req.header("idempotency-key")?.trim();
  if (!key || key.length > 128) return c.json({ error: "idempotency_key_required" }, 400);
  const parsed = createBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "invalid_request", issues: parsed.error.flatten() }, 400);
  const b = parsed.data;
  const { accountId, terminalId, allowRefunds } = c.get("terminal");
  const sql = c.get("sql");

  const original: OriginalRef = b.payment_id ? { paymentId: b.payment_id } : { attempt: b.attempt! };
  const core = (tx: TransactionSql<{ bigint: bigint }>, disposition: "execute" | "queue", approver: string | null) =>
    refundCore(tx, {
      merchantAccountId: accountId, terminalId, original, mode: b.mode, amount: b.amount ?? null,
      items: b.items?.map((x) => ({ checkoutItemId: x.checkout_item_id, quantity: x.quantity })),
      restock: b.restock, idempotencyKey: key, disposition, approvedByAccountId: approver,
    });

  if (!b.approval) {
    const out = await sql.begin((tx) => core(tx, allowRefunds ? "execute" : "queue", null));
    return respond(c, out as RefundOutcome);
  }

  const proof = await proofFrom(c.env, b.approval.credential);
  if (proof === "pass") return c.json({ error: "pass_verification_unavailable" }, 501);
  if (!proof) return c.json({ error: "invalid_tag" }, 400);

  const result = (await sql.begin(async (tx): Promise<CreateResult> => {
    // Lost-response retry of the same refund: return the recorded result before testing the proof.
    if (await findRefund(tx, accountId, key)) return { out: await core(tx, "queue", null) };

    const tap = await tapStaff(tx, proof, accountId);
    if (tap.kind === "error") return tap;
    if (tap.kind === "not_staff") return { out: await core(tx, "queue", null) };
    return { out: await core(tx, "execute", tap.accountId) };
  })) as CreateResult;

  if ("error" in result) return c.json({ error: result.error }, result.status);
  return respond(c, result.out);
});

// Pending (and other) refunds for this merchant, across its terminals.
terminalRefunds.get("/", async (c) => {
  const status = statusParam.safeParse(c.req.query("status"));
  const limit = z.coerce.number().int().min(1).max(100).default(50).safeParse(c.req.query("limit"));
  if (!status.success || !limit.success) return c.json({ error: "invalid_request" }, 400);
  const sql = c.get("sql");
  const rows = await sql<ListRow[]>`
    ${rowSelect(sql)}
     where r.type = 'refund' and r.from_account_id = ${c.get("terminal").accountId}
       and r.status = ${status.data}
     order by r.timestamp desc, r.id desc limit ${limit.data}`;
  return c.json({ refunds: rows.map(listJson) });
});

const resolveBody = z.object({ approval });

async function resolveWithTap(c: any, action: "approve" | "reject") {
  const id = uuid.safeParse(c.req.param("id"));
  if (!id.success) return c.json({ error: "not_found" }, 404);
  const parsed = resolveBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "invalid_request" }, 400);
  const { accountId } = c.get("terminal");
  const sql: Sql = c.get("sql");

  // Already resolved (lost-response retry): return the recorded outcome. No tap is decoded or needed.
  const [cur] = await sql<{ status: string }[]>`
    select status from transactions
     where id = ${id.data} and type = 'refund' and from_account_id = ${accountId}`;
  if (!cur) return c.json({ error: "refund_not_found" }, 404);
  if (cur.status !== "pending") {
    const out = await sql.begin((tx) =>
      action === "approve" ? approvePending(tx, accountId, id.data, accountId) : rejectPending(tx, accountId, id.data),
    );
    return respond(c, out as RefundOutcome);
  }

  const proof = await proofFrom(c.env, parsed.data.approval.credential);
  if (proof === "pass") return c.json({ error: "pass_verification_unavailable" }, 501);
  if (!proof) return c.json({ error: "invalid_tag" }, 400);

  type R = { error: string; status: 403 | 404 | 409 | 422 } | { out: RefundOutcome };
  const result = (await sql.begin(async (tx): Promise<R> => {
    const tap = await tapStaff(tx, proof, accountId);
    if (tap.kind === "error") return tap;
    if (tap.kind === "not_staff") return { error: "approver_not_authorized", status: 403 };
    const out = action === "approve"
      ? await approvePending(tx, accountId, id.data, tap.accountId)
      : await rejectPending(tx, accountId, id.data);
    return { out };
  })) as R;

  if ("error" in result) return c.json({ error: result.error }, result.status);
  return respond(c, result.out);
}

terminalRefunds.post("/:id/approve", (c) => resolveWithTap(c, "approve"));
terminalRefunds.post("/:id/reject", (c) => resolveWithTap(c, "reject"));

// ---- Merchant owner (portal): /v1/refunds -----------------------------------------------------

export const refunds = new Hono<AppContext>();
refunds.use("*", requireSession, requireOwner, async (c, next) => {
  const [a] = await c.get("sql")<{ type: string }[]>`select type from accounts where id = ${c.get("auth").accountId}`;
  if (a?.type !== "B") return c.json({ error: "business_account_required" }, 403);
  await next();
});

refunds.get("/", async (c) => {
  const status = statusParam.safeParse(c.req.query("status"));
  const limit = z.coerce.number().int().min(1).max(100).default(50).safeParse(c.req.query("limit"));
  if (!status.success || !limit.success) return c.json({ error: "invalid_request" }, 400);
  const sql = c.get("sql");
  const rows = await sql<ListRow[]>`
    ${rowSelect(sql)}
     where r.type = 'refund' and r.from_account_id = ${c.get("auth").accountId}
       and r.status = ${status.data}
     order by r.timestamp desc, r.id desc limit ${limit.data}`;
  return c.json({ refunds: rows.map(listJson) });
});

// The merchant owner approves or rejects a pending refund; the owner's own account is the approver.
for (const action of ["approve", "reject"] as const) {
  refunds.post(`/:id/${action}`, async (c) => {
    const id = uuid.safeParse(c.req.param("id"));
    if (!id.success) return c.json({ error: "not_found" }, 404);
    const { accountId } = c.get("auth");
    const out = await c.get("sql").begin((tx) =>
      action === "approve" ? approvePending(tx, accountId, id.data, accountId) : rejectPending(tx, accountId, id.data),
    );
    return respond(c, out as RefundOutcome);
  });
}
