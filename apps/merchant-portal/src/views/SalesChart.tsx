import { useCallback, useEffect, useRef, useState } from "react";
import type { Api, SalesPeriod, Sales } from "../api";
import { money } from "../format";
import { useList } from "../useList";

const PERIODS: { value: SalesPeriod; label: string }[] = [{ value: "week", label: "This week" }, { value: "last_week", label: "Last week" }, { value: "30d", label: "Last 30 days" }];
const dayName = (date: string) => new Date(date + "T12:00:00Z").toLocaleDateString([], { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
const initial = (date: string) => new Date(date + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "narrow", timeZone: "UTC" });

/** A dollar amount that counts up or down to its new value (about 0.45 s, eased) whenever it changes; the first value shows at once. No motion when the person prefers less of it. */
function Money({ cents }: { cents: number }) {
  const [shown, setShown] = useState(cents);
  const current = useRef(cents);
  useEffect(() => {
    const still = typeof matchMedia !== "function" || matchMedia("(prefers-reduced-motion: reduce)").matches || typeof requestAnimationFrame !== "function";
    if (still || current.current === cents) { current.current = cents; setShown(cents); return; }
    const from = current.current, t0 = performance.now(), ms = 450;
    let frame = 0;
    const step = (now: number) => {
      const t = Math.min(1, (now - t0) / ms);
      current.current = t === 1 ? cents : Math.round(from + (cents - from) * (1 - Math.pow(1 - t, 3)));
      setShown(current.current);
      if (t < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [cents]);
  return <>{money(shown)}</>;
}

/**
 * Sales per day (from the daily snapshots, today live). Always three figures: the day under the pointer (today when none), the processing fees (always
 * $0.00 on Nuclear wallet payments) and the total of the chosen period (this week and last 30 days include today's running sales). Hovering or focusing
 * a bar lights it up and shows its day and total in a tooltip.
 */
export function SalesChart({ api, onError }: { api: Api; onError: (e: unknown) => void }) {
  const [period, setPeriod] = useState<SalesPeriod>("week");
  const [hover, setHover] = useState<string | null>(null);
  const { data } = useList<Sales>(useCallback(() => api.sales(period), [api, period]), onError, `sales:${period}`);
  const shown = data ? data.days.find((d) => d.date === (hover ?? data.today)) : undefined;
  const peak = Math.max(1, ...(data?.days.map((d) => d.sales) ?? []));
  const label = PERIODS.find((p) => p.value === period)!.label;
  const last = (data?.days.length ?? 1) - 1;
  return (
    <article className="card sales-card" aria-label="Sales">
      <div className="sales-head">
        <div className="sales-figures">
          <div><p className="sub">{hover && data ? (hover === data.today ? "Today's sales" : dayName(hover)) : "Today's sales"}</p><p className="big lg"><Money cents={shown?.sales ?? 0} /></p></div>
          <div><p className="sub">Processing fees</p><p className="big lg"><Money cents={data?.fees ?? 0} /></p></div>
          <div><p className="sub">{label}</p><p className="big lg"><Money cents={data?.total ?? 0} /></p></div>
        </div>
        <select aria-label="Period" value={period} onChange={(e) => { setHover(null); setPeriod(e.target.value as SalesPeriod); }}>
          {PERIODS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
        </select>
      </div>
      {data ? (
        <div className={`sales-bars${data.days.length > 7 ? " dense" : ""}${hover ? " hovering" : ""}`} role="group" aria-label={`Sales by day, ${data.from} to ${data.to}`} onMouseLeave={() => setHover(null)}>
          {data.days.map((d, i) => (
            <div key={d.date} tabIndex={0} aria-label={`${dayName(d.date)}: ${money(d.sales)}`}
              className={`sales-col${d.date === data.today ? " today" : ""}${d.date > data.today ? " future" : ""}${d.date === hover ? " active" : ""}${i < 2 ? " edge-l" : i > last - 2 ? " edge-r" : ""}`}
              onMouseEnter={() => setHover(d.date)} onFocus={() => setHover(d.date)} onBlur={() => setHover(null)}>
              <div className="sales-bar" style={{ height: `${d.sales > 0 ? Math.max(4, Math.round((d.sales / peak) * 100)) : 2}%` }} />
              {d.date === hover && <div className="sales-tip" aria-hidden><span>{dayName(d.date)}</span><strong>{money(d.sales)}</strong></div>}
              <span className="sales-day" aria-hidden>{data.days.length <= 7 ? initial(d.date) : i % 7 === 0 ? d.date.slice(5).replace("-", "/") : ""}</span>
            </div>
          ))}
        </div>
      ) : <p className="muted" role="status">Loading…</p>}
    </article>
  );
}
