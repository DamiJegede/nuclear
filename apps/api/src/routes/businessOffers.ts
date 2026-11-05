import { Hono } from "hono";
import { z } from "zod";
import type { AppContext } from "../env";
import { customerLog } from "../lib/audit";
import { describeOffer, listOffers, offerJson } from "../lib/offers";
import { uuid } from "../lib/validate";

/** The merchant's offers (docs/OFFERS.md), mounted under /v1/business with the owner's session. */
export const businessOffersRoutes = new Hono<AppContext>();

const body = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  buy_product_id: uuid,
  buy_qty: z.number().int().min(1).max(20),
  get_product_id: uuid.nullable().optional(),       // null or missing = the same product
  get_qty: z.number().int().min(1).max(20),
  percent_off: z.number().int().min(1).max(100),     // 100 = free
  active: z.boolean().optional(),
});

businessOffersRoutes.get("/offers", async (c) => c.json({ offers: (await listOffers(c.get("sql"), c.get("auth").accountId, false)).map(offerJson) }));

/** The products named must be this merchant's own (404 otherwise); a product given with itself is stored as "the same product". */
async function names(c: { get: (k: "sql") => import("../db").Sql }, merchant: string, ids: string[]) {
  const rows = await c.get("sql")<{ id: string; name: string }[]>`select id, name from products where account_id = ${merchant} and id in ${c.get("sql")(ids)}`;
  return new Map(rows.map((r) => [r.id, r.name]));
}

businessOffersRoutes.post("/offers", async (c) => {
  const b = body.safeParse(await c.req.json().catch(() => null));
  if (!b.success) return c.json({ error: "invalid_request", issues: b.error.flatten() }, 400);
  const sql = c.get("sql"), merchant = c.get("auth").accountId, d = b.data;
  const get = d.get_product_id && d.get_product_id !== d.buy_product_id ? d.get_product_id : null;
  const nm = await names(c, merchant, [d.buy_product_id, ...(get ? [get] : [])]);
  if (!nm.has(d.buy_product_id) || (get && !nm.has(get))) return c.json({ error: "product_not_found" }, 404);
  const label = d.name ?? describeOffer({ buy_qty: d.buy_qty, get_qty: d.get_qty, percent_off: d.percent_off, buy_name: nm.get(d.buy_product_id)!, get_name: get ? nm.get(get)! : null });
  const [o] = await sql<{ id: string }[]>`
    insert into offers (account_id, name, buy_product_id, buy_qty, get_product_id, get_qty, percent_off, active)
    values (${merchant}, ${label.slice(0, 80)}, ${d.buy_product_id}, ${d.buy_qty}, ${get}, ${d.get_qty}, ${d.percent_off}, ${d.active ?? true}) returning id`;
  await customerLog(c, merchant, null, "offer.created", { offer_id: o!.id, name: label });
  return c.json({ offer: offerJson((await listOffers(sql, merchant, false, o!.id))[0]!) }, 201);
});

businessOffersRoutes.patch("/offers/:id", async (c) => {
  const id = c.req.param("id");
  if (!uuid.safeParse(id).success) return c.json({ error: "offer_not_found" }, 404);
  const b = body.partial().safeParse(await c.req.json().catch(() => null));
  if (!b.success) return c.json({ error: "invalid_request", issues: b.error.flatten() }, 400);
  const sql = c.get("sql"), merchant = c.get("auth").accountId, d = b.data;
  const [cur] = await sql<{ name: string; buy_product_id: string; buy_qty: number; get_product_id: string | null; get_qty: number; percent_off: number; active: boolean }[]>`
    select name, buy_product_id, buy_qty, get_product_id, get_qty, percent_off, active from offers where id = ${id} and account_id = ${merchant}`;
  if (!cur) return c.json({ error: "offer_not_found" }, 404);
  const buy = d.buy_product_id ?? cur.buy_product_id;
  const getIn = d.get_product_id === undefined ? cur.get_product_id : d.get_product_id;
  const get = getIn && getIn !== buy ? getIn : null;
  const nm = await names(c, merchant, [buy, ...(get ? [get] : [])]);
  if (!nm.has(buy) || (get && !nm.has(get))) return c.json({ error: "product_not_found" }, 404);
  const next = { buy_qty: d.buy_qty ?? cur.buy_qty, get_qty: d.get_qty ?? cur.get_qty, percent_off: d.percent_off ?? cur.percent_off };
  const label = d.name ?? ((d.buy_product_id || d.get_product_id !== undefined || d.buy_qty || d.get_qty || d.percent_off) && cur.name === describeOffer({ ...cur, buy_name: nm.get(cur.buy_product_id) ?? "", get_name: cur.get_product_id ? nm.get(cur.get_product_id) ?? null : null })
    ? describeOffer({ ...next, buy_name: nm.get(buy)!, get_name: get ? nm.get(get)! : null }) : cur.name);
  await sql`
    update offers set name = ${label.slice(0, 80)}, buy_product_id = ${buy}, buy_qty = ${next.buy_qty}, get_product_id = ${get}, get_qty = ${next.get_qty},
           percent_off = ${next.percent_off}, active = ${d.active ?? cur.active}, updated_at = now()
     where id = ${id} and account_id = ${merchant}`;
  await customerLog(c, merchant, null, "offer.updated", { offer_id: id, active: d.active ?? cur.active });
  return c.json({ offer: offerJson((await listOffers(sql, merchant, false, id))[0]!) });
});

businessOffersRoutes.delete("/offers/:id", async (c) => {
  const id = c.req.param("id");
  if (!uuid.safeParse(id).success) return c.json({ error: "offer_not_found" }, 404);
  const merchant = c.get("auth").accountId;
  const del = await c.get("sql")`delete from offers where id = ${id} and account_id = ${merchant} returning id`;
  if (del.length === 0) return c.json({ error: "offer_not_found" }, 404);
  await customerLog(c, merchant, null, "offer.deleted", { offer_id: id });
  return c.body(null, 204);
});
