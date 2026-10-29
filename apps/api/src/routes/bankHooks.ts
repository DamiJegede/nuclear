import { Hono } from "hono";
import type { AppContext } from "../env";
import { handleCrbEvent, verifyCrbSignature, type CrbEvent } from "../lib/crbHooks";

/** Inbound calls from the bank. No session: the signature is the authority (docs/CROSS-RIVER.md). */
export const bankHooks = new Hono<AppContext>();

bankHooks.post("/crb", async (c) => {
  const secret = c.env.CR_WH_SEC;
  if (!secret) return c.json({ error: "not_configured" }, 503);
  const raw = await c.req.text();
  if (!(await verifyCrbSignature(secret, c.req.header("cos-signature"), raw))) return c.json({ error: "invalid_signature" }, 401);
  let ev: CrbEvent;
  try { ev = JSON.parse(raw) as CrbEvent; } catch { return c.json({ error: "invalid_request" }, 400); }
  // Answer 2xx whenever the signature is good: three failures suspend the registration. What we could not apply now the nightly poll catches.
  try { await handleCrbEvent(c.env, c.get("sql"), ev); } catch (err) { console.error("bank webhook failed", ev.id, err); }
  return c.json({ ok: true });
});
