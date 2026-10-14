import { Hono } from "hono";
import { z } from "zod";
import type { AppContext } from "../env";
import { n } from "../lib/money";
import { requireSession } from "../session";

export const activity = new Hono<AppContext>();
activity.use("*", requireSession);

type Row = {
  kind: "transaction" | "funding";
  id: string;
  type: string;
  status: string;
  status_code: string | null;
  amount: bigint;
  from_account_id: string | null;
  from_wallet_id: string | null;
  to_wallet_id: string | null;
  ts: Date;
  ts_key: string;
  counter_wallet_id: string | null;
  counter_name: string | null;
  counter_photo: string | null;
};

const query = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().max(100).optional(),
  wallet_id: z.string().uuid().optional(),
});

// One ordered feed. Completed loads appear once (via their fund transaction); pending, failed and
// canceled loads come from fundings. Owners see the whole account; a delegated session sees only
// its own wallet.
activity.get("/", async (c) => {
  const q = query.safeParse(c.req.query());
  if (!q.success) return c.json({ error: "invalid_request" }, 400);
  const { accountId, walletId } = c.get("auth");
  const sql = c.get("sql");

  const scope = walletId ?? q.data.wallet_id ?? null;
  let cursorTs: string | null = null;
  let cursorId: string | null = null;
  if (q.data.cursor) {
    const [t, id] = q.data.cursor.split("|");
    if (!t || !id || Number.isNaN(Date.parse(t)) || !z.string().uuid().safeParse(id).success) {
      return c.json({ error: "invalid_cursor" }, 400);
    }
    cursorTs = t;
    cursorId = id;
  }
  const limit = q.data.limit + 1;

  // Transactions the account takes part in.
  const txs = sql<Row[]>`
    select 'transaction' as kind, t.id, t.type, t.status, t.status_code, t.amount,
           t.from_account_id, t.from_wallet_id, t.to_wallet_id,
           t."timestamp" as ts,
           to_char(t."timestamp" at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as ts_key,
           cw.id as counter_wallet_id,
           -- Payer sees the merchant on pays and refunds; the merchant sees which member.
           coalesce(cw.display_name,
                    case when (t.type = 'pay' and t.from_account_id = ${accountId})
                           or (t.type = 'refund' and t.to_account_id = ${accountId})
                         then coalesce(mb.display_name, ma.name) end) as counter_name,
           cw.photo as counter_photo
      from transactions t
      left join wallets cw on cw.id = case when t.from_account_id = ${accountId}
                                           then t.to_wallet_id else t.from_wallet_id end
      left join accounts ma on ma.id = case t.type when 'pay' then t.to_account_id
                                                   when 'refund' then t.from_account_id end
      left join businesses mb on mb.account_id = ma.id
     where (t.from_account_id = ${accountId} or t.to_account_id = ${accountId})
       -- A pending refund is the merchant's internal request; the customer sees it once it completes.
       and not (t.type = 'refund' and t.status = 'pending' and t.to_account_id = ${accountId})
       ${scope ? sql`and (t.from_wallet_id = ${scope} or t.to_wallet_id = ${scope})` : sql``}
       ${cursorTs ? sql`and (t."timestamp", t.id) < (${cursorTs}::text::timestamptz, ${cursorId}::uuid)` : sql``}
     order by t."timestamp" desc, t.id desc
     limit ${limit}`;

  // Loads without a fund transaction (pending/failed/canceled): owner view only.
  const fundings = scope
    ? Promise.resolve([] as Row[])
    : sql<Row[]>`
        select 'funding' as kind, f.id, 'fund' as type, f.status, f.failure_code as status_code, f.amount,
               f.account_id as from_account_id, null::uuid as from_wallet_id, null::uuid as to_wallet_id,
               f.created_at as ts,
               to_char(f.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as ts_key,
               null::uuid as counter_wallet_id, null::text as counter_name, null::text as counter_photo
          from fundings f
         where f.account_id = ${accountId} and f.transaction_id is null
           ${cursorTs ? sql`and (f.created_at, f.id) < (${cursorTs}::text::timestamptz, ${cursorId}::uuid)` : sql``}
         order by f.created_at desc, f.id desc
         limit ${limit}`;

  const [a, b] = await Promise.all([txs, fundings]);
  const merged = [...a, ...b].sort((x, y) =>
    x.ts_key === y.ts_key ? (x.id < y.id ? 1 : -1) : x.ts_key < y.ts_key ? 1 : -1,
  );
  const page = merged.slice(0, q.data.limit);
  const last = page[page.length - 1];
  const hasMore = merged.length > q.data.limit;

  return c.json({
    items: page.map((r) => ({
      kind: r.kind,
      id: r.id,
      type: r.type,
      status: r.status,
      status_code: r.status_code,
      amount: n(r.amount),
      direction: r.type === "fund" ? "in" : r.from_account_id === accountId ? "out" : "in",
      from_wallet_id: r.from_wallet_id,
      to_wallet_id: r.to_wallet_id,
      counterparty:
        r.counter_name === null
          ? null
          : { wallet_id: r.counter_wallet_id, display_name: r.counter_name, photo: r.counter_photo },
      timestamp: r.ts,
    })),
    next_cursor: hasMore && last ? `${last.ts_key}|${last.id}` : null,
  });
});
