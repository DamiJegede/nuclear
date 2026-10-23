import type { Sql } from "../db";
import type { Env } from "../env";
import { dailyHeadroom } from "./benefits";
import { dailyCap } from "./config";
import { imageUrl } from "./images";
import { n } from "./money";

/**
 * What the app shows, as the pieces the routes and the launch call (POST /v1/auth/refresh) share: the account, the balance summary, the wallets
 * and the tags, each for a session (an owner sees the whole account, a delegated device only its own wallet).
 */

export type Auth = { accountId: string; walletId: string | null };

export type WalletRow = {
  id: string;
  account_id: string;
  display_name: string;
  photo: string | null;
  type: string;
  daily_limit: bigint | null;
  spent_today: bigint;
  allow_pay: boolean;
  allow_send: boolean;
  status: string;
  balance: bigint | null;
  key_hint: string | null;
  key_last_used_at: Date | null;
  created_at: Date;
  org_account_id: string | null;
  organization_name: string | null;
};

export const WALLET_COLS = `id, account_id, display_name, photo, type, daily_limit, (case when spent_day = program_today() then spent_today else 0 end) as spent_today,
  allow_pay, allow_send, status, balance, key_hint, key_last_used_at, created_at,
  org_account_id, (select o.name from accounts o where o.id = wallets.org_account_id) as organization_name`;

export function walletJson(w: WalletRow) {
  return {
    id: w.id,
    display_name: w.display_name,
    photo: imageUrl(w.photo),
    type: w.type,
    daily_limit: n(w.daily_limit),
    spent_today: n(w.spent_today),
    remaining_today: w.daily_limit === null ? null : n(w.daily_limit > w.spent_today ? w.daily_limit - w.spent_today : 0n),
    allow_pay: w.allow_pay,
    allow_send: w.allow_send,
    status: w.status,
    // Earmarked funds: null = spends from the account's shared funds; a number = a hard spending limit.
    balance: n(w.balance),
    earmarked: w.balance !== null,
    // The agent API key, if one exists: never the key itself, only what identifies it.
    key: w.key_hint === null ? null : { hint: w.key_hint, last_used_at: w.key_last_used_at },
    created_at: w.created_at,
    // A Benefits wallet: the employer it is bound to for good. Its balance is real funded money that only pays merchants or moves to another wallet of this account.
    organization: w.org_account_id ? { id: w.org_account_id, name: w.organization_name } : null,
  };
}


export type TagView = {
  id: string;
  label: string | null;
  wallet_id: string | null;
  locked: boolean;
  transaction_limit: bigint | null;
  last_read_at: Date | null;
  created_at: Date;
  model_id: string;
  model_type: string;
  model_name: string;
  model_photo: string | null;
};

export const TAG_VIEW = `t.id, t.label, t.wallet_id, t.locked, t.transaction_limit, t.last_read_at, t.created_at,
  m.id as model_id, m.type as model_type, m.name as model_name, m.photo as model_photo`;

export const tagJson = (t: TagView) => ({
  id: t.id,
  label: t.label,
  wallet_id: t.wallet_id,
  locked: t.locked,
  transaction_limit: n(t.transaction_limit),
  last_read_at: t.last_read_at,
  created_at: t.created_at,
  model: { id: t.model_id, type: t.model_type, name: t.model_name, photo: imageUrl(t.model_photo) },
});


export async function listWallets(sql: Sql, a: Auth): Promise<ReturnType<typeof walletJson>[]> {
  const rows = await sql<WalletRow[]>`
    select ${sql.unsafe(WALLET_COLS)} from wallets
     where account_id = ${a.accountId} and type <> 'escrow' ${a.walletId ? sql`and id = ${a.walletId}` : sql``}
     order by (type = 'default') desc, created_at, id`;
  return rows.map(walletJson);
}

export async function listTags(sql: Sql, a: Auth) {
  const rows = await sql<TagView[]>`
    select ${sql.unsafe(TAG_VIEW)}
      from tags t join tag_models m on m.id = t.model_id join wallets w on w.id = t.wallet_id
     where w.account_id = ${a.accountId} ${a.walletId ? sql`and t.wallet_id = ${a.walletId}` : sql``}
     order by t.created_at, t.id`;
  return rows.map(tagJson);
}

export async function accountView(sql: Sql, accountId: string) {
  const [a] = await sql<
    { id: string; type: string; handle: string | null; name: string; email: string | null; email_verified_at: Date | null; phone: string | null; photo: string | null; bio: string | null; tier: string; status: string }[]
  >`select id, type, handle, name, email, email_verified_at, phone, photo, bio, tier, status from accounts where id = ${accountId}`;
  if (!a) return null;
  // A declined business is told why (the reason an admin wrote when declining).
  const [d] = a.status === "declined"
    ? await sql<{ reason: string | null; at: Date }[]>`select details->>'reason' as reason, created_at as at from logs where action = 'merchant.declined' and target_id = ${a.id} order by created_at desc, id desc limit 1`
    : [];
  return {
    account_id: a.id, type: a.type, handle: a.handle, name: a.name, email: a.email, email_verified: a.email_verified_at !== null, phone: a.phone, photo: imageUrl(a.photo), bio: a.bio, tier: a.tier, status: a.status,
    ...(d ? { decline: { reason: d.reason, at: d.at } } : {}),
  };
}

const pos = (v: bigint) => (v > 0n ? v : 0n);

/**
 * Account-wide funds. The total includes Benefits wallets (employer-funded, bound to one employer each); the rest is "ordinary". Funds set
 * aside for specific wallets (earmarks and Benefits) are not available to the other wallets. Delegated sessions see availability, not credit
 * detail; a session on a Benefits wallet sees that wallet's balance and cannot send.
 */
export async function balanceView(sql: Sql, env: Env, a: Auth) {
  const [b] = await sql<{ balance: bigint; balance_pending: bigint; credit_limit: bigint; credit_spent: bigint }[]>`
    select balance, balance_pending, credit_limit, credit_spent from balances where account_id = ${a.accountId}`;
  if (!b) return null;
  const [e] = await sql<{ total: bigint; benefits: bigint }[]>`
    select coalesce(sum(balance), 0)::bigint as total,
           coalesce(sum(balance) filter (where type = 'benefits'), 0)::bigint as benefits
      from wallets where account_id = ${a.accountId} and balance is not null`;
  const [mine] = a.walletId
    ? await sql<{ balance: bigint | null; type: string }[]>`select balance, type from wallets where id = ${a.walletId}`
    : [undefined];
  const restricted = b.balance < 0n || b.credit_spent > b.credit_limit;
  const creditAvailable = pos(b.credit_limit - b.credit_spent);
  const shared = pos(b.balance - e!.total);
  const earmarkedWallet = mine?.balance !== null && mine?.balance !== undefined;
  const benefitsWallet = mine?.type === "benefits";
  const availableToSend = restricted || benefitsWallet ? 0n : earmarkedWallet ? mine!.balance! : shared;
  const availableToPay = restricted ? 0n : earmarkedWallet ? mine!.balance! : shared + creditAvailable;
  const common = {
    available_to_send: n(availableToSend),
    available_to_pay: n(availableToPay),
    restricted,
  };
  if (a.walletId !== null) return common;
  const ordinaryEarmarked = e!.total - e!.benefits;
  return {
    ...common,
    balance: n(b.balance),                              // total funded: ordinary + Benefits
    benefits: n(e!.benefits),
    ordinary: n(b.balance - e!.benefits),
    ordinary_shared_available: n(shared),               // what unearmarked wallets can draw on
    earmarked: n(ordinaryEarmarked),                    // ordinary money set aside for specific wallets (Benefits is reported separately)
    daily_headroom: n(await dailyHeadroom(sql, a.accountId, dailyCap(env))),
    balance_pending: n(b.balance_pending),
    credit_limit: n(b.credit_limit),
    credit_spent: n(b.credit_spent),
  };
}
