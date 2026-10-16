import type { Sql } from "../db";
import { PROGRAM_TZ } from "./ledger";
import { n } from "./money";

/** Escapes LIKE wildcards so a typed filter is matched literally. */
const like = (q: string) => `%${q.replace(/[\\%_]/g, (c) => "\\" + c)}%`;

export async function merchantList(sql: Sql, q: string | null) {
  const rows = await sql<{
    id: string; name: string; handle: string | null; status: string; created_at: Date; balance: bigint;
    terminals: number; payments: number; volume: bigint;
  }[]>`
    select a.id, coalesce(b.display_name, a.name) as name, a.handle, a.status, a.created_at,
           coalesce(bal.balance, 0) as balance,
           (select count(*) from terminals t where t.account_id = a.id)::int as terminals,
           (select count(*) from transactions x where x.to_account_id = a.id and x.type = 'pay' and x.status = 'completed')::int as payments,
           (select coalesce(sum(x.amount), 0) from transactions x where x.to_account_id = a.id and x.type = 'pay' and x.status = 'completed') as volume
      from accounts a
      left join businesses b on b.account_id = a.id
      left join balances bal on bal.account_id = a.id
     where a.type = 'B'
       ${q ? sql`and (coalesce(b.display_name, a.name) ilike ${like(q)} or a.name ilike ${like(q)} or a.handle ilike ${like(q)})` : sql``}
     order by a.created_at desc, a.id desc
     limit 200`;
  return rows.map((r) => ({ ...r, balance: n(r.balance), volume: n(r.volume) }));
}

export async function userList(sql: Sql, q: string | null) {
  const rows = await sql<{
    id: string; name: string; handle: string | null; email: string | null; status: string; created_at: Date;
    balance: bigint; wallets: number; agents: number;
  }[]>`
    select a.id, a.name, a.handle, a.email, a.status, a.created_at,
           coalesce(bal.balance, 0) as balance,
           (select count(*) from wallets w where w.account_id = a.id)::int as wallets,
           (select count(*) from wallets w where w.account_id = a.id and w.type = 'agent')::int as agents
      from accounts a left join balances bal on bal.account_id = a.id
     where a.type = 'C'
       ${q ? sql`and (a.name ilike ${like(q)} or a.handle ilike ${like(q)} or a.email ilike ${like(q)})` : sql``}
     order by a.created_at desc, a.id desc
     limit 200`;
  return rows.map((r) => ({ ...r, balance: n(r.balance) }));
}

export type TxKind = "all" | "sends" | "taps" | "funds" | "agents";
export const TX_KINDS: TxKind[] = ["all", "sends", "taps", "funds", "agents"];

type TxRow = {
  id: string; type: string; status: string; status_code: string | null; amount: bigint; ts: Date; ts_key: string;
  via: string | null; agent: boolean; from_name: string | null; from_wallet: string | null; to_name: string | null; to_wallet: string | null;
};

/** The transaction feed for the admin portal, newest first, with a count per filter card. */
export async function transactionFeed(sql: Sql, kind: TxKind, limit: number, cursor: { ts: string; id: string } | null) {
  const filter =
    kind === "sends" ? sql`and t.type = 'send'`
    : kind === "taps" ? sql`and t.type = 'pay' and (t.tag_id is not null or t.pass_id is not null)`
    : kind === "funds" ? sql`and t.type = 'fund'`
    : kind === "agents" ? sql`and fw.type = 'agent' and t.type in ('send', 'pay')`
    : sql``;
  const rows = await sql<TxRow[]>`
    select t.id, t.type, t.status, t.status_code, t.amount, t."timestamp" as ts,
           to_char(t."timestamp" at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as ts_key,
           case when t.type = 'pay' and t.tag_id is not null then 'tap'
                when t.type = 'pay' and t.pass_id is not null then 'pass'
                when t.type = 'pay' then 'app' end as via,
           coalesce(fw.type = 'agent', false) as agent,
           coalesce(fb.display_name, fa.name) as from_name, fw.display_name as from_wallet,
           case when t.type = 'purchase' then 'Nuclear store' else coalesce(tb.display_name, ta.name) end as to_name,
           tw.display_name as to_wallet
      from transactions t
      left join accounts fa on fa.id = t.from_account_id
      left join businesses fb on fb.account_id = t.from_account_id
      left join wallets fw on fw.id = t.from_wallet_id
      left join accounts ta on ta.id = t.to_account_id
      left join businesses tb on tb.account_id = t.to_account_id
      left join wallets tw on tw.id = t.to_wallet_id
     where true ${filter}
       ${cursor ? sql`and (t."timestamp", t.id) < (${cursor.ts}::text::timestamptz, ${cursor.id}::uuid)` : sql``}
     order by t."timestamp" desc, t.id desc
     limit ${limit + 1}`;
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];

  const [c] = await sql<Record<string, number>[]>`
    select count(*)::int as "all",
           (count(*) filter (where t.type = 'send'))::int as sends,
           (count(*) filter (where t.type = 'pay' and (t.tag_id is not null or t.pass_id is not null)))::int as taps,
           (count(*) filter (where t.type = 'fund'))::int as funds,
           (count(*) filter (where fw.type = 'agent' and t.type in ('send', 'pay')))::int as agents
      from transactions t left join wallets fw on fw.id = t.from_wallet_id`;
  return {
    counts: c!,
    transactions: page.map((r) => ({
      id: r.id, type: r.type, status: r.status, status_code: r.status_code, amount: n(r.amount), timestamp: r.ts,
      via: r.via, agent: r.agent, from: r.from_name, from_wallet: r.from_wallet, to: r.to_name, to_wallet: r.to_wallet,
    })),
    next_cursor: rows.length > limit && last ? `${last.ts_key}|${last.id}` : null,
  };
}

/** Completed sends and payments made from agent wallets: lifetime and since 00:00 Eastern. */
export async function agentActivity(sql: Sql) {
  const [r] = await sql<{ n: number; v: bigint; tn: number; tv: bigint }[]>`
    with start as (select date_trunc('day', now() at time zone ${PROGRAM_TZ}) at time zone ${PROGRAM_TZ} as t)
    select count(*)::int as n, coalesce(sum(x.amount), 0) as v,
           (count(*) filter (where x.completed_at >= start.t))::int as tn,
           coalesce(sum(x.amount) filter (where x.completed_at >= start.t), 0) as tv
      from transactions x join wallets w on w.id = x.from_wallet_id and w.type = 'agent', start
     where x.status = 'completed' and x.type in ('send', 'pay')`;
  return {
    lifetime: { count: r!.n, volume: Number(r!.v) },
    today: { count: r!.tn, volume: Number(r!.tv) },
  };
}
