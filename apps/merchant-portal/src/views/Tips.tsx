import { useCallback, useEffect, useState } from "react";
import { RefreshButton } from "./RefreshButton";
import type { Api, TipsPage } from "../api";
import { usePageTitle } from "../title";
import { money, int } from "../format";
import { PERIODS, periodRange, type Period } from "./Transactions";

/** Spreadsheet formulas in a name are defused (a leading quote), like the admin portal's payout download. */
const cell = (v: string) => `"${(/^[=+\-@\t\r]/.test(v) ? `'${v}` : v).replace(/"/g, '""')}"`;
const dayLabel = (iso: string) => new Date(`${iso}T12:00:00`).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric" });
const signed = (cents: number) => (cents < 0 ? `-${money(-cents)}` : money(cents));

/**
 * Tips for a period. A person sees only their own; the business and its write-role staff see everyone's and can look at one person. Nuclear records
 * and shows tips, it does not pay them out: the business pays its staff.
 */
export function Tips({ api, onError, business, heading = "Tips" }: { api: Api; onError: (e: unknown) => void; business?: string; heading?: string }) {
  usePageTitle(heading);
  const [period, setPeriod] = useState<Period>("7d");
  const [custom, setCustom] = useState({ from: "", to: "" });
  const [person, setPerson] = useState<string | undefined>(undefined);
  const range = periodRange(period, custom);
  const rangeKey = `${range.from ?? ""}|${range.to ?? ""}`;
  const badRange = period === "custom" && !!custom.from && !!custom.to && custom.from > custom.to;
  const [page, setPage] = useState<TipsPage | null>(null);
  const [rows, setRows] = useState<TipsPage["tips"]>([]);
  const [failed, setFailed] = useState(false);
  const [more, setMore] = useState(false);

  const load = useCallback(async () => {
    const [from, to] = rangeKey.split("|");
    setPage(null);
    try {
      const p = await api.tips({ business, staff: person, ...(from ? { from } : {}), ...(to ? { to } : {}) });
      setPage(p); setRows(p.tips); setFailed(false);
    } catch (e) { setFailed(true); onError(e); }
  }, [api, business, person, rangeKey, onError]);
  useEffect(() => { if (!badRange) void load(); }, [load, badRange]);

  async function loadMore() {
    if (!page?.next_cursor) return;
    setMore(true);
    const [from, to] = rangeKey.split("|");
    try {
      const p = await api.tips({ business, staff: person, cursor: page.next_cursor, ...(from ? { from } : {}), ...(to ? { to } : {}) });
      setRows((r) => [...r, ...p.tips]); setPage({ ...page, next_cursor: p.next_cursor });
    } catch (e) { onError(e); } finally { setMore(false); }
  }

  function download() {
    if (!page) return;
    const lines = ["Name,Tips", ...page.staff.map((s) => `${cell(s.name)},${(s.total / 100).toFixed(2)}`)];
    const url = URL.createObjectURL(new Blob([lines.join("\n") + "\n"], { type: "text/csv" }));
    const a = document.createElement("a");
    a.href = url; a.download = `tips-${range.from ?? "start"}-to-${range.to ?? "today"}.csv`; a.click();
    URL.revokeObjectURL(url);
  }

  const everyone = page ? page.role !== "read" : false;
  return (
    <section>
      <div className="head"><h1>{heading}</h1><div className="head-actions">{everyone && <button type="button" className="ghost" disabled={!page || page.staff.length === 0} onClick={download}>Download Tips</button>}<RefreshButton onClick={() => { if (!badRange) void load(); }} /></div></div>
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
        {page && !badRange && <p className="period-totals" role="status"><strong>{signed(page.total)}</strong> in tips · {int(page.count)} {page.count === 1 ? "entry" : "entries"}{person && page.staff[0] ? <span className="muted"> · {page.staff[0].name}</span> : null}</p>}
      </div>
      {badRange && <p className="error" role="alert">The start date is after the end date.</p>}
      {everyone && page && (
        <div className="card flush">
          <table>
            <thead><tr><th scope="col">Person</th><th scope="col" className="num">Tips</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
            <tbody>
              {page.staff.length === 0 ? <tr><td colSpan={3} className="muted">No tips in this period.</td></tr> : page.staff.map((s) => (
                <tr key={s.staff_account_id}>
                  <th scope="row">{s.name}</th><td className="num">{signed(s.total)}</td>
                  <td className="actions"><button type="button" className="ghost" onClick={() => setPerson(person === s.staff_account_id ? undefined : s.staff_account_id)}>{person === s.staff_account_id ? "Show Everyone" : "Show"}</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {page && page.days.length > 0 && (
        <div className="card flush">
          <table>
            <caption className="sr-only">Tips by day</caption>
            <thead><tr><th scope="col">Day</th><th scope="col" className="num">Entries</th><th scope="col" className="num">Tips</th></tr></thead>
            <tbody>
              {page.days.map((d) => <tr key={d.date}><th scope="row">{dayLabel(d.date)}</th><td className="num">{int(d.count)}</td><td className="num">{signed(d.total)}</td></tr>)}
            </tbody>
          </table>
        </div>
      )}
      <div className="card flush">
        {failed && !page ? <p className="error pad" role="alert">Couldn't load tips. <button className="link" onClick={() => void load()}>Try Again</button></p>
          : !page ? <p className="muted pad" role="status">Loading…</p>
          : rows.length === 0 ? <p className="muted pad">No tips in this period.</p>
          : (
            <table>
              <thead><tr><th scope="col">When</th>{everyone && <th scope="col">Person</th>}<th scope="col">Type</th><th scope="col" className="num">Amount</th></tr></thead>
              <tbody>
                {rows.map((t) => (
                  <tr key={t.id}><td className="when">{new Date(t.created_at).toLocaleString()}</td>{everyone && <td>{t.staff_name}</td>}<td>{t.kind === "refund" ? "REFUND" : "TIP"}</td><td className="num">{signed(t.amount)}</td></tr>
                ))}
              </tbody>
            </table>
          )}
      </div>
      {page?.next_cursor && <p className="more"><button type="button" className="ghost" disabled={more} onClick={() => void loadMore()}>{more ? "Loading…" : "Load More"}</button></p>}
    </section>
  );
}
