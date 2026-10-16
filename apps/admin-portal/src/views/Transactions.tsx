import { useCallback, useEffect, useState, type ReactNode } from "react";
import type { Api, DayRange, TxKind, TxPage, TxParty, TxRow } from "../api";
import { Avatar } from "./Avatar";
import { int, money } from "../format";

const KINDS: { kind: TxKind; label: string }[] = [
  { kind: "all", label: "All" }, { kind: "sends", label: "Sends" }, { kind: "taps", label: "Taps" },
  { kind: "funds", label: "Funds" }, { kind: "agents", label: "Agents" },
];

// ---- periods (program days, America/New_York, so they match what the API counts) ---------------------
/** Row tint: failed is pink; pending refunds light yellow, completed refunds a lighter yellow; funding (loads) light green. */
export const rowTone = (type: string, status: string): string | undefined =>
  status === "failed" ? "fail-row" : type === "refund" ? (status === "pending" ? "refund-row" : "refund-done-row") : type === "fund" ? "fund-row" : undefined;

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
    case "last-month": {
      const first = today.slice(0, 8) + "01";
      return { from: addDays(first, -1).slice(0, 8) + "01", to: addDays(first, -1) };
    }
    case "custom": return { ...(custom.from ? { from: custom.from } : {}), ...(custom.to ? { to: custom.to } : {}) };
  }
}

/** Status pill; with `showCode` a failed row also prints its reason code under it (the main Transactions page shows it in the opened row instead). */
export function StatusCell({ status, code, showCode = false }: { status: string; code?: string | null; showCode?: boolean }) {
  return (
    <>
      <span className={`pill ${status === "completed" ? "available" : status === "failed" ? "closed" : "pending"}`}>{status}</span>
      {showCode && status === "failed" && code && <div className="fail-reason">{code}</div>}
    </>
  );
}

const pill = (status: string) => (
  <span className={`pill ${status === "completed" ? "available" : status === "failed" ? "closed" : "pending"}`}>{status}</span>
);
const party = (name: string | null, wallet: string | null) =>
  name ? <>{name}{wallet && wallet !== name ? <span className="muted note">{wallet}</span> : null}</> : "—";

/** The line under an opened row: sender > receiver, each a link to their page when the viewer may open it. */
function Party({ name, party, open }: { name: string | null; party: TxParty | null; open?: (id: string) => void }) {
  const label = name ?? "—";
  return (
    <span className="tx-party">
      <Avatar small name={label} photo={party?.photo ?? null} />
      {party && open
        ? <a href={`/${party.kind === "merchant" ? "merchants" : "users"}/${party.id}`} onClick={(e) => { e.preventDefault(); open(party.id); }}>{label}</a>
        : <span>{label}</span>}
    </span>
  );
}

type TxLike = { id: string; type: string; status: string; status_code: string | null; from: string | null; to: string | null; from_party: TxParty | null; to_party: TxParty | null };

/**
 * A transaction row that opens on click (or Enter) to show, across all columns, `Transaction ID: <id> • STATUS › reason`
 * and `sender › receiver` with small photos linking to their pages. The photos are built only after the first open.
 * Clicks on buttons and links inside the row do not toggle it.
 */
export function TxRowPair({ tx, cols, openUser, openMerchant, children }: {
  tx: TxLike; cols: number; openUser?: (id: string) => void; openMerchant?: (id: string) => void; children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [seen, setSeen] = useState(false);
  const toggle = () => { setSeen(true); setOpen((o) => !o); };
  const tone = rowTone(tx.type, tx.status) ?? "";
  return (
    <>
      <tr className={`${tone} tx-row`} tabIndex={0} aria-expanded={open}
        onClick={(e) => { if (!(e.target as HTMLElement).closest("button, a")) toggle(); }}
        onKeyDown={(e) => { if ((e.key === "Enter" || e.key === " ") && e.target === e.currentTarget) { e.preventDefault(); toggle(); } }}>
        {children}
      </tr>
      <tr className={`${tone} tx-detail${open ? " open" : ""}`} aria-hidden={!open}>
        <td colSpan={cols}>
          <div className="tx-collapse"><div className="tx-inner">
            <p className="tx-line">Transaction ID: <span className="tx-id">{tx.id}</span> • <span className="tx-status">{tx.status.toUpperCase()}</span>{tx.status_code ? <> › <span className="tx-code">{tx.status_code}</span></> : null}</p>
            {seen && (
              <p className="tx-parties">
                <Party name={tx.type === "fund" ? "Bank" : tx.from} party={tx.from_party} open={tx.from_party?.kind === "merchant" ? openMerchant : openUser} />
                <span className="tx-arrow" aria-hidden>›</span>
                <Party name={tx.to} party={tx.to_party} open={tx.to_party?.kind === "merchant" ? openMerchant : openUser} />
              </p>
            )}
          </div></div>
        </td>
      </tr>
    </>
  );
}

export function Transactions({ api, onError, openUser, openMerchant }: { api: Api; onError: (e: unknown) => void; openUser?: (id: string) => void; openMerchant?: (id: string) => void }) {
  const [kind, setKind] = useState<TxKind>("all");
  const [period, setPeriod] = useState<Period>("all");
  const [custom, setCustom] = useState({ from: "", to: "" });
  const range = periodRange(period, custom);
  const rangeKey = `${range.from ?? ""}|${range.to ?? ""}`;
  const badRange = period === "custom" && !!custom.from && !!custom.to && custom.from > custom.to;
  const [totals, setTotals] = useState<TxPage["totals"] | null>(null);
  const [rows, setRows] = useState<TxRow[] | null>(null);
  const [counts, setCounts] = useState<TxPage["counts"] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [more, setMore] = useState(false);

  const load = useCallback(async (k: TxKind, r: DayRange) => {
    setRows(null);
    try {
      const p = await api.transactions(k, undefined, r);
      setRows(p.transactions); setCounts(p.counts); setTotals(p.totals); setNext(p.next_cursor); setFailed(false);
    } catch (e) {
      setFailed(true); onError(e);
    }
  }, [api, onError]);

  useEffect(() => {
    if (badRange) return;                                   // wait for a valid range instead of asking the API
    void load(kind, { ...(rangeKey.split("|")[0] ? { from: rangeKey.split("|")[0]! } : {}), ...(rangeKey.split("|")[1] ? { to: rangeKey.split("|")[1]! } : {}) });
  }, [kind, rangeKey, badRange, load]);

  async function loadMore() {
    if (!next) return;
    setMore(true);
    try {
      const p = await api.transactions(kind, next, range);
      setRows((r) => [...(r ?? []), ...p.transactions]); setNext(p.next_cursor);
    } catch (e) {
      onError(e);
    } finally {
      setMore(false);
    }
  }

  return (
    <section>
      <div className="head"><h1>Transactions</h1></div>

      <div className="period-bar">
        <label className="period-field"><span className="sr-only">Period</span>
          <select value={period} onChange={(e) => setPeriod(e.target.value as Period)}>
            {PERIODS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
          </select>
        </label>
        {period === "custom" && (
          <>
            <label className="period-field">From<input type="date" value={custom.from} max={custom.to || undefined} onChange={(e) => setCustom((c) => ({ ...c, from: e.target.value }))} /></label>
            <label className="period-field">To<input type="date" value={custom.to} min={custom.from || undefined} onChange={(e) => setCustom((c) => ({ ...c, to: e.target.value }))} /></label>
          </>
        )}
        {totals && !badRange && (
          <p className="period-totals" role="status">
            <strong>{int(totals.completed_count)}</strong> completed · <strong>{money(totals.completed_volume)}</strong>
            {range.from || range.to ? <span className="muted"> · {range.from ?? "start"} to {range.to ?? "now"}</span> : null}
          </p>
        )}
      </div>
      {badRange && <p className="error" role="alert">The start date is after the end date.</p>}

      <div className="choice-grid kind-grid" role="radiogroup" aria-label="Show">
        {KINDS.map(({ kind: k, label }) => (
          <label key={k} className="choice kind">
            <input type="radio" name="tx-kind" value={k} checked={kind === k} onChange={() => setKind(k)} />
            <span>{label}</span>
            <span className="kind-count">{counts ? int(counts[k]) : "–"}</span>
          </label>
        ))}
      </div>

      <div className="card flush">
        {failed && !rows ? <p className="error pad" role="alert">Couldn't load transactions. <button className="link" onClick={() => void load(kind, range)}>Try Again</button></p>
          : !rows ? <p className="muted pad" role="status">Loading…</p>
          : rows.length === 0 ? <p className="muted pad">No transactions here yet.</p>
          : (
            <table>
              <thead>
                <tr>
                  <th scope="col">When</th><th scope="col">Type</th><th scope="col">From</th><th scope="col">To</th>
                  <th scope="col" className="num">Amount</th><th scope="col" className="status-col">Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((t) => (
                  <TxRowPair key={t.id} tx={t} cols={6} openUser={openUser} openMerchant={openMerchant}>
                    <td className="when">{new Date(t.timestamp).toLocaleString()}</td>
                    <td>
                      <span className="pill">{t.type}</span>
                      {t.via && <span className="pill via">{t.via}</span>}
                      {t.agent && <span className="pill via">agent</span>}
                    </td>
                    <td>{party(t.from, t.from_wallet)}</td>
                    <td>{party(t.to, t.to_wallet)}</td>
                    <td className="num">{money(t.amount)}</td>
                    <td className="status-col"><StatusCell status={t.status} /></td>
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
