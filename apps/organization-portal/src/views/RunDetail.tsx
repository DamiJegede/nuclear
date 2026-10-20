import { useCallback, useState } from "react";
import type { Api, RunDetailData } from "../api";
import { int, money } from "../format";
import { filterRows, reportCsv, type ReportFilter } from "../report";
import { usePageTitle } from "../title";
import { downloadText } from "../token";
import { useList } from "../useList";

const LABEL: Record<ReportFilter, string> = { all: "All", claimed: "Claimed", unclaimed: "Not Claimed" };

/** One benefits run on its own page: who has claimed and who has not, with downloadable reports for following up. */
export function RunDetail({ api, id, onError, back }: { api: Api; id: string; onError: (e: unknown) => void; back: () => void }) {
  usePageTitle("Run");
  const { data, failed, retry } = useList<RunDetailData>(useCallback(() => api.run(id), [api, id]), onError, `run:${id}`);
  const [filter, setFilter] = useState<ReportFilter>("all");

  const header = (
    <>
      <p className="crumb"><a href="/benefits" onClick={(e) => { e.preventDefault(); back(); }}>← Benefits</a></p>
      <div className="head"><h1>Run</h1></div>
    </>
  );
  if (!data) return <section>{header}{failed ? <p className="error" role="alert">Couldn't load this run. <button className="link" onClick={retry}>Try Again</button></p> : <p className="muted" role="status">Loading…</p>}</section>;

  const { run, summary } = data;
  const shown = filterRows(data.rows, filter);
  const counts: Record<ReportFilter, number> = { all: data.rows.length, claimed: summary.claimed, unclaimed: summary.unclaimed };
  const stamp = run.created_at.slice(0, 10);
  const download = (f: ReportFilter) => downloadText(`benefit-run-${stamp}-${f === "unclaimed" ? "not-claimed" : f}.csv`, reportCsv(filterRows(data.rows, f)));

  return (
    <section>
      {header}
      <p className="muted run-when">{new Date(run.created_at).toLocaleString()} • {run.source === "schedule" ? "Scheduled payment" : run.source === "api" ? "Benefits API" : "CSV upload"}</p>
      <div className="grid four">
        <article className="card" aria-label="Total"><h2>Total</h2><p className="big">{money(run.total)}</p><p className="sub">{int(run.rows)} employee{run.rows === 1 ? "" : "s"}</p></article>
        <article className="card" aria-label="Claimed"><h2>Claimed</h2><p className="big">{int(summary.claimed)}</p><p className="sub">of {int(run.rows)}</p></article>
        <article className="card" aria-label="Not claimed"><h2>Not Claimed</h2><p className="big">{int(summary.unclaimed)}</p><p className="sub">{money(summary.still_held)} still held for them</p></article>
        <article className="card" aria-label="Credited"><h2>Credited As</h2><p className="big md">{money(run.sent)} sent</p><p className="sub">{money(run.held)} held at the time</p></article>
      </div>

      <div className="filters report-bar">
        <div className="seg" role="tablist" aria-label="Show">
          {(Object.keys(LABEL) as ReportFilter[]).map((f) => (
            <button key={f} type="button" role="tab" aria-selected={filter === f} className={filter === f ? "seg-btn on" : "seg-btn"} onClick={() => setFilter(f)}>{LABEL[f]} ({int(counts[f])})</button>
          ))}
        </div>
        <button type="button" onClick={() => download(filter)} disabled={shown.length === 0}>Download {filter === "all" ? "Full" : LABEL[filter]} Report</button>
      </div>

      <div className="card flush">
        {shown.length === 0 ? <p className="muted pad">No employees in this view.</p> : (
          <table>
            <thead><tr><th scope="col">Name</th><th scope="col">Employee ID</th><th scope="col">Email</th><th scope="col" className="num">Amount</th><th scope="col">Status</th><th scope="col" className="num">Still Held</th></tr></thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.transaction_id}>
                  <th scope="row">{r.name}{r.removed && <span className="dim"> (removed)</span>}</th>
                  <td>{r.employee_id}</td>
                  <td>{r.email}</td>
                  <td className="num">{money(r.amount)}</td>
                  <td>{r.claimed ? "Claimed" : "Not claimed"}</td>
                  <td className="num">{r.claimed ? "—" : money(r.balance)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <p className="hint">Status is as of now: it changes when an employee claims. The downloaded reports use the same data, in dollars, ready to follow up on.</p>
    </section>
  );
}
