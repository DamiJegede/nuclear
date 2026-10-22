import { useCallback, useEffect, useState } from "react";
import type { Api, MerchantDocument, OrgEmployeeRow, OrgRunRow, OrganizationDetailData } from "../api";
import { int, money } from "../format";
import { usePageTitle } from "../title";
import { ActivityLog } from "./AuditLog";
import { Avatar } from "./Avatar";
import { Modal } from "./Modal";

export type OrganizationTab = "details" | "employees" | "runs" | "documents" | "activity";
export const ORGANIZATION_TABS: { value: OrganizationTab; label: string }[] = [
  { value: "details", label: "Details" }, { value: "employees", label: "Employees" }, { value: "runs", label: "Benefit Runs" },
  { value: "documents", label: "Documents" }, { value: "activity", label: "Activity" },
];

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : "Never");
const day = (iso: string) => new Date(iso).toLocaleDateString();
const pill = (s: string) => <span className={`pill ${s === "active" || s === "credited" || s === "claimed" ? "available" : s === "pending" || s === "waiting_for_funds" ? "pending" : "closed"}`}>{s.replace(/_/g, " ")}</span>;
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** What the schedule is, in words. */
export function scheduleText(p: OrganizationDetailData["program"]): string {
  if (!p.chosen) return "Not chosen yet";
  if (p.mode === "flexible") return "Flexible: credits when the organization chooses";
  const next = p.next_run_date ? ` · next ${new Date(`${p.next_run_date}T12:00:00Z`).toLocaleDateString(undefined, { timeZone: "UTC" })}` : "";
  if (p.cadence === "monthly") return `Fixed: monthly on day ${p.day_of_month}${next}`;
  return `Fixed: ${p.cadence === "biweekly" ? "every other " : "every "}${WEEKDAYS[p.weekday ?? 0]}${next}`;
}

/** One organization (an employer), for support: numbers on top, then tabs for details, employees, benefit runs, documents and activity. */
export function OrganizationDetail({
  api, id, tab, canAdmin = false, onTab, onBack, onError,
}: { api: Api; id: string; tab: OrganizationTab; canAdmin?: boolean; onTab: (t: OrganizationTab) => void; onBack: () => void; onError: (e: unknown) => void }) {
  const [o, setO] = useState<OrganizationDetailData | null>(null);
  const [failed, setFailed] = useState(false);
  const [suspending, setSuspending] = useState(false);
  const [statusBusy, setStatusBusy] = useState(false);
  const [statusError, setStatusError] = useState<string | null>(null);
  usePageTitle(o ? `${o.name} · Organizations` : "Organization");

  const load = useCallback(async () => {
    try { setO(await api.organization(id)); setFailed(false); } catch (e) { setFailed(true); onError(e); }
  }, [api, id, onError]);
  useEffect(() => { void load(); }, [load]);

  async function changeStatus(next: "active" | "suspended") {
    setStatusBusy(true); setStatusError(null);
    try { await api.setOrganizationStatus(id, next); setSuspending(false); await load(); }
    catch (e) { onError(e); setStatusError("Couldn't change the organization's status. Try again."); }
    finally { setStatusBusy(false); }
  }

  return (
    <section>
      <div className="head">
        <h1><a href="/organizations" className="crumb" onClick={(e) => { e.preventDefault(); onBack(); }}>Organizations</a> <span className="muted">/</span> {o?.name ?? ""}
          {o && <> {pill(o.status)}</>}</h1>
        <div className="head-actions">
          {o && canAdmin && (o.status === "active" || o.status === "suspended") && (
            <button type="button" className={o.status === "active" ? "ghost" : ""} onClick={() => { setStatusError(null); setSuspending(true); }}>
              {o.status === "active" ? "Suspend Organization" : "Reactivate Organization"}
            </button>
          )}
        </div>
      </div>
      {o && suspending && (
        <Modal title={o.status === "active" ? "Suspend Organization" : "Reactivate Organization"} onClose={() => setSuspending(false)} locked={statusBusy}>
          {o.status === "active"
            ? <p>Suspend <strong>{o.name}</strong>? Its people can't sign in, its Benefits API key stops working and no scheduled benefits are paid. Money already credited to employees and the history are untouched. You can reactivate it at any time.</p>
            : <p>Reactivate <strong>{o.name}</strong>? Sign-in, the Benefits API key and scheduled benefits work again.</p>}
          {statusError && <p className="error" role="alert">{statusError}</p>}
          <div className="modal-actions">
            <button type="button" disabled={statusBusy} onClick={() => void changeStatus(o.status === "active" ? "suspended" : "active")}>
              {statusBusy ? "Saving…" : o.status === "active" ? "Confirm Suspend" : "Confirm Reactivate"}
            </button>
            <button type="button" className="ghost" disabled={statusBusy} onClick={() => setSuspending(false)}>Cancel</button>
          </div>
        </Modal>
      )}

      {failed && !o ? (
        <p className="error pad" role="alert">Couldn't load this organization. <button className="link" onClick={() => void load()}>Try Again</button></p>
      ) : !o ? (
        <p className="muted pad" role="status">Loading…</p>
      ) : (
        <>
          <div className="grid merchant-stats five">
            <article className="card profile-card" aria-label="Profile">
              <Avatar name={o.name} photo={o.photo} />
              <p className="profile-handle">{o.handle ? `@${o.handle}` : <span className="muted">No handle</span>}</p>
              <p className="profile-plan"><span className="pill">{o.program.chosen ? o.program.mode : "no program"}</span></p>
            </article>
            <article className="card" aria-label="Wallet">
              <h2>Wallet</h2><p className="big">{money(o.balance)}</p><p className="sub">Funds available for benefits</p>
            </article>
            <article className="card" aria-label="Employees">
              <h2>Employees</h2><p className="big">{int(o.employees.total)}</p>
              <p className="sub">{int(o.employees.claimed)} claimed · {int(o.employees.unclaimed)} not yet</p>
              {o.employees.removed > 0 && <p className="sub">{int(o.employees.removed)} removed</p>}
            </article>
            <article className="card" aria-label="Held for employees">
              <h2>Held</h2><p className="big">{money(o.employees.held)}</p><p className="sub">Credited to employees who haven't claimed</p>
            </article>
            <article className="card" aria-label="Benefit runs">
              <h2>Benefit Runs</h2><p className="big">{int(o.runs.count)}</p>
              <p className="sub">{money(o.runs.credited)} credited</p>
              <p className="sub">Last run {when(o.runs.last_run_at)}</p>
            </article>
          </div>

          <div className="tabbar" role="tablist" aria-label="Organization sections">
            {ORGANIZATION_TABS.map((t) => (
              <button key={t.value} type="button" role="tab" aria-selected={tab === t.value} className={tab === t.value ? "subtab active" : "subtab"} onClick={() => onTab(t.value)}>
                {t.label}
                {t.value === "employees" && <span className="subtab-n">{o.employees.total}</span>}
                {t.value === "runs" && <span className="subtab-n">{o.runs.count}</span>}
                {t.value === "documents" && <span className="subtab-n">{o.documents}</span>}
              </button>
            ))}
          </div>

          {tab === "details" && <Details o={o} />}
          {tab === "employees" && <Employees api={api} id={id} onError={onError} />}
          {tab === "runs" && <Runs api={api} id={id} onError={onError} />}
          {tab === "documents" && <Documents api={api} id={id} name={o.name} onError={onError} />}
          {tab === "activity" && <ActivityLog load={(cursor) => api.organizationActivity(id, cursor)} onError={onError} />}
        </>
      )}
    </section>
  );
}

function Details({ o }: { o: OrganizationDetailData }) {
  const a = o.address;
  const address = [a.line, [a.city, a.state].filter(Boolean).join(", "), a.post_code, a.country].filter(Boolean).join(" · ");
  const row = (k: string, v: React.ReactNode) => <div><dt>{k}</dt><dd>{v || <span className="muted">—</span>}</dd></div>;
  return (
    <div className="card">
      <dl className="detail-list">
        {row("Organization name", o.name)}
        {row("Legal name", o.legal_name)}
        {row("Handle", o.handle ? `@${o.handle}` : null)}
        {row("Bio", o.bio)}
        {row("Email", o.email ? <>{o.email} <span className={`pill ${o.email_verified ? "available" : "pending"}`}>{o.email_verified ? "verified" : "not verified"}</span></> : null)}
        {row("Phone", o.phone)}
        {row("Address", address)}
        {row("Website", o.website)}
        {row("Benefits program", scheduleText(o.program))}
        {o.program.mode === "fixed" && o.program.chosen && row("Next fixed payment needs", money(o.program.fixed_total))}
        {row("Benefits API key", o.api_key ? <>•••• {o.api_key.hint} <span className="muted note">created {day(o.api_key.created_at)} · last used {when(o.api_key.last_used_at)}</span></> : null)}
        {row("Joined", day(o.created_at))}
        {row("Organization ID", <code>{o.id}</code>)}
      </dl>
    </div>
  );
}

/** Loads a list for a tab with loading and retry. */
function useList<T>(load: () => Promise<T>, onError: (e: unknown) => void) {
  const [data, setData] = useState<T | null>(null);
  const [failed, setFailed] = useState(false);
  const run = useCallback(async () => { try { setData(await load()); setFailed(false); } catch (e) { setFailed(true); onError(e); } }, [load, onError]);
  useEffect(() => { void run(); }, [run]);
  return { data, failed, retry: () => void run() };
}

function Employees({ api, id, onError }: { api: Api; id: string; onError: (e: unknown) => void }) {
  const [q, setQ] = useState("");
  const [term, setTerm] = useState("");
  useEffect(() => { const t = setTimeout(() => setTerm(q.trim()), q ? 250 : 0); return () => clearTimeout(t); }, [q]);
  const { data, failed, retry } = useList<OrgEmployeeRow[]>(useCallback(() => api.organizationEmployees(id, term || undefined), [api, id, term]), onError);
  return (
    <>
      <div className="filter-box"><input type="search" aria-label="Filter employees" placeholder="Filter by name, email or employee ID" value={q} onChange={(e) => setQ(e.target.value)} autoComplete="off" spellCheck={false} /></div>
      <div className="card flush">
        {failed && !data ? <p className="error pad" role="alert">Couldn't load employees. <button className="link" onClick={retry}>Try Again</button></p>
          : !data ? <p className="muted pad" role="status">Loading…</p>
          : data.length === 0 ? <p className="muted pad">{term ? "No employees match that." : "No employees yet."}</p>
          : (
            <table>
              <thead><tr>
                <th scope="col">Employee</th><th scope="col">ID</th><th scope="col">Email</th><th scope="col">Status</th><th scope="col">Claim</th>
                <th scope="col" className="num">Held</th><th scope="col" className="num">Fixed benefit</th><th scope="col">Added</th>
              </tr></thead>
              <tbody>
                {data.map((e) => (
                  <tr key={e.id}>
                    <th scope="row">{e.name}</th>
                    <td><code>{e.employee_id}</code></td>
                    <td>{e.email}</td>
                    <td>{pill(e.status)}</td>
                    <td>{pill(e.claimed ? "claimed" : "unclaimed")}</td>
                    <td className="num">{money(e.balance)}</td>
                    <td className="num">{e.fixed_benefit === null ? "—" : money(e.fixed_benefit)}</td>
                    <td>{day(e.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
      </div>
    </>
  );
}

const SOURCE: Record<OrgRunRow["source"], string> = { csv: "CSV", api: "API", schedule: "Schedule" };

function Runs({ api, id, onError }: { api: Api; id: string; onError: (e: unknown) => void }) {
  const { data, failed, retry } = useList<OrgRunRow[]>(useCallback(() => api.organizationRuns(id), [api, id]), onError);
  return (
    <div className="card flush">
      {failed && !data ? <p className="error pad" role="alert">Couldn't load benefit runs. <button className="link" onClick={retry}>Try Again</button></p>
        : !data ? <p className="muted pad" role="status">Loading…</p>
        : data.length === 0 ? <p className="muted pad">No benefit runs yet.</p>
        : (
          <table>
            <thead><tr>
              <th scope="col">Date</th><th scope="col">Source</th><th scope="col">Status</th><th scope="col" className="num">Employees</th>
              <th scope="col" className="num">Total</th><th scope="col" className="num">Sent</th><th scope="col" className="num">Held</th><th scope="col">Run at</th>
            </tr></thead>
            <tbody>
              {data.map((r) => (
                <tr key={r.id}>
                  <th scope="row">{day(`${r.run_date}T12:00:00Z`)}</th>
                  <td>{SOURCE[r.source]}</td>
                  <td>{pill(r.status)}{r.failure_code && <span className="muted note"> {r.failure_code.replace(/_/g, " ")}</span>}</td>
                  <td className="num">{int(r.row_count)}</td>
                  <td className="num">{money(r.total)}</td>
                  <td className="num">{money(r.sent)}</td>
                  <td className="num">{money(r.held)}</td>
                  <td className="when">{when(r.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
    </div>
  );
}

function Documents({ api, id, name, onError }: { api: Api; id: string; name: string; onError: (e: unknown) => void }) {
  const { data: docs, failed, retry } = useList<MerchantDocument[]>(useCallback(() => api.organizationDocuments(id), [api, id]), onError);
  const [downloading, setDownloading] = useState<string | null>(null);
  const [error, setError] = useState(false);

  async function download(d: MerchantDocument, n: number) {
    setDownloading(d.id); setError(false);
    try {
      const blob = await api.downloadOrganizationDocument(id, d.id);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = `${name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-document-${n}.${d.file}`;
      document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) { onError(e); setError(true); }
    finally { setDownloading(null); }
  }

  return (
    <div className="card">
      <h2>Documents</h2>
      <p className="muted">Files the organization uploaded from its profile. Each download is recorded in the Logs.</p>
      {failed && !docs ? <p className="error" role="alert">Couldn't load the documents. <button className="link" onClick={retry}>Try Again</button></p>
        : !docs ? <p className="muted" role="status">Loading…</p>
        : docs.length === 0 ? <p className="muted">No documents uploaded.</p>
        : (
          <ul className="doc-list">
            {docs.map((d, i) => (
              <li key={d.id}>
                <span>Document {docs.length - i} <span className="muted note">{d.file.toUpperCase()} · uploaded {new Date(d.created_at).toLocaleString()}</span></span>
                <button type="button" className="ghost" disabled={downloading === d.id} onClick={() => void download(d, docs.length - i)}>{downloading === d.id ? "Downloading…" : "Download"}</button>
              </li>
            ))}
          </ul>
        )}
      {error && <p className="error" role="alert">Couldn't download that file. Try again.</p>}
    </div>
  );
}
