import { useCallback, useState } from "react";
import type { Api, SalesPeriod, Sales } from "../api";
import { money } from "../format";
import { useList } from "../useList";

const PERIODS: { value: SalesPeriod; label: string }[] = [{ value: "week", label: "This week" }, { value: "last_week", label: "Last week" }, { value: "30d", label: "Last 30 days" }];
const greeting = () => { const h = new Date().getHours(); return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening"; };
const dayName = (date: string) => new Date(date + "T12:00:00Z").toLocaleDateString([], { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
const initial = (date: string) => new Date(date + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "narrow", timeZone: "UTC" });

/** Sales per day (from the daily snapshots, today live) under a greeting, today's sales and the processing fees (always $0.00 on Nuclear). */
export function SalesChart({ api, name, onError }: { api: Api; name: string; onError: (e: unknown) => void }) {
  const [period, setPeriod] = useState<SalesPeriod>("week");
  const { data } = useList<Sales>(useCallback(() => api.sales(period), [api, period]), onError, `sales:${period}`);
  const today = data?.days.find((d) => d.date === data.today);
  const peak = Math.max(1, ...(data?.days.map((d) => d.sales) ?? []));
  const earlier = (data?.days ?? []).filter((d) => d.date < (data?.today ?? "") && d.sales > 0);
  const good = !!today && today.sales > 0 && earlier.length > 0 && today.sales >= earlier.reduce((a, d) => a + d.sales, 0) / earlier.length;
  return (
    <article className="card sales-card" aria-label="Sales">
      <div className="sales-head">
        <h2 className="sales-hello">{greeting()}, {name}</h2>
        <select aria-label="Period" value={period} onChange={(e) => setPeriod(e.target.value as SalesPeriod)}>
          {PERIODS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
        </select>
      </div>
      <div className="sales-figures">
        <div><p className="sub">Today's sales</p><p className="big lg">{money(today?.sales ?? 0)}</p></div>
        <div><p className="sub">Processing fees</p><p className="big lg">{money(data?.fees ?? 0)}</p></div>
        {period !== "week" && data && <div><p className="sub">{period === "30d" ? "Last 30 days" : "Last week"}</p><p className="big lg">{money(data.total)}</p></div>}
      </div>
      {good && <p className="sales-trend">↗ Looking good</p>}
      {data ? (
        <div className={`sales-bars${data.days.length > 7 ? " dense" : ""}`} role="img" aria-label={`Sales by day, ${data.from} to ${data.to}: ${money(data.total)} in total`}>
          {data.days.map((d, i) => (
            <div key={d.date} className={`sales-col${d.date === data.today ? " today" : ""}${d.date > data.today ? " future" : ""}`} title={`${dayName(d.date)}: ${money(d.sales)}`}>
              <div className="sales-bar" style={{ height: `${d.sales > 0 ? Math.max(4, Math.round((d.sales / peak) * 100)) : 2}%` }} />
              <span className="sales-day" aria-hidden>{data.days.length <= 7 ? initial(d.date) : i % 7 === 0 ? d.date.slice(5).replace("-", "/") : ""}</span>
            </div>
          ))}
        </div>
      ) : <p className="muted" role="status">Loading…</p>}
    </article>
  );
}
