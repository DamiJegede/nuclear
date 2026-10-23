import { track } from "../lib/tracker";
import { RULES, byAccount, rateLimit } from "../lib/throttle";
import { Hono } from "hono";
import { z } from "zod";
import type { AppContext } from "../env";
import { amount, n } from "../lib/money";
import { sandboxFund } from "../lib/fund";
import { dailyHeadroom } from "../lib/benefits";
import { dailyCap } from "../lib/config";
import { handleSchema } from "../lib/handle";
import { requireOwner, requireSession } from "../session";
import { imageUrl } from "../lib/images";
import { saveProfilePhoto } from "../lib/profilePhoto";
import { MAX_DOCUMENTS, MAX_UPLOAD_BYTES, putUpload, uploadKind } from "../lib/uploads";
import { customerLog } from "../lib/audit";
import { accountView, balanceView } from "../lib/views";

export const account = new Hono<AppContext>();
account.use("*", requireSession);

// Primary-account profile. Handle is NULL until the owner sets it.
account.get("/account", requireOwner, async (c) => {
  const view = await accountView(c.get("sql"), c.get("auth").accountId);
  return view ? c.json(view) : c.json({ error: "not_found" }, 404);
});

// The account's picture (a person's, or a business's logo), uploaded after the account exists: any PNG, JPEG or WebP, cropped to
// 256 x 256, compressed to JPEG, saved in R2; accounts.photo keeps the R2 key.
account.put("/account/photo", requireOwner, async (c) => {
  const { accountId } = c.get("auth");
  const sql = c.get("sql");
  const [a] = await sql<{ photo: string | null; name: string }[]>`select photo, name from accounts where id = ${accountId}`;
  if (!a) return c.json({ error: "not_found" }, 404);
  const r = await saveProfilePhoto(c, "accounts", accountId, a.photo);
  if (r instanceof Response) return r;
  await sql`update accounts set photo = ${r.key} where id = ${accountId}`;
  await customerLog(c, accountId, null, "customer.photo_changed", { account_id: accountId });
  return c.json({ photo: imageUrl(r.key) });
});

// A business's own documents. A pending or declined business may use these (see session.ts): it uploads a document for
// review; a declined business that uploads again goes back to pending. The file goes to the private bucket `nuclear-uploads`.
account.get("/account/documents", requireOwner, async (c) => {
  const rows = await c.get("sql")`select id, type, created_at from uploads where account_id = ${c.get("auth").accountId} order by created_at desc, id desc`;
  return c.json({ documents: rows });
});

account.post("/account/documents", requireOwner, async (c) => {
  const { accountId } = c.get("auth");
  const sql = c.get("sql");
  const [a] = await sql<{ type: string; status: string; name: string }[]>`select type, status, name from accounts where id = ${accountId}`;
  if (!a || (a.type !== "B" && a.type !== "O")) return c.json({ error: "forbidden" }, 403);   // businesses and organizations
  const mime = (c.req.header("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  const bytes = new Uint8Array(await c.req.arrayBuffer());
  if (bytes.length === 0) return c.json({ error: "invalid_request" }, 400);
  if (bytes.length > MAX_UPLOAD_BYTES) return c.json({ error: "file_too_large" }, 413);
  const kind = uploadKind(mime, bytes);
  if (!kind) return c.json({ error: "unsupported_file_type" }, 415);
  const [n] = await sql<{ n: number }[]>`select count(*)::int as n from uploads where account_id = ${accountId} and type = 'business_document'`;
  if (n!.n >= MAX_DOCUMENTS) return c.json({ error: "too_many_documents" }, 409);
  const [u] = await sql<{ id: string }[]>`select uuidv7() as id`;
  const path = `${accountId}/${u!.id}.${kind.ext}`;
  if (!(await putUpload(c.env, path, bytes, kind.mime))) return c.json({ error: "storage_unavailable" }, 503);
  const [row] = await sql<{ id: string; type: string; created_at: Date }[]>`
    insert into uploads (id, account_id, type, path) values (${u!.id}, ${accountId}, 'business_document', ${path}) returning id, type, created_at`;
  if (a.status === "declined") await sql`update accounts set status = 'pending' where id = ${accountId} and status = 'declined'`;
  await customerLog(c, accountId, null, "business.document_uploaded", { upload_id: row!.id, resubmitted: a.status === "declined" }, { type: "merchant", id: accountId, label: a.name });
  return c.json({ document: row, status: a.status === "declined" ? "pending" : a.status }, 201);
});

// The account's bio: up to 128 characters; an empty text (or null) clears it. Owner only.
account.put("/account/bio", requireOwner, async (c) => {
  const b = z.object({ bio: z.string().trim().max(128).nullable() }).safeParse(await c.req.json().catch(() => null));
  if (!b.success) return c.json({ error: "invalid_request" }, 400);
  const { accountId } = c.get("auth");
  const bio = b.data.bio ? b.data.bio : null;
  await c.get("sql")`update accounts set bio = ${bio} where id = ${accountId}`;
  await customerLog(c, accountId, null, "customer.bio_changed", { length: bio?.length ?? 0 });
  return c.json({ bio });
});

// Set or change the account handle. Primary/root account only: requireOwner rejects delegated
// shared-wallet sessions, and wallets/members never have handles of their own.
account.put("/account/handle", requireOwner, async (c) => {
  const parsed = z.object({ handle: handleSchema }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "invalid_request", issues: parsed.error.flatten() }, 400);
  const { accountId } = c.get("auth");
  try {
    const [row] = await c.get("sql")<{ handle: string }[]>`
      update accounts set handle = ${parsed.data.handle}
       where id = ${accountId} and status = 'active' returning handle`;
    if (!row) return c.json({ error: "not_found" }, 404);
    await customerLog(c, accountId, null, "customer.handle_changed", { handle: row.handle });
    return c.json({ handle: row.handle });
  } catch (err) {
    if ((err as { code?: string }).code === "23505") return c.json({ error: "handle_taken" }, 409);
    throw err;
  }
});

account.get("/balance", async (c) => {
  const view = await balanceView(c.get("sql"), c.env, c.get("auth"));
  return view ? c.json(view) : c.json({ error: "not_found" }, 404);
});

// Find a recipient's default wallet by exact email. Open product decision (recipient lookup);
// returns display data only and 404s for anything not an active consumer account.
account.post("/recipients/lookup", rateLimit("lookup-email", RULES.lookupEmail, byAccount), async (c) => {
  const parsed = z
    .object({ email: z.string().trim().toLowerCase().email().max(254) })
    .safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "invalid_request" }, 400);
  const { accountId } = c.get("auth");
  const [r] = await c.get("sql")<{ id: string; display_name: string; photo: string | null }[]>`
    select w.id, w.display_name, w.photo
      from accounts a join wallets w on w.account_id = a.id and w.type = 'default' and w.status = 'active'
     where lower(a.email) = ${parsed.data.email} and a.type = 'C' and a.status = 'active'
       and a.id <> ${accountId}`;
  if (!r) return c.json({ error: "not_found" }, 404);
  return c.json({ wallet_id: r.id, display_name: r.display_name, photo: imageUrl(r.photo) });
});

// SANDBOX ONLY: simulated bank load, confirmed and released immediately.
account.post("/sandbox/fundings", requireOwner, async (c) => {
  if (c.env.SANDBOX_FUNDING !== "true") return c.json({ error: "not_found" }, 404);
  const key = c.req.header("idempotency-key")?.trim();
  if (!key || key.length > 128) return c.json({ error: "idempotency_key_required" }, 400);
  const parsed = z.object({ amount }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "invalid_request", issues: parsed.error.flatten() }, 400);

  const out = await sandboxFund(c.get("sql"), {
    accountId: c.get("auth").accountId,
    amount: parsed.data.amount,
    idempotencyKey: key,
    dailyCap: dailyCap(c.env),
  });
  if (out.kind === "error") return c.json({ error: out.error }, out.status);
  const f = out.funding;
  const funding = {
    id: f.id,
    amount: n(f.amount),
    status: f.status,
    failure_code: f.failure_code,
    transaction_id: f.transaction_id,
    created_at: f.created_at,
    released_at: f.released_at,
  };
  if (out.kind === "failed") return c.json({ error: "declined", status_code: f.failure_code, funding }, 422);
  if (!out.replayed) track(c, { loads_n: 1, loads_v: Number(f.amount) });   // today's running estimate
  return c.json({ funding }, out.replayed ? 200 : 201);
});
