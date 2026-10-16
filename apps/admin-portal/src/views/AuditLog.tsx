import { useCallback, useEffect, useState } from "react";
import type { Api, LogFilter, LogPage, LogRow } from "../api";
import { usePageTitle } from "../title";

const WHO = [["", "Everyone"], ["admin", "Admins"], ["operator", "Operator"], ["customer", "Customers"], ["agent", "Agents"], ["system", "System"]] as const;

/** "tag_model.created" -> "Tag created". */
export const actionText = (a: string): string => {
  const t = a.replace("tag_model", "tag").replace("shop_item", "shop item").replace(/[._]/g, " ").trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
};
const detailText = (d: Record<string, unknown>): string =>
  Object.entries(d).filter(([, v]) => v !== null && v !== undefined && typeof v !== "object").map(([k, v]) => `${k.replace(/_/g, " ")}: ${String(v)}`).join(" · ");

function Rows({ rows }: { rows: LogRow[] }) {
  return (
    <table>
      <thead><tr><th scope="col">When</th><th scope="col">Who</th><th scope="col">Action</th><th scope="col">Target</th><th scope="col">Details</th><th scope="col">IP</th></tr></thead>
      <tbody>
        {rows.map((l) => (
          <tr key={l.id}>
            <td className="when">{new Date(l.created_at).toLocaleString()}</td>
            <td>{l.actor_label ?? "—"} <span className="pill via">{l.actor_type}</span></td>
            <th scope="row">{actionText(l.action)}</th>
            <td>{l.target_label ?? "—"}{l.target_type ? <span className="pill via">{l.target_type.replace("_", " ")}</span> : null}</td>
            <td className="muted">{detailText(l.details) || "—"}</td>
            <td className="muted">{l.ip ?? "—"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** A newest-first, load-more list of log rows. Used by the Audit Log page and the Activity tabs. */
export function ActivityLog({ load, filter, onError }: { load: (cursor?: string) => Promise<LogPage>; filter?: string; onError: (e: unknown) => void }) {
  const [rows, setRows] = useState<LogRow[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [more, setMore] = useState(false);

  const first = useCallback(async () => {
    try { const p = await load(); setRows(p.logs); setNext(p.next_cursor); setFailed(false); }
    catch (e) { setFailed(true); onError(e); }
  }, [load, onError]);
  useEffect(() => { setRows(null); void first(); }, [first, filter]);

  async function loadMore() {
    if (!next) return;
    setMore(true);
    try { const p = await load(next); setRows((r) => [...(r ?? []), ...p.logs]); setNext(p.next_cursor); }
    catch (e) { onError(e); }
    finally { setMore(false); }
  }

  return (
    <div className="card flush">
      {failed && !rows ? <p className="error pad" role="alert">Couldn't load the log. <button className="link" onClick={() => void first()}>Try Again</button></p>
        : !rows ? <p className="muted pad" role="status">Loading…</p>
        : rows.length === 0 ? <p className="muted pad">Nothing logged yet.</p>
        : <Rows rows={rows} />}
      {next && <div className="pad"><button type="button" className="ghost" onClick={() => void loadMore()} disabled={more}>{more ? "Loading…" : "Load More"}</button></div>}
    </div>
  );
}

/** Admin only: every logged admin action and customer security event. */
export function AuditLog({ api, onError }: { api: Api; onError: (e: unknown) => void }) {
  usePageTitle("Logs");
  const [who, setWho] = useState("");
  const [q, setQ] = useState("");
  const [applied, setApplied] = useState("");
  useEffect(() => { const t = setTimeout(() => setApplied(q.trim()), 300); return () => clearTimeout(t); }, [q]);
  const filter: LogFilter = { ...(who ? { who } : {}), ...(applied ? { q: applied } : {}) };
  const key = `${who}|${applied}`;
  const load = useCallback((cursor?: string) => api.logs(filter, cursor), [api, key]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <section>
      <div className="head"><h1>Logs</h1></div>
      <div className="filters">
        <input type="search" placeholder="Search who, what or target" aria-label="Search the log" value={q} onChange={(e) => setQ(e.target.value)} />
        <select aria-label="Who" value={who} onChange={(e) => setWho(e.target.value)}>
          {WHO.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
      </div>
      <ActivityLog load={load} filter={key} onError={onError} />
    </section>
  );
}
