import { Hono } from "hono";
import { z } from "zod";
import type { AppContext } from "../env";
import { customerLog } from "../lib/audit";
import { describeOffer, listOffers, offerJson } from "../lib/offers";
import { uuid } from "../lib/validate";

/** The merchant's offers (docs/OFFERS.md), mounted under /v1/business with the owner's session. */
export const businessOffersRoutes = new Hono<AppContext>();

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((d) => new Date(d + "T00:00:00Z").toISOString().slice(0, 10) === d);
const schedule = {
  days: z.array(z.number().int().min(1).max(7)).min(1).max(7).nullable().optional(),   // 1 = Monday ... 7 = Sunday; null = every day
  from_time: hhmm.nullable().optional(),                                                 // New York time; with to_time, both or neither
  to_time: hhmm.nullable().optional(),
  starts_on: day.nullable().optional(),
  ends_on: day.nullable().optional(),
};
const body = z.object({
  ...schedule,
  name: z.string().trim().min(1).max(80).optional(),
  buy_product_id: uuid,
  buy_qty: z.number().int().min(1).max(20),
  get_product_id: uuid.nullable().optional(),       // null or missing = the same product
  get_qty: z.number().int().min(1).max(20),
  percent_off: z.number().int().min(1).max(100),     // 100 = free
  active: z.boolean().optional(),
});

/** The schedule to store: days sorted and unique (all seven = every day), the times as a pair, the dates in order. A string is the problem when it is not valid. */
function scheduleOf(d: { days?: number[] | null; from_time?: string | null; to_time?: string | null; starts_on?: string | null; ends_on?: string | null }): { error: string } | { days: number[] | null; from: string | null; to: string | null; starts: string | null; ends: string | null } {
  const days = d.days ? [...new Set(d.days)].sort((a, b) => a - b) : null;
  const from = d.from_time ?? null, to = d.to_time ?? null;
  if ((from === null) !== (to === null)) return { error: "time_window_incomplete" };
  if (from !== null && from === to) return { error: "time_window_empty" };
  const starts = d.starts_on ?? null, ends = d.ends_on ?? null;
  if (starts && ends && starts > ends) return { error: "dates_out_of_order" };
  return { days: days && days.length === 7 ? null : days, from, to, starts, ends };
}

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
  const sch = scheduleOf(d);
  if ("error" in sch) return c.json({ error: sch.error }, 422);
  const label = d.name ?? describeOffer({ buy_qty: d.buy_qty, get_qty: d.get_qty, percent_off: d.percent_off, buy_name: nm.get(d.buy_product_id)!, get_name: get ? nm.get(get)! : null });
  const [o] = await sql<{ id: string }[]>`
    insert into offers (account_id, name, buy_product_id, buy_qty, get_product_id, get_qty, percent_off, active, days, from_time, to_time, starts_on, ends_on)
    values (${merchant}, ${label.slice(0, 80)}, ${d.buy_product_id}, ${d.buy_qty}, ${get}, ${d.get_qty}, ${d.percent_off}, ${d.active ?? true},
            ${sch.days ? `{${sch.days.join(",")}}` : null}::smallint[], ${sch.from}::time, ${sch.to}::time, ${sch.starts}::date, ${sch.ends}::date) returning id`;
  await customerLog(c, merchant, null, "offer.created", { offer_id: o!.id, name: label });
  return c.json({ offer: offerJson((await listOffers(sql, merchant, false, o!.id))[0]!) }, 201);
});

businessOffersRoutes.patch("/offers/:id", async (c) => {
  const id = c.req.param("id");
  if (!uuid.safeParse(id).success) return c.json({ error: "offer_not_found" }, 404);
  const b = body.partial().safeParse(await c.req.json().catch(() => null));
  if (!b.success) return c.json({ error: "invalid_request", issues: b.error.flatten() }, 400);
  const sql = c.get("sql"), merchant = c.get("auth").accountId, d = b.data;
  const [cur] = await listOffers(sql, merchant, false, id);
  if (!cur) return c.json({ error: "offer_not_found" }, 404);
  // a field left out keeps its value; null clears a schedule field
  const sch = scheduleOf({ days: d.days === undefined ? cur.days : d.days, from_time: d.from_time === undefined ? cur.from_time : d.from_time, to_time: d.to_time === undefined ? cur.to_time : d.to_time,
    starts_on: d.starts_on === undefined ? cur.starts_on : d.starts_on, ends_on: d.ends_on === undefined ? cur.ends_on : d.ends_on });
  if ("error" in sch) return c.json({ error: sch.error }, 422);
  const buy = d.buy_product_id ?? cur.buy_product_id;
  const getIn = d.get_product_id === undefined ? cur.get_product_id : d.get_product_id;
  const get = getIn && getIn !== buy ? getIn : null;
  const nm = await names(c, merchant, [buy, ...(get ? [get] : [])]);
  if (!nm.has(buy) || (get && !nm.has(get))) return c.json({ error: "product_not_found" }, 404);
  const next = { buy_qty: d.buy_qty ?? cur.buy_qty, get_qty: d.get_qty ?? cur.get_qty, percent_off: d.percent_off ?? cur.percent_off };
  const label = d.name ?? ((d.buy_product_id || d.get_product_id !== undefined || d.buy_qty || d.get_qty || d.percent_off) && cur.name === describeOffer({ ...cur, buy_name: cur.buy_name, get_name: cur.get_product_id ? cur.get_name : null })
    ? describeOffer({ ...next, buy_name: nm.get(buy)!, get_name: get ? nm.get(get)! : null }) : cur.name);
  await sql`
    update offers set name = ${label.slice(0, 80)}, buy_product_id = ${buy}, buy_qty = ${next.buy_qty}, get_product_id = ${get}, get_qty = ${next.get_qty},
           percent_off = ${next.percent_off}, active = ${d.active ?? cur.active}, updated_at = now(),
           days = ${sch.days ? `{${sch.days.join(",")}}` : null}::smallint[], from_time = ${sch.from}::time, to_time = ${sch.to}::time, starts_on = ${sch.starts}::date, ends_on = ${sch.ends}::date
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
