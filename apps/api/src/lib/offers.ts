import type { Sql } from "../db";

/** A merchant's offer (docs/OFFERS.md): buy `buy_qty` of a product, get `get_qty` of a product (the same one when `get_product_id` is null) at `percent_off` (100 = free). */
export type OfferRow = {
  id: string; name: string; buy_product_id: string; buy_qty: number; get_product_id: string | null; get_qty: number; percent_off: number; active: boolean;
  created_at: Date; buy_name: string; get_name: string | null;
};

const off = (p: number) => (p >= 100 ? "free" : `${p}% off`);
const units = (q: number, name: string) => (q === 1 ? name : `${q} × ${name}`);

/** "Buy 2 Craft Beer, get 1 free", "Buy 1 Burrata, get 1 Seared Salmon 50% off". */
export function describeOffer(o: { buy_qty: number; get_qty: number; percent_off: number; buy_name: string; get_name: string | null }): string {
  const buy = `Buy ${units(o.buy_qty, o.buy_name)}`;
  if (!o.get_name || o.get_name === o.buy_name) return `${buy}, get ${o.get_qty} ${o.percent_off >= 100 ? "free" : off(o.percent_off)}`;
  return `${buy}, get ${units(o.get_qty, o.get_name)} ${off(o.percent_off)}`;
}

export const offerJson = (o: OfferRow) => ({
  id: o.id, name: o.name, description: describeOffer(o), buy_product_id: o.buy_product_id, buy_product_name: o.buy_name, buy_qty: o.buy_qty,
  get_product_id: o.get_product_id ?? o.buy_product_id, get_product_name: o.get_name ?? o.buy_name, get_qty: o.get_qty, percent_off: o.percent_off, same_product: !o.get_product_id,
  active: o.active, created_at: o.created_at,
});

/** A merchant's offers (all of them, or just the live ones) with the product names. */
export const listOffers = (sql: Sql, merchant: string, onlyActive: boolean, id?: string) => sql<OfferRow[]>`
  select o.id, o.name, o.buy_product_id, o.buy_qty, o.get_product_id, o.get_qty, o.percent_off, o.active, o.created_at, b.name as buy_name, g.name as get_name
    from offers o join products b on b.id = o.buy_product_id left join products g on g.id = o.get_product_id
   where o.account_id = ${merchant} ${onlyActive ? sql`and o.active and b.active and (g.id is null or g.active)` : sql``} ${id ? sql`and o.id = ${id}` : sql``}
   order by o.created_at, o.id`;
