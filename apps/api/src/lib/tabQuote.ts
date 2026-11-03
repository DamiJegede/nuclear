/**
 * The allocation of a tab's bill to paying wallets (docs/TABS.md, "The allocation engine"). Pure: no database, no clock. The routes read the tab, run this, show the result
 * to everyone and pass it to the SQL function app_close_tab, which checks the tab's version under its lock, so what people saw is what is charged.
 *
 * Money is whole cents as JS numbers (bounded far below 2^53); only the largest-remainder products use BigInt.
 */

export type QItem = {
  id: string;
  wallet_id: string | null;       // NULL = the Table
  product_id: string | null;
  name: string;
  unit_price: number;
  discount: number;
  quantity: number;
  taxable: boolean;
  tax: number;                    // this line's share of the tab's tax (from app_tax over every line, one rounding)
  tax_rate: number;
  tax_included: boolean;
};
export type QMember = { wallet_id: string; account_id: string; max_tip_bps: number; hold: number; removed: boolean };
export type QCover = { covered_wallet_id: string | null; payer_wallet_id: string; cap: number | null };
export type TabMode = "own" | "pitch" | "equal" | "host";
export type QInput = {
  mode: TabMode;
  cover_cap: number | null;       // On Me: the most the host pays per person
  host_wallet_id: string;
  tax_included: boolean;
  tax_rate: number;
  tip: { mode: "none" | "percent" | "amount"; value: number };
  served_by: string | null;
  table_name: string | null;
  items: QItem[];                 // non-void items only
  members: QMember[];
  covers: QCover[];               // active covers only (not declined, not ended)
};
export type QLine = {
  id: string; product_id: string | null; name: string; unit_price: number; discount: number; quantity: number;
  taxable: boolean; tax_rate: number; tax_included: boolean; tax: number;
};
export type QPayer = {
  wallet_id: string;
  account_id: string;
  amount: number;                 // what the payer pays: total + tip
  total: number;                  // the checkout's total (the lines, plus the tax when it is added on top)
  sales_tax: number;
  tip: number;
  tip_clipped: boolean;
  lines: QLine[];
  tips: { staff_account_id: string; amount: number }[];
  for: string[];                  // wallet ids (or "table") whose bills this payer pays for, besides its own
  hold: number;
};
export type Quote = {
  payers: QPayer[];
  bill: number;                   // the tab's whole bill (items, tax added on top, tip)
  items: number;
  tax: number;
  tip: number;                    // the tip as set (before any clipping)
  bills: Record<string, number>;  // each orderer's own bill (wallet id, or "table"): items, tax when added, their tip share
  short: { wallet_id: string | null; amount: number }[];
  short_total: number;
  tip_needs_server: boolean;
};

/** Largest remainder: `total` shared over `weights` in whole units that add up exactly; ties go to the earlier index. */
export function apportion(total: number, weights: number[]): number[] {
  const n = weights.length;
  const out = new Array<number>(n).fill(0);
  const W = weights.reduce((s, w) => s + w, 0);
  if (n === 0 || total <= 0) return out;
  if (W <= 0) throw new Error("cannot apportion over zero weight");
  const T = BigInt(total), Wb = BigInt(W);
  const rem: bigint[] = [];
  let used = 0;
  for (let i = 0; i < n; i++) {
    const p = T * BigInt(weights[i]!);
    out[i] = Number(p / Wb);
    rem.push(p % Wb);
    used += out[i]!;
  }
  let left = total - used;
  const order = rem.map((r, i) => [r, i] as const).filter(([, i]) => weights[i]! > 0).sort((a, b) => (a[0] === b[0] ? a[1] - b[1] : a[0] > b[0] ? -1 : 1));
  for (let k = 0; left > 0 && order.length > 0; k = (k + 1) % order.length) { out[order[k]![1]]!++; left--; }
  return out;
}

type Comp = { taxable: number; exempt: number; tax: number; tip: number };
type Acc = { real: QLine[]; taxable: number; exempt: number; tax: number /* tax of the share lines only */; tip: number; fors: Set<string> };

const lineNet = (l: { unit_price: number; discount: number; quantity: number }) => (l.unit_price - l.discount) * l.quantity;
const toLine = (i: QItem): QLine => ({
  id: i.id, product_id: i.product_id, name: i.name, unit_price: i.unit_price, discount: i.discount, quantity: i.quantity,
  taxable: i.taxable, tax_rate: i.tax_rate, tax_included: i.tax_included, tax: i.tax,
});

/** Cut a pool of money (net taxable, net exempt, tax, tip) between payers whose totals are `amounts` (which add up to the pool's bill). */
function shareOut(c: Comp, amounts: number[], addedTax: boolean): Comp[] {
  const tip = apportion(c.tip, amounts);
  const tax = apportion(c.tax, amounts);
  const net = amounts.map((a, i) => {
    let nt = a - tip[i]! - (addedTax ? tax[i]! : 0);
    if (nt < 0) { tip[i] = Math.max(0, tip[i]! + nt); nt = a - tip[i]! - (addedTax ? tax[i]! : 0); if (nt < 0) { tax[i] = Math.max(0, tax[i]! + nt); nt = Math.max(0, a - tip[i]! - (addedTax ? tax[i]! : 0)); } }
    return nt;
  });
  const taxable = net.some((x) => x > 0) ? apportion(c.taxable, net) : net.map(() => 0);
  return amounts.map((_, i) => {
    const tx = Math.min(taxable[i]!, net[i]!);
    // a payer with no taxable money carries no tax line; its tax rides on the exempt money (an exceptional one-cent rounding)
    const taxHere = tx > 0 ? tax[i]! : 0;
    const lost = tx > 0 ? 0 : (addedTax ? tax[i]! : 0);
    return { taxable: tx, exempt: net[i]! - tx + lost, tax: taxHere, tip: tip[i]! };
  });
}

export function quoteTab(inp: QInput, newId: () => string = () => crypto.randomUUID()): Quote {
  const addedTax = !inp.tax_included;
  const members = inp.members.filter((m) => !m.removed).sort((a, b) => (a.wallet_id < b.wallet_id ? -1 : 1));
  const byWallet = new Map(inp.members.map((m) => [m.wallet_id, m] as const));
  const TABLE = "table";

  // ---- atoms: one per orderer (a member, or the Table)
  const keys = [...new Set([...inp.items.map((i) => i.wallet_id ?? TABLE)])].sort((a, b) => (a === TABLE ? 1 : b === TABLE ? -1 : a < b ? -1 : 1));
  const lines = new Map<string, QItem[]>(keys.map((k) => [k, inp.items.filter((i) => (i.wallet_id ?? TABLE) === k)]));
  const comp = new Map<string, Comp & { net: number; lines: QLine[] }>();
  for (const k of keys) {
    const its = lines.get(k)!;
    const c = { taxable: 0, exempt: 0, tax: 0, tip: 0, net: 0, lines: its.map(toLine) };
    for (const i of its) { const nt = lineNet(i); c.net += nt; if (i.tax_rate > 0 && i.taxable) c.taxable += nt; else c.exempt += nt; c.tax += i.tax; }
    comp.set(k, c);
  }
  const items = [...comp.values()].reduce((s, c) => s + c.net, 0);
  const taxTotal = [...comp.values()].reduce((s, c) => s + c.tax, 0);
  const tipTotal = inp.tip.mode === "none" ? 0 : inp.tip.mode === "amount" ? inp.tip.value : Math.floor((items * inp.tip.value * 2 + 10000) / 20000);
  const tipShares = apportion(tipTotal, keys.map((k) => comp.get(k)!.net));
  keys.forEach((k, i) => { comp.get(k)!.tip = tipShares[i]!; });
  const bill = (k: string) => { const c = comp.get(k)!; return c.net + (addedTax ? c.tax : 0) + c.tip; };
  const billTotal = keys.reduce((s, k) => s + bill(k), 0);

  // ---- who pays: accumulators per payer wallet
  const acc = new Map<string, Acc>();
  const accOf = (w: string) => { let a = acc.get(w); if (!a) { a = { real: [], taxable: 0, exempt: 0, tax: 0, tip: 0, fors: new Set() }; acc.set(w, a); } return a; };
  const poolComp = (): Comp => keys.reduce<Comp>((s, k) => { const c = comp.get(k)!; return { taxable: s.taxable + c.taxable, exempt: s.exempt + c.exempt, tax: s.tax + c.tax, tip: s.tip + c.tip }; }, { taxable: 0, exempt: 0, tax: 0, tip: 0 });
  const addShare = (w: string, s: Comp) => { const a = accOf(w); a.taxable += s.taxable; a.exempt += s.exempt; a.tax += s.tax; a.tip += s.tip; };
  const coverOf = (k: string) => inp.covers.find((c) => (c.covered_wallet_id ?? TABLE) === k);
  let pitchShort = 0;

  if (inp.mode === "own" || inp.mode === "host") {
    for (const k of keys) {
      const c = comp.get(k)!;
      const b = bill(k);
      if (b <= 0) continue;
      const own = k === TABLE ? inp.host_wallet_id : k;
      let payer = own, cap: number | null = null;
      if (inp.mode === "host") { payer = inp.host_wallet_id; cap = k === TABLE || k === inp.host_wallet_id ? null : inp.cover_cap; }
      else { const cv = coverOf(k); if (cv) { payer = cv.payer_wallet_id; cap = cv.cap; } }
      // a whole bill moves: the real lines go with it and carry their own tax
      const whole = (to: string) => { const a = accOf(to); a.real.push(...c.lines); a.tip += c.tip; if (k !== to) a.fors.add(k); };
      if (payer === own || cap === null || cap >= b) { whole(payer); continue; }
      // a limit that binds: the coverer pays `cap`, the person (or the host for the Table) pays the rest, both as shares of this bill
      const parts = shareOut(c, [cap, b - cap], addedTax);
      addShare(payer, parts[0]!); accOf(payer).fors.add(k);
      addShare(own, parts[1]!);
    }
  } else {
    let amounts: { w: string; a: number }[] = [];
    if (inp.mode === "equal") {
      if (members.length === 0) throw new Error("no members");
      const eq = apportion(billTotal, members.map(() => 1));
      const m = new Map(members.map((x, i) => [x.wallet_id, eq[i]!] as const));
      for (const cv of inp.covers) {
        if (cv.covered_wallet_id === null || !m.has(cv.covered_wallet_id) || !m.has(cv.payer_wallet_id)) continue;
        const a = m.get(cv.covered_wallet_id)!;
        const mv = cv.cap === null ? a : Math.min(cv.cap, a);
        m.set(cv.covered_wallet_id, a - mv); m.set(cv.payer_wallet_id, m.get(cv.payer_wallet_id)! + mv);
        accOf(cv.payer_wallet_id).fors.add(cv.covered_wallet_id);
      }
      amounts = [...m.entries()].map(([w, a]) => ({ w, a }));
    } else {
      const pledges = members.filter((x) => x.hold > 0);
      const P = pledges.reduce((s, x) => s + x.hold, 0);
      if (P >= billTotal) {
        const sh = apportion(billTotal, pledges.map((x) => x.hold));
        amounts = pledges.map((x, i) => ({ w: x.wallet_id, a: sh[i]! }));
      } else { amounts = pledges.map((x) => ({ w: x.wallet_id, a: x.hold })); pitchShort = billTotal - P; }
    }
    amounts = amounts.filter((x) => x.a > 0);
    if (amounts.length > 0) {
      const parts = shareOut(poolComp(), amounts.map((x) => x.a), addedTax);
      amounts.forEach((x, i) => addShare(x.w, parts[i]!));
    }
  }

  // ---- finish every payer: lines, the tip clipped at the member's own limit, totals
  const payers: QPayer[] = [];
  const tipSetTo = inp.served_by;
  const rate = inp.tax_rate;
  for (const [w, a] of [...acc.entries()].sort((x, y) => (x[0] < y[0] ? -1 : 1))) {
    const m = byWallet.get(w);
    if (!m) throw new Error("payer is not a member");
    const ls: QLine[] = [...a.real];
    if (a.taxable > 0) ls.push({ id: newId(), product_id: null, name: `Share of ${inp.table_name ?? "tab"} (taxable)`, unit_price: a.taxable, discount: 0, quantity: 1, taxable: true, tax_rate: rate, tax_included: inp.tax_included, tax: a.tax });
    if (a.exempt > 0) ls.push({ id: newId(), product_id: null, name: `Share of ${inp.table_name ?? "tab"}`, unit_price: a.exempt, discount: 0, quantity: 1, taxable: false, tax_rate: 0, tax_included: inp.tax_included, tax: 0 });
    const net = ls.reduce((s, l) => s + lineNet(l), 0);
    const salesTax = ls.reduce((s, l) => s + l.tax, 0);
    const total = net + (addedTax ? salesTax : 0);
    if (total <= 0) continue;
    const cap = Math.floor((m.max_tip_bps * net) / 10000);
    const tip = Math.min(a.tip, cap);
    payers.push({
      wallet_id: w, account_id: m.account_id, amount: total + tip, total, sales_tax: salesTax, tip, tip_clipped: tip < a.tip, lines: ls,
      tips: tip > 0 && tipSetTo ? [{ staff_account_id: tipSetTo, amount: tip }] : [], for: [...a.fors].filter((x) => x !== w), hold: m.hold,
    });
  }

  // ---- what is known to be short: a closed position whose hold is below its amount, or a Pitch In whose pledges do not cover the bill
  const short: { wallet_id: string | null; amount: number }[] = [];
  if (inp.mode === "pitch") { if (pitchShort > 0) short.push({ wallet_id: null, amount: pitchShort }); }
  else for (const p of payers) if (p.hold > 0 && p.hold < p.amount) short.push({ wallet_id: p.wallet_id, amount: p.amount - p.hold });
  return {
    payers, bill: billTotal, items, tax: taxTotal, tip: tipTotal, bills: Object.fromEntries(keys.map((k) => [k, bill(k)])), short, short_total: short.reduce((s, x) => s + x.amount, 0),
    tip_needs_server: payers.some((p) => p.tip > 0) && !tipSetTo,
  };
}

/** The hold a member needs to close their position in Own Tab / On Me: what they would pay now, with the tip at their own limit. */
export function ceilingFor(q: Quote, walletId: string, maxTipBps: number): number {
  const p = q.payers.find((x) => x.wallet_id === walletId);
  if (!p) return 0;
  const net = p.lines.reduce((s, l) => s + lineNet(l), 0);
  return p.total + Math.floor((maxTipBps * net) / 10000);
}
