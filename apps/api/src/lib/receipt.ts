import type { Sql } from "../db";

export type Receipt = {
  id: string;
  date: string;
  merchant: { name: string; legal_name: string | null; address: string | null; website: string | null };
  reference: string | null;
  tender: string;
  items: { name: string; quantity: number; unit_price: number; discount: number; line_total: number; taxed: boolean }[];
  /** Item total before tax (discounts taken off); when tax is included the tax is part of it and `tax_included` is true. */
  subtotal: number;
  discounts: number;
  sales_tax: number;
  tax_rate: number | null;
  tax_included: boolean;
  tip: number;
  total: number;
  refunds: { date: string; amount: number; tax: number }[];
  refunded: number;
  tax_refunded: number;
};

/** Everything a receipt shows for a completed payment (the order's own snapshot, never today's prices or rates), or null. Reads no payer details. */
export async function receiptFor(sql: Sql, payId: string): Promise<Receipt | null> {
  const [p] = await sql<{ id: string; amount: bigint; created_at: Date; tag_id: string | null; checkout_id: string | null; merchant_id: string; reference: string | null }[]>`
    select t.id, t.amount, t.created_at, t.tag_id, t.checkout_id, w.account_id as merchant_id, t.reference
      from transactions t join wallets w on w.id = t.to_wallet_id
     where t.id = ${payId} and t.type = 'pay' and t.status = 'completed'`;
  if (!p) return null;
  const [m] = await sql<{ name: string; legal_name: string | null; address: string | null; city: string | null; state: string | null; post_code: string | null; website: string | null }[]>`
    select coalesce(b.display_name, a.name) as name, b.legal_name, b.address, b.city, b.state, b.post_code, b.website
      from accounts a left join businesses b on b.account_id = a.id where a.id = ${p.merchant_id}`;
  const [co] = p.checkout_id ? await sql<{ items: { name: string; quantity: number; unit_price: number; discount: number; tax_rate?: number; tax_included?: boolean }[]; sales_tax: bigint; tip_amount: bigint; reference: string | null }[]>`
    select items, sales_tax, tip_amount, reference from checkouts where id = ${p.checkout_id}` : [];
  const refunds = await sql<{ created_at: Date; amount: bigint; tax: string | null }[]>`
    select created_at, amount, meta ->> 'tax' as tax from transactions where type = 'refund' and status = 'completed' and related_id = ${payId} order by created_at, id`;
  const items = (co?.items ?? []).map((i) => ({ name: i.name, quantity: i.quantity, unit_price: i.unit_price, discount: i.discount, line_total: (i.unit_price - i.discount) * i.quantity, taxed: (i.tax_rate ?? 0) > 0 }));
  const included = !!co?.items?.[0]?.tax_included;
  const tax = Number(co?.sales_tax ?? 0n), tip = Number(co?.tip_amount ?? 0n), total = Number(p.amount);
  const lineSum = items.reduce((a, i) => a + i.line_total, 0);
  const address = [m?.address, [m?.city, m?.state].filter(Boolean).join(", "), m?.post_code].filter(Boolean).join(" · ") || null;
  return {
    id: p.id, date: p.created_at.toISOString(), merchant: { name: m?.name ?? "", legal_name: m?.legal_name ?? null, address, website: m?.website ?? null },
    reference: co?.reference ?? p.reference, tender: p.tag_id ? "Nuclear tag" : "Nuclear wallet",
    items, subtotal: items.length ? lineSum : total - tip - (included ? 0 : tax), discounts: items.reduce((a, i) => a + i.discount * i.quantity, 0),
    sales_tax: tax, tax_rate: co?.items?.find((i) => (i.tax_rate ?? 0) > 0)?.tax_rate ?? null, tax_included: included, tip, total,
    refunds: refunds.map((r) => ({ date: r.created_at.toISOString(), amount: Number(r.amount), tax: Number(r.tax ?? 0) })),
    refunded: refunds.reduce((a, r) => a + Number(r.amount), 0), tax_refunded: refunds.reduce((a, r) => a + Number(r.tax ?? 0), 0),
  };
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const usd = (cents: number) => (cents < 0 ? "-" : "") + "$" + (Math.abs(cents) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** The receipt as a small self-contained page (no scripts, nothing from outside). */
export function receiptHtml(r: Receipt): string {
  const when = new Date(r.date).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "America/New_York" }) + " ET";
  const row = (l: string, v: string, cls = "") => `<tr class="${cls}"><td>${l}</td><td class="n">${v}</td></tr>`;
  const items = r.items.map((i) => `<tr><td>${i.quantity} × ${esc(i.name)}${i.discount > 0 ? `<small>${usd(i.unit_price)} less ${usd(i.discount)} each</small>` : ""}${r.sales_tax > 0 && !i.taxed ? "<small>No sales tax</small>" : ""}</td><td class="n">${usd(i.line_total)}</td></tr>`).join("");
  const taxLabel = `Sales tax${r.tax_rate ? ` (${(r.tax_rate / 100).toFixed(2).replace(/\.?0+$/, "")}%)` : ""}`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Receipt · ${esc(r.merchant.name)}</title>
<style>:root{color-scheme:light dark}body{margin:0;font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;background:#f7f6ef;color:#20221f}main{max-width:420px;margin:0 auto;padding:28px 20px 48px}
h1{font-size:22px;margin:0 0 2px}p{margin:0;color:#71736a}table{width:100%;border-collapse:collapse;margin:18px 0}td{padding:6px 0;vertical-align:top}td.n{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}small{display:block;color:#71736a;font-size:12px}
tr.sep td{border-top:1px solid #dddfd3;padding-top:10px}tr.total td{font-weight:700;font-size:17px;border-top:2px solid #20221f;padding-top:10px}.ref{color:#71736a;font-size:12px;word-break:break-all}.refund td{color:#8a5a00}
@media(prefers-color-scheme:dark){body{background:#161714;color:#f1f0e8}p,small,.ref{color:#a2a498}tr.sep td{border-color:#34362f}tr.total td{border-color:#f1f0e8}.refund td{color:#e3b24a}}</style></head><body><main>
<h1>${esc(r.merchant.name)}</h1>${r.merchant.legal_name && r.merchant.legal_name !== r.merchant.name ? `<p>${esc(r.merchant.legal_name)}</p>` : ""}${r.merchant.address ? `<p>${esc(r.merchant.address)}</p>` : ""}<p>${esc(when)}${r.reference ? ` · Order ${esc(r.reference)}` : ""}</p>
<table>${items}
${r.items.length ? row("Subtotal", usd(r.subtotal), "sep") : ""}
${r.sales_tax > 0 ? (r.tax_included ? row(`${taxLabel} included`, usd(r.sales_tax)) : row(taxLabel, usd(r.sales_tax))) : ""}
${r.tip > 0 ? row("Tip", usd(r.tip)) : ""}
${row("Total", usd(r.total), "total")}
${row(`Paid with ${r.tender}`, "", "")}
${r.refunds.map((x) => row(`Refund ${esc(new Date(x.date).toLocaleDateString("en-US", { dateStyle: "medium", timeZone: "America/New_York" }))}${x.tax > 0 ? `<small>includes ${usd(x.tax)} sales tax</small>` : ""}`, "−" + usd(x.amount), "refund")).join("")}
</table><p class="ref">Receipt ${esc(r.id)}</p></main></body></html>`;
}
