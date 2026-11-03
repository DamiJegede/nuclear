// The tab allocation engine (lib/tabQuote.ts): pure, so it is tested on its own with fixed cases and a lot of random ones.
import { apportion, quoteTab, ceilingFor, type QInput, type QItem, type QMember } from "../src/lib/tabQuote.ts";
let pass = 0, fail = 0;
const eq = (l: string, g: unknown, w: unknown) => { const ok = JSON.stringify(g) === JSON.stringify(w); ok ? pass++ : fail++; if (!ok) console.log("FAIL", l, `got ${JSON.stringify(g)} want ${JSON.stringify(w)}`); };
const ok = (l: string, v: boolean) => eq(l, v, true);
let seed = 12345;
const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
const ri = (a: number, b: number) => a + Math.floor(rnd() * (b - a + 1));

// ---- apportion
eq("apportion shares exactly", apportion(100, [1, 1, 1]), [34, 33, 33]);
eq("apportion by weight", apportion(10, [50, 30, 20]), [5, 3, 2]);
eq("ties go to the earlier index", apportion(1, [1, 1]), [1, 0]);
eq("zero total", apportion(0, [3, 4]), [0, 0]);
for (let k = 0; k < 500; k++) { const ws = Array.from({ length: ri(1, 7) }, () => ri(0, 5000) + 1); const t = ri(0, 100000); const o = apportion(t, ws); ok("apportion adds up " + k, o.reduce((s, x) => s + x, 0) === t && o.every((x) => x >= 0)); }

// ---- scenario builder
const W = ["a", "b", "c", "d"].map((x, i) => `0000000${i + 1}-0000-7000-8000-00000000000${i + 1}`);
const member = (i: number, o: Partial<QMember> = {}): QMember => ({ wallet_id: W[i]!, account_id: "acc-" + i, max_tip_bps: 2500, hold: 0, removed: false, ...o });
// tax: one rounding over every line, shared by largest remainder (what app_tax does)
function priced(raw: { w: number | null; price: number; qty: number; taxable?: boolean; discount?: number }[], rate: number, included: boolean): QItem[] {
  const net = raw.map((r) => (r.price - (r.discount ?? 0)) * r.qty);
  const tx = raw.map((r) => (r.taxable ?? true) && rate > 0);
  const taxable = net.reduce((s, n, i) => s + (tx[i] ? n : 0), 0);
  const d = included ? 10000 + rate : 10000;
  const total = rate === 0 ? 0 : Math.floor((taxable * rate * 2 + d) / (2 * d));
  const sh = apportion(total, net.map((n, i) => (tx[i] ? n : 0)));
  return raw.map((r, i) => ({ id: "i" + i, wallet_id: r.w === null ? null : W[r.w]!, product_id: null, name: "Item " + i, unit_price: r.price, discount: r.discount ?? 0, quantity: r.qty, taxable: r.taxable ?? true, tax: sh[i]!, tax_rate: tx[i] ? rate : 0, tax_included: included }));
}
const base = (o: Partial<QInput>): QInput => ({ mode: "own", cover_cap: null, host_wallet_id: W[0]!, tax_included: false, tax_rate: 0, tip: { mode: "none", value: 0 }, served_by: "staff-1", table_name: "Table 4", items: [], members: [member(0), member(1), member(2)], covers: [], ...o });

// ---- Own Tab: everyone pays their own items, tax and tip share
{
  const items = priced([{ w: 0, price: 1000, qty: 1 }, { w: 1, price: 2000, qty: 1 }, { w: 2, price: 3000, qty: 1 }], 1000, false); // 10% tax
  const q = quoteTab(base({ items, tip: { mode: "percent", value: 2000 } }));   // 20% tip
  eq("own: three payers with their own totals plus tax and tip", q.payers.map((p) => [p.total, p.tip, p.amount]), [[1100, 200, 1300], [2200, 400, 2600], [3300, 600, 3900]]);
  eq("own: bill is the sum", q.bill, 7800);
  eq("own: nothing short", q.short_total, 0);
  ok("own: real lines go with the payer", q.payers.every((p) => p.lines.length === 1 && p.lines[0]!.product_id === null && p.lines[0]!.name.startsWith("Item")));
  eq("own: the tip goes to the server", q.payers[0]!.tips, [{ staff_account_id: "staff-1", amount: 200 }]);
  eq("the hold a member needs: total plus the tip at their own limit (25% of 1000)", ceilingFor(q, W[0]!, 2500), 1100 + 250);
}
// ---- the Table is the host's unless covered
{
  const items = priced([{ w: 1, price: 1000, qty: 1 }, { w: null, price: 500, qty: 1 }], 0, false);
  const q = quoteTab(base({ items }));
  eq("table items are paid by the host", q.payers.map((p) => [p.wallet_id === W[0] ? "host" : "other", p.total, p.for]), [["host", 500, ["table"]], ["other", 1000, []]]);
  const q2 = quoteTab(base({ items, covers: [{ covered_wallet_id: null, payer_wallet_id: W[2]!, cap: null }] }));
  eq("a member covers the Table", q2.payers.map((p) => [p.wallet_id, p.total]), [[W[1], 1000], [W[2], 500]]);
}
// ---- Cover: whole bill, and a limit that binds
{
  const items = priced([{ w: 0, price: 1000, qty: 1 }, { w: 1, price: 2000, qty: 1 }], 1000, false);
  const q = quoteTab(base({ items, covers: [{ covered_wallet_id: W[1]!, payer_wallet_id: W[0]!, cap: null }] }));
  eq("cover: one payer pays both bills with the real lines", [q.payers.length, q.payers[0]!.total, q.payers[0]!.lines.length, q.payers[0]!.for], [1, 3300, 2, [W[1]]]);
  const q2 = quoteTab(base({ items, covers: [{ covered_wallet_id: W[1]!, payer_wallet_id: W[0]!, cap: 1500 }] }));
  eq("cover with a limit that binds: the coverer pays 1500 of the 2200, the person the rest, both as shares", q2.payers.map((p) => [p.wallet_id === W[0] ? "coverer" : "person", p.amount]), [["coverer", 1100 + 1500], ["person", 700]]);
  ok("the shares carry the tax between them", q2.payers.reduce((s, p) => s + p.sales_tax, 0) === 300);
  ok("a limit above the bill changes nothing", quoteTab(base({ items, covers: [{ covered_wallet_id: W[1]!, payer_wallet_id: W[0]!, cap: 99999 }] })).payers.length === 1);
}
// ---- On Me
{
  const items = priced([{ w: 1, price: 1000, qty: 1 }, { w: 2, price: 2000, qty: 1 }], 0, false);
  const q = quoteTab(base({ mode: "host", items }));
  eq("on me: the host pays everyone's items", q.payers.map((p) => [p.wallet_id, p.total]), [[W[0], 3000]]);
  const q2 = quoteTab(base({ mode: "host", items, cover_cap: 1500 }));
  eq("on me with a per-person limit: the host pays up to 1500 each", q2.payers.map((p) => [p.wallet_id, p.amount]), [[W[0], 1000 + 1500], [W[2], 500]]);
}
// ---- Equal Shares
{
  const items = priced([{ w: 0, price: 1000, qty: 1 }, { w: 1, price: 1000, qty: 1 }, { w: 2, price: 1001, qty: 1 }], 825, false);
  const q = quoteTab(base({ mode: "equal", items, tip: { mode: "amount", value: 301 }, members: [member(0), member(1), member(2)] }));
  const T = q.bill;
  eq("equal: the bill is split between everyone, to the cent", q.payers.reduce((s, p) => s + p.amount, 0), T);
  ok("equal: amounts differ by at most a few cents", Math.max(...q.payers.map((p) => p.amount)) - Math.min(...q.payers.map((p) => p.amount)) <= 2);
  ok("equal: share lines, not item lines", q.payers.every((p) => p.lines.every((l) => l.product_id === null && l.quantity === 1)));
  const q2 = quoteTab(base({ mode: "equal", items, members: [member(0), member(1), member(2), member(3, { removed: true })] }));
  eq("equal: a removed member pays nothing", q2.payers.length, 3);
  const q3 = quoteTab(base({ mode: "equal", items, covers: [{ covered_wallet_id: W[2]!, payer_wallet_id: W[0]!, cap: null }] }));
  eq("equal with a cover: the coverer pays two shares", [q3.payers.length, q3.payers[0]!.for], [2, [W[2]]]);
  const q4 = quoteTab(base({ mode: "equal", items, members: [member(0, { hold: 500 }), member(1, { hold: 99999 }), member(2)] }));
  eq("equal: a ceiling below the share is a known shortfall", q4.short.map((s) => s.wallet_id), [W[0]]);
}
// ---- Pitch In
{
  const items = priced([{ w: 0, price: 3000, qty: 1 }], 0, false);
  const q = quoteTab(base({ mode: "pitch", items, members: [member(0, { hold: 1000 }), member(1, { hold: 500 }), member(2)] }));
  eq("pitch: pledges below the bill are short by the difference", [q.short_total, q.payers.map((p) => p.amount)], [1500, [1000, 500]]);
  const q2 = quoteTab(base({ mode: "pitch", items, members: [member(0, { hold: 3000 }), member(1, { hold: 3000 }), member(2)] }));
  eq("pitch: pledges above the bill are cut in proportion and add up exactly", [q2.short_total, q2.payers.map((p) => p.amount)], [0, [1500, 1500]]);
  ok("pitch: nobody pays more than their pledge", quoteTab(base({ mode: "pitch", items: priced([{ w: 0, price: 1001, qty: 1 }], 825, false), members: [member(0, { hold: 700 }), member(1, { hold: 701 }), member(2, { hold: 333 })] })).payers.every((p) => p.amount <= p.hold));
}
// ---- the tip is clipped at a member's own limit
{
  const items = priced([{ w: 0, price: 1000, qty: 1 }, { w: 1, price: 1000, qty: 1 }], 0, false);
  const q = quoteTab(base({ items, tip: { mode: "percent", value: 3000 }, members: [member(0, { max_tip_bps: 1000 }), member(1), member(2)] }));
  eq("a 30% tip: clipped to each member's own limit (10% and the default 25%)", q.payers.map((p) => [p.tip, p.tip_clipped]), [[100, true], [250, true]]);
}
// ---- included tax: the price already contains it
{
  const items = priced([{ w: 0, price: 1100, qty: 1 }], 1000, true);
  const q = quoteTab(base({ items, tax_included: true, tax_rate: 1000 }));
  eq("included tax: the total is the price, the tax is inside it", [q.payers[0]!.total, q.payers[0]!.sales_tax], [1100, 100]);
}
// ---- random scenarios: whatever the mode, the payments add up exactly to the tab
for (let k = 0; k < 600; k++) {
  const nm = ri(2, 4), mode = (["own", "host", "equal", "pitch"] as const)[ri(0, 3)]!, rate = [0, 825, 1000, 1999][ri(0, 3)]!, inc = rnd() < 0.3 && rate > 0;
  const raw = Array.from({ length: ri(1, 8) }, () => ({ w: rnd() < 0.15 ? null : ri(0, nm - 1), price: ri(1, 5000), qty: ri(1, 3), taxable: rnd() < 0.8, discount: rnd() < 0.2 ? 1 : 0 }));
  const items = priced(raw, rate, inc);
  const members = Array.from({ length: nm }, (_, i) => member(i));
  const covers = rnd() < 0.4 && nm >= 2 && (mode === "own" || mode === "equal") ? [{ covered_wallet_id: W[1]!, payer_wallet_id: W[0]!, cap: rnd() < 0.5 ? null : ri(1, 4000) }] : [];
  const tip = rnd() < 0.5 ? { mode: "percent" as const, value: ri(0, 3000) } : { mode: "amount" as const, value: ri(0, 900) };
  let q;
  if (mode === "pitch") {
    const T0 = quoteTab(base({ mode: "equal", items, members, tip, tax_rate: rate, tax_included: inc })).bill;
    const pm = members.map((m) => ({ ...m, hold: rnd() < 0.8 ? ri(1, Math.max(2, Math.ceil((T0 * 2) / nm))) : 0 }));
    q = quoteTab(base({ mode, items, members: pm, tip, tax_rate: rate, tax_included: inc, covers: [] }));
    const P = pm.reduce((s, m) => s + m.hold, 0);
    eq("pitch: short_total is the shortage " + k, q.short_total, Math.max(0, T0 - P));
    ok("pitch: never above a pledge " + k, q.payers.every((p) => p.amount <= p.hold + (p.tip_clipped ? 0 : 0)));
    continue;
  }
  q = quoteTab(base({ mode, items, members, covers, tip, tax_rate: rate, tax_included: inc, cover_cap: rnd() < 0.3 ? ri(1, 3000) : null }));
  const payerNet = q.payers.reduce((s, p) => s + p.lines.reduce((a, l) => a + (l.unit_price - l.discount) * l.quantity, 0), 0);
  eq("net adds up " + k + " " + mode, payerNet, q.items);
  eq("tax adds up " + k + " " + mode, q.payers.reduce((s, p) => s + p.sales_tax, 0), q.tax);
  const clipped = q.payers.some((p) => p.tip_clipped);
  const tipSum = q.payers.reduce((s, p) => s + p.tip, 0);
  ok("tip adds up unless clipped " + k + " " + mode, clipped ? tipSum <= q.tip : tipSum === q.tip);
  ok("every amount is positive and equals total plus tip " + k, q.payers.every((p) => p.amount > 0 && p.amount === p.total + p.tip));
  if (!clipped) eq("the payments add up to the bill " + k + " " + mode, q.payers.reduce((s, p) => s + p.amount, 0), q.bill);
}
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
