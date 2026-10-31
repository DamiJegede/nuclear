import { useCallback, useState } from "react";
import { RefreshButton } from "./RefreshButton";
import type { Api, Report, ReportPeriod } from "../api";
import { int, money } from "../format";
import { usePageTitle } from "../title";
import { useList } from "../useList";

const PERIODS: { value: ReportPeriod; label: string }[] = [
  { value: "week", label: "This week" }, { value: "last_week", label: "Last week" }, { value: "30d", label: "Last 30 days" },
  { value: "month", label: "This month" }, { value: "last_month", label: "Last month" },
];
const dayLabel = (iso: string) => new Date(`${iso}T12:00:00`).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
const dollars = (cents: number) => (cents / 100).toFixed(2);

/** The daily report: sales, refunds, net, sales tax collected and returned, tips, with the taxable and exempt split, for a period; downloadable as CSV. */
export function Reports({ api, onError }: { api: Api; onError: (e: unknown) => void }) {
  usePageTitle("Reports");
  const [period, setPeriod] = useState<ReportPeriod>("week");
  const { data, failed, retry } = useList<Report>(useCallback(() => api.report(period), [api, period]), onError, `report:${period}`);

  function download() {
    if (!data) return;
    const lines = ["Date,Payments,Sales,Refunds,Net sales,Taxable sales,Exempt sales,Sales tax collected,Sales tax returned,Tips"];
    for (const d of data.days) lines.push([d.date, d.payments, dollars(d.sales), dollars(d.refunded), dollars(d.sales - d.refunded), dollars(d.taxable), dollars(d.exempt), dollars(d.tax), dollars(d.tax_refunded), dollars(d.tips)].join(","));
    const t = data.total;
    lines.push(["Total", t.payments, dollars(t.sales), dollars(t.refunded), dollars(t.net), dollars(t.taxable), dollars(t.exempt), dollars(t.tax), dollars(t.tax_refunded), dollars(t.tips)].join(","));
    const url = URL.createObjectURL(new Blob([lines.join("\n") + "\n"], { type: "text/csv" }));
    const a = document.createElement("a");
    a.href = url; a.download = `report-${data.from}-to-${data.to}.csv`; a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <section>
      <div className="head"><h1>Reports</h1>
        <div className="head-actions">
          <select aria-label="Period" value={period} onChange={(e) => setPeriod(e.target.value as ReportPeriod)}>{PERIODS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}</select>
          <button type="button" className="ghost" disabled={!data} onClick={download}>Download CSV</button>
          <RefreshButton onClick={retry} />
        </div>
      </div>
      {!data ? (failed ? <p className="error" role="alert">Couldn't load the report. <button className="link" onClick={retry}>Try Again</button></p> : <p className="muted" role="status">Loading…</p>) : (
        <>
          <div className="grid">
            <article className="card" aria-label="Net sales"><h2>Net Sales</h2><p className="big">{money(data.total.net)}</p><p className="sub">{money(data.total.sales)} sales, {money(data.total.refunded)} refunded</p></article>
            <article className="card" aria-label="Sales tax"><h2>Sales Tax</h2><p className="big">{money(data.total.net_tax)}</p><p className="sub">{money(data.total.tax)} collected, {money(data.total.tax_refunded)} returned</p></article>
            <article className="card" aria-label="Taxable and exempt"><h2>Taxable Sales</h2><p className="big">{money(data.total.taxable)}</p><p className="sub">{money(data.total.exempt)} exempt</p></article>
            <article className="card" aria-label="Tips"><h2>Tips</h2><p className="big">{money(data.total.tips)}</p><p className="sub">{int(data.total.payments)} payment{data.total.payments === 1 ? "" : "s"}</p></article>
          </div>
          <div className="card flush">
            <div className="table-wrap">
              <table>
                <thead><tr><th scope="col">Day</th><th scope="col" className="num">Payments</th><th scope="col" className="num">Sales</th><th scope="col" className="num">Refunds</th><th scope="col" className="num">Net</th><th scope="col" className="num">Tax Collected</th><th scope="col" className="num">Tax Returned</th><th scope="col" className="num">Tips</th></tr></thead>
                <tbody>
                  {[...data.days].reverse().map((d) => (
                    <tr key={d.date}>
                      <th scope="row">{dayLabel(d.date)}</th>
                      <td className="num">{int(d.payments)}</td><td className="num">{money(d.sales)}</td><td className="num">{money(d.refunded)}</td><td className="num">{money(d.sales - d.refunded)}</td>
                      <td className="num">{money(d.tax)}</td><td className="num">{money(d.tax_refunded)}</td><td className="num">{money(d.tips)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot><tr><th scope="row">Total</th><td className="num">{int(data.total.payments)}</td><td className="num">{money(data.total.sales)}</td><td className="num">{money(data.total.refunded)}</td><td className="num">{money(data.total.net)}</td><td className="num">{money(data.total.tax)}</td><td className="num">{money(data.total.tax_refunded)}</td><td className="num">{money(data.total.tips)}</td></tr></tfoot>
              </table>
            </div>
          </div>
          <p className="muted note">Days run midnight to midnight New York time. Sales are completed payments (tips and tax included); the tax columns are what your orders recorded, for your own filing.</p>
        </>
      )}
    </section>
  );
}
