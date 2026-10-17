import { RULES, byAccount, rateLimit } from "../lib/throttle";
import { imageUrl } from "../lib/images";
import { Hono } from "hono";
import type { AppContext } from "../env";
import { handleSchema } from "../lib/handle";
import { requireSession } from "../session";

export const handles = new Hono<AppContext>();
handles.use("*", requireSession);

// Resolve a handle to its account id plus the default wallet (the send target).
// Authenticated only; inactive and unknown handles are indistinguishable (404).
handles.get("/:handle", rateLimit("lookup-handle", RULES.lookupHandle, byAccount), async (c) => {
  const h = handleSchema.safeParse(c.req.param("handle"));
  if (!h.success) return c.json({ error: "not_found" }, 404);

  const [r] = await c.get("sql")<
    { account_id: string; handle: string; type: string; name: string; photo: string | null; wallet_id: string }[]
  >`
    select a.id as account_id, a.handle, a.type, w.display_name as name, w.photo, w.id as wallet_id
      from accounts a
      join wallets w on w.account_id = a.id and w.type = 'default' and w.status = 'active'
     where a.handle = ${h.data} and a.status = 'active'`;
  if (!r) return c.json({ error: "not_found" }, 404);
  return c.json({
    account_id: r.account_id,
    handle: r.handle,
    type: r.type,
    display_name: r.name,
    photo: imageUrl(r.photo),
    wallet_id: r.wallet_id,
  });
});
