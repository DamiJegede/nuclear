import type { Sql } from "../db";

/** A merchant's offer (docs/OFFERS.md): buy `buy_qty` of a product, get `get_qty` of a product (the same one when `get_product_id` is null) at `percent_off` (100 = free). */
export type OfferRow = {
  id: string; name: string; buy_product_id: string; buy_qty: number; get_product_id: string | null; get_qty: number; percent_off: number; active: boolean;
  created_at: Date; buy_name: string; get_name: string | null;
  /** The schedule (docs/OFFERS.md): ISO weekdays 1 = Monday to 7 = Sunday (null = every day), a time window in New York time ("HH:MM"), a date range ("YYYY-MM-DD"). */
  days: number[] | null; from_time: string | null; to_time: string | null; starts_on: string | null; ends_on: string | null;
  /** Whether the schedule covers this moment (the database's clock). */
  live_now: boolean;
};

const off = (p: number) => (p >= 100 ? "free" : `${p}% off`);
const units = (q: number, name: string) => (q === 1 ? name : `${q} × ${name}`);

/** "Buy 2 Craft Beer, get 1 free", "Buy 1 Burrata, get 1 Seared Salmon 50% off". */
export function describeOffer(o: { buy_qty: number; get_qty: number; percent_off: number; buy_name: string; get_name: string | null }): string {
  const buy = `Buy ${units(o.buy_qty, o.buy_name)}`;
  if (!o.get_name || o.get_name === o.buy_name) return `${buy}, get ${o.get_qty} ${o.percent_off >= 100 ? "free" : off(o.percent_off)}`;
  return `${buy}, get ${units(o.get_qty, o.get_name)} ${off(o.percent_off)}`;
}

const DAY = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const clock = (t: string) => { const [h, m] = t.split(":").map(Number); return `${h! % 12 || 12}${m ? `:${String(m).padStart(2, "0")}` : ""} ${h! < 12 ? "AM" : "PM"}`; };
const monthDay = (d: string) => new Date(d + "T00:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

/** The schedule in words: "Every day", "Mon–Fri, 4 PM–6 PM", "Sat–Sun, from Dec 1 until Dec 31". */
export function describeSchedule(o: Pick<OfferRow, "days" | "from_time" | "to_time" | "starts_on" | "ends_on">): string {
  const days = [...new Set(o.days ?? [1, 2, 3, 4, 5, 6, 7])].sort((a, b) => a - b);
  const runs: string[] = [];
  for (let i = 0; i < days.length;) {
    let j = i; while (j + 1 < days.length && days[j + 1] === days[j]! + 1) j++;
    runs.push(j - i >= 1 ? `${DAY[days[i]! - 1]}–${DAY[days[j]! - 1]}` : days.slice(i, j + 1).map((d) => DAY[d - 1]).join(", "));
    i = j + 1;
  }
  const parts = [days.length === 7 ? "Every day" : runs.join(", ")];
  if (o.from_time && o.to_time) parts.push(`${clock(o.from_time)}–${clock(o.to_time)}`);
  if (o.starts_on && o.ends_on) parts.push(`${monthDay(o.starts_on)} – ${monthDay(o.ends_on)}`);
  else if (o.starts_on) parts.push(`from ${monthDay(o.starts_on)}`);
  else if (o.ends_on) parts.push(`until ${monthDay(o.ends_on)}`);
  return parts.join(", ");
}
export const hasSchedule = (o: Pick<OfferRow, "days" | "from_time" | "starts_on" | "ends_on">) => !!(o.days || o.from_time || o.starts_on || o.ends_on);

export const offerJson = (o: OfferRow) => ({
  id: o.id, name: o.name, description: describeOffer(o), buy_product_id: o.buy_product_id, buy_product_name: o.buy_name, buy_qty: o.buy_qty,
  get_product_id: o.get_product_id ?? o.buy_product_id, get_product_name: o.get_name ?? o.buy_name, get_qty: o.get_qty, percent_off: o.percent_off, same_product: !o.get_product_id,
  active: o.active, created_at: o.created_at,
  schedule: { days: o.days, from_time: o.from_time, to_time: o.to_time, starts_on: o.starts_on, ends_on: o.ends_on }, schedule_text: hasSchedule(o) ? describeSchedule(o) : null, live_now: o.live_now,
});

/** A merchant's offers (all of them, or just the live ones) with the product names. */
export const listOffers = (sql: Sql, merchant: string, onlyActive: boolean, id?: string) => sql<OfferRow[]>`
  select o.id, o.name, o.buy_product_id, o.buy_qty, o.get_product_id, o.get_qty, o.percent_off, o.active, o.created_at, b.name as buy_name, g.name as get_name,
         to_jsonb(o.days) as days, to_char(o.from_time, 'HH24:MI') as from_time, to_char(o.to_time, 'HH24:MI') as to_time, o.starts_on::text as starts_on, o.ends_on::text as ends_on,
         public.offer_live(o, now()) as live_now
    from offers o join products b on b.id = o.buy_product_id left join products g on g.id = o.get_product_id
   where o.account_id = ${merchant} ${onlyActive ? sql`and o.active and b.active and (g.id is null or g.active)` : sql``} ${id ? sql`and o.id = ${id}` : sql``}
   order by o.created_at, o.id`;
