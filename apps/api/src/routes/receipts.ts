import { Hono } from "hono";
import type { AppContext } from "../env";
import { verifyReceipt } from "../crypto";
import { receiptFor, receiptHtml } from "../lib/receipt";

/** Public receipts: the link is a signed token for one payment, so anyone who was given it can open it and nobody can guess another one. `?format=json` for data. */
export const receipts = new Hono<AppContext>();
receipts.get("/:token", async (c) => {
  const secret = c.env.JWT_SECRET;
  const id = secret ? await verifyReceipt(secret, c.req.param("token")) : null;
  const r = id ? await receiptFor(c.get("sql"), id) : null;
  if (!r) return c.json({ error: "not_found" }, 404);
  c.header("cache-control", "private, no-store"); c.header("x-robots-tag", "noindex");
  if (c.req.query("format") === "json") return c.json({ receipt: r });
  return c.html(receiptHtml(r));
});
