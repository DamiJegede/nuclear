import { useCallback, useEffect, useState, type ReactNode } from "react";
import { RefreshButton } from "./RefreshButton";
import type { Api, DayRange, TxKind, TxPage, TxRow } from "../api";
import { int, money } from "../format";
import { peek, put } from "../cache";
import { usePageTitle } from "../title";

const KINDS: { kind: TxKind; label: string }[] = [
  { kind: "all", label: "All" }, { kind: "payments", label: "Payments" }, { kind: "refunds", label: "Refunds" }, { kind: "pending", label: "Awaiting Approval" },
];

// ---- periods (program days, America/New_York, so they match what the API counts) ---------------------
export type Period = "all" | "today" | "yesterday" | "7d" | "30d" | "month" | "last-month" | "custom";
export const PERIODS: { value: Period; label: string }[] = [
  { value: "all", label: "All Time" }, { value: "today", label: "Today" }, { value: "yesterday", label: "Yesterday" },
  { value: "7d", label: "Last 7 Days" }, { value: "30d", label: "Last 30 Days" },
  { value: "month", label: "This Month" }, { value: "last-month", label: "Last Month" }, { value: "custom", label: "Custom Range" },
];
const nyDate = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
const addDays = (day: string, n: number) => { const t = new Date(day + "T00:00:00Z"); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };

/** The inclusive range of program dates for a period; `custom` uses what was typed. */
export function periodRange(period: Period, custom: { from: string; to: string }, now: Date = new Date()): DayRange {
  const today = nyDate(now);
  switch (period) {
    case "all": return {};
    case "today": return { from: today, to: today };
    case "yesterday": return { from: addDays(today, -1), to: addDays(today, -1) };
    case "7d": return { from: addDays(today, -6), to: today };
    case "30d": return { from: addDays(today, -29), to: today };
    case "month": return { from: today.slice(0, 8) + "01", to: today };
    case "last-month": { const first = today.slice(0, 8) + "01"; return { from: addDays(first, -1).slice(0, 8) + "01", to: addDays(first, -1) }; }
    case "custom": return { ...(custom.from ? { from: custom.from } : {}), ...(custom.to ? { to: custom.to } : {}) };
  }
}

/** Row tint: failed pink; pending refunds light yellow, completed refunds a lighter yellow. */
const rowTone = (type: string, status: string) => (status === "failed" ? "fail-row" : type === "refund" ? (status === "pending" ? "refund-row" : "refund-done-row") : "");

/** A row that opens on click (or Enter) to show the transaction id, status and reason, and who paid whom. */
function TxRowPair({ tx, cols, children }: { tx: TxRow; cols: number; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const tone = rowTone(tx.type, tx.status);
  const toggle = () => setOpen((o) => !o);
  return (
    <>
      <tr className={`${tone} tx-row`} tabIndex={0} aria-expanded={open} onClick={toggle} onKeyDown={(e) => { if ((e.key === "Enter" || e.key === " ") && e.target === e.currentTarget) { e.preventDefault(); toggle(); } }}>{children}</tr>
      <tr className={`${tone} tx-detail${open ? " open" : ""}`} aria-hidden={!open}>
        <td colSpan={cols}>
          <div className="tx-collapse"><div className="tx-inner">
            <p className="tx-line">Transaction ID: <span className="tx-id">{tx.id}</span> • <span className="tx-status">{tx.status.toUpperCase()}</span>{tx.status_code ? <> › <span className="tx-code">{tx.status_code}</span></> : null}{tx.served_by ? <> • Served by {tx.served_by}</> : null}{tx.receipt_url ? <> • <a href={tx.receipt_url} target="_blank" rel="noopener noreferrer">Receipt</a></> : null}</p>
            {tx.original && (
              <div className="tx-orig">
                <p className="tx-orig-title">Original payment</p>
                <p className="tx-orig-line"><strong>{money(tx.original.amount)}</strong>{tx.original.tip > 0 && <span className="muted"> incl. {money(tx.original.tip)} tip</span>} · {new Date(tx.original.timestamp).toLocaleString()}{tx.original.via && <> · {tx.original.via === "tap" ? "Tap" : tx.original.via === "pass" ? "Pass" : "App"}</>}{tx.original.served_by && <> · Served by {tx.original.served_by}</>}{tx.original.reference && <> · {tx.original.reference}</>}</p>
                <p className="tx-orig-line muted">Transaction ID: <span className="tx-id">{tx.original.id}</span></p>
              </div>
            )}
            <p className="tx-parties"><span className="tx-party">{tx.from ?? "—"}</span><span className="tx-arrow" aria-hidden>›</span><span className="tx-party">{tx.to ?? "—"}</span></p>
          </div></div>
        </td>
      </tr>
    </>
  );
}

/** The business's payments and refunds, with filters, a period, totals and openable rows. */
export function Transactions({ api, onError }: { api: Api; onError: (e: unknown) => void }) {
  usePageTitle("Transactions");
  const [kind, setKind] = useState<TxKind>("all");
  const [period, setPeriod] = useState<Period>("all");
  const [custom, setCustom] = useState({ from: "", to: "" });
  const range = periodRange(period, custom);
  const rangeKey = `${range.from ?? ""}|${range.to ?? ""}`;
  const badRange = period === "custom" && !!custom.from && !!custom.to && custom.from > custom.to;
  const [rows, setRows] = useState<TxRow[] | null>(null);
  const [counts, setCounts] = useState<TxPage["counts"] | null>(null);
  const [totals, setTotals] = useState<TxPage["totals"] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [more, setMore] = useState(false);

  const load = useCallback(async (k: TxKind, r: DayRange, force = false) => {
    const key = `tx:${k}|${r.from ?? ""}|${r.to ?? ""}`;
    const hit = force ? undefined : peek<TxPage>(key);
    if (hit) { setRows(hit.transactions); setCounts(hit.counts); setTotals(hit.totals); setNext(hit.next_cursor); setFailed(false); return; }   // back to a page already seen: no request
    setRows(null);
    try { const p = await api.transactions(k, undefined, r); put(key, p); setRows(p.transactions); setCounts(p.counts); setTotals(p.totals); setNext(p.next_cursor); setFailed(false); }
    catch (e) { setFailed(true); onError(e); }
  }, [api, onError]);
  useEffect(() => {
    if (badRange) return;
    const [from, to] = rangeKey.split("|");
    void load(kind, { ...(from ? { from } : {}), ...(to ? { to } : {}) });
  }, [kind, rangeKey, badRange, load]);

  async function loadMore() {
    if (!next) return;
    setMore(true);
    try { const p = await api.transactions(kind, next, range); setRows((r) => [...(r ?? []), ...p.transactions]); setNext(p.next_cursor); }
    catch (e) { onError(e); } finally { setMore(false); }
  }

  return (
    <section>
      <div className="head"><h1>Transactions</h1><div className="head-actions"><RefreshButton onClick={() => { if (!badRange) void load(kind, range, true); }} /></div></div>
      <div className="period-bar">
        <label className="period-field"><span className="sr-only">Period</span>
          <select value={period} onChange={(e) => setPeriod(e.target.value as Period)}>{PERIODS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}</select>
        </label>
        {period === "custom" && (
          <>
            <label className="period-field">From<input type="date" value={custom.from} max={custom.to || undefined} onChange={(e) => setCustom((c) => ({ ...c, from: e.target.value }))} /></label>
            <label className="period-field">To<input type="date" value={custom.to} min={custom.from || undefined} onChange={(e) => setCustom((c) => ({ ...c, to: e.target.value }))} /></label>
          </>
        )}
        {totals && !badRange && (
          <p className="period-totals" role="status">
            <strong>{int(totals.payments.count)}</strong> payments · <strong>{money(totals.payments.volume)}</strong>
            {totals.refunds.count > 0 && <span className="muted"> · {int(totals.refunds.count)} refunds · {money(totals.refunds.volume)}</span>}
          </p>
        )}
      </div>
      {badRange && <p className="error" role="alert">The start date is after the end date.</p>}
      <div className="choice-grid kind-grid four" role="radiogroup" aria-label="Show">
        {KINDS.map(({ kind: k, label }) => (
          <label key={k} className="choice kind">
            <input type="radio" name="tx-kind" value={k} checked={kind === k} onChange={() => setKind(k)} />
            <span>{label}</span><span className="kind-count">{counts ? int(counts[k]) : "–"}</span>
          </label>
        ))}
      </div>
      <div className="card flush">
        {failed && !rows ? <p className="error pad" role="alert">Couldn't load transactions. <button className="link" onClick={() => void load(kind, range, true)}>Try Again</button></p>
          : !rows ? <p className="muted pad" role="status">Loading…</p>
          : rows.length === 0 ? <p className="muted pad">No transactions here yet.</p>
          : (
            <table>
              <thead><tr><th scope="col">When</th><th scope="col">Type</th><th scope="col">Customer</th><th scope="col">Terminal</th><th scope="col">Reference</th><th scope="col" className="num">Amount</th><th scope="col" className="status-col">Status</th></tr></thead>
              <tbody>
                {rows.map((t) => (
                  <TxRowPair key={t.id} tx={t} cols={7}>
                    <td className="when">{new Date(t.timestamp).toLocaleString()}</td>
                    <td><span className="pill">{t.type}</span>{t.via && <span className="pill via">{t.via}</span>}</td>
                    <td>{t.customer ?? "—"}</td>
                    <td>{t.terminal ?? "—"}</td>
                    <td>{t.reference ?? "—"}{t.approved_by && <span className="muted note">approved by {t.approved_by}</span>}</td>
                    <td className="num">{money(t.amount)}{t.tip ? <span className="muted note">incl. {money(t.tip)} tip</span> : null}</td>
                    <td className="status-col"><span className={`pill ${t.status === "completed" ? "available" : t.status === "failed" ? "closed" : "pending"}`}>{t.status}</span></td>
                  </TxRowPair>
                ))}
              </tbody>
            </table>
          )}
      </div>
      {next && <p className="more"><button type="button" className="ghost" disabled={more} onClick={() => void loadMore()}>{more ? "Loading…" : "Load More"}</button></p>}
    </section>
  );
}
