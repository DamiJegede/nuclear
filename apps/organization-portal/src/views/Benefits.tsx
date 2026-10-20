import { useCallback, useRef, useState } from "react";
import { ApiError, type Api, type Batch, type BatchResult, type CreditRow, type Overview } from "../api";
import { CSV_TEMPLATE, readCreditCsv } from "../csv";
import { int, money } from "../format";
import { usePageTitle } from "../title";
import { downloadText } from "../token";
import { useList } from "../useList";
import { Modal } from "./Modal";

/** The running animation shows for at least this long, so a fast batch doesn't flash by. */
const MIN_RUNNING_MS = 1200;

type Loaded = { name: string; rows: CreditRow[]; total: number; errors: string[]; duplicates: string[]; key: string };

/** Credit employees from a CSV: read it here, check it, see the total against the wallet, then run it as one batch. */
type Report = { kind: "success"; result: BatchResult } | { kind: "failure"; message: string };

export function Benefits({ api, onError, openBatch }: { api: Api; onError: (e: unknown) => void; openBatch: (id: string) => void }) {
  usePageTitle("Benefits");
  const batches = useList<Batch[]>(useCallback(() => api.batches(), [api]), onError, "batches");
  const overview = useList<Overview>(useCallback(() => api.overview(), [api]), onError, "overview");
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<Loaded | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<Report | null>(null);
  const balance = overview.data?.balance ?? null;

  async function pick(f: File | undefined) {
    setError(null); setReport(null);
    if (!f) return;
    if (f.size > 2 * 1024 * 1024) { setFile(null); return setError("The file is over 2 MB."); }
    const r = readCreditCsv(await f.text());
    setFile({ name: f.name, rows: r.rows, total: r.total, errors: r.errors, duplicates: r.duplicates, key: crypto.randomUUID() });
  }
  async function run() {
    if (!file) return;
    setBusy(true); setError(null);
    const started = Date.now();
    try {
      const r = await api.runBatch(file.rows, file.key);
      // Let the animation play for a moment even when the API is quick.
      const left = MIN_RUNNING_MS - (Date.now() - started);
      if (left > 0) await new Promise((done) => setTimeout(done, left));
      setReport({ kind: "success", result: r }); setFile(null); setConfirm(false);
      batches.retry(); overview.retry();
    } catch (e) {
      onError(e);
      setConfirm(false);
      let message = "Couldn't run the batch. Try again.";
      if (e instanceof ApiError && e.code === "insufficient_balance") message = `Your wallet has ${money(Number(e.extra?.available ?? 0))}, and this file needs ${money(Number(e.extra?.required ?? 0))}. Add funds, then run it again.`;
      else if (e instanceof ApiError && e.code === "recipient_unavailable") message = "One or more employees' accounts can't receive money right now.";
      else if (e instanceof ApiError && e.code === "idempotency_mismatch") message = "This file was already used with different contents. Choose the file again.";
      else if (e instanceof ApiError && e.status === 0) message = "Can't reach the API. You can run it again; it will not be applied twice.";
      setReport({ kind: "failure", message });
    } finally { setBusy(false); }
  }

  const formatOk = !!file && file.errors.length === 0 && file.rows.length > 0;
  const balanceOk = formatOk && balance !== null && file!.total <= balance;
  const uniqueOk = formatOk && file!.duplicates.length === 0;
  const allOk = formatOk && balanceOk && uniqueOk;

  return (
    <section>
      <div className="head"><h1>Benefits</h1></div>

      <input ref={input} type="file" accept=".csv,text/csv" className="sr-only" aria-label="CSV file" onChange={(e) => { void pick(e.target.files?.[0]); e.target.value = ""; }} />
      {error && !file && <p className="error" role="alert">{error}</p>}

      {!file ? (
        <div className="card upload">
          <h2>Upload a CSV</h2>
          <p className="hint">One row per employee with the columns <strong>employee_id</strong>, <strong>name</strong>, <strong>email</strong> and <strong>amount</strong> (in dollars). The whole file is credited together or not at all. Employees who haven't joined Nuclear yet are emailed a link and their credit is held for them until they claim it.</p>
          <div className="row">
            <button type="button" onClick={() => input.current?.click()}>Choose CSV File</button>
            <button type="button" className="ghost" onClick={() => downloadText("employee-benefits-template.csv", CSV_TEMPLATE)}>Download Template</button>
          </div>
        </div>
      ) : (
        <>
          <div className="card upload ready">
            <div className="ready-main">
              <h2>{allOk ? "Ready to Run" : "Not Ready"}</h2>
              <p className="hint">{formatOk ? <>{int(file.rows.length)} employee{file.rows.length === 1 ? "" : "s"} • {money(file.total)} from your wallet of {balance === null ? "…" : money(balance)} • {file.name}</> : file.name}</p>
              <ul className="checks" aria-label="Checks">
                <li className={formatOk ? "pass" : "fail"}><span className="mark" aria-hidden>{formatOk ? "✓" : "✕"}</span>Formatting OK</li>
                <li className={balanceOk ? "pass" : "fail"}><span className="mark" aria-hidden>{balanceOk ? "✓" : "✕"}</span>Sufficient Balance</li>
                <li className={uniqueOk ? "pass" : "fail"}><span className="mark" aria-hidden>{uniqueOk ? "✓" : "✕"}</span>No Duplicate Employees</li>
              </ul>
              {file.errors.length > 0 && <ul className="problems" role="alert">{file.errors.map((m) => <li key={m}>{m}</li>)}</ul>}
              {formatOk && file.duplicates.length > 0 && <ul className="problems" role="alert">{file.duplicates.map((m) => <li key={m}>{m}</li>)}</ul>}
              {formatOk && !balanceOk && <p className="error" role="alert">Your wallet is {money(file.total - (balance ?? 0))} short for this file. Add funds first; nothing runs until the wallet covers the total.</p>}
              {error && <p className="error" role="alert">{error}</p>}
              <div className="row"><button type="button" className="ghost" onClick={() => { setFile(null); setError(null); input.current?.click(); }}>Choose a Different File</button><button type="button" className="ghost" onClick={() => { setFile(null); setError(null); }}>Cancel</button></div>
            </div>
            <div className="ready-run">
              <button type="button" className="run-btn" disabled={!allOk} onClick={() => setConfirm(true)}>
                <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden fill="currentColor"><path d="M8 5v14l11-7z" /></svg>
                Run Batch
              </button>
            </div>
          </div>
          {formatOk && (
            <div className="card flush">
              <table>
                <thead><tr><th scope="col">Employee ID</th><th scope="col">Name</th><th scope="col">Email</th><th scope="col" className="num">Amount</th></tr></thead>
                <tbody>
                  {file.rows.slice(0, 50).map((r) => <tr key={r.employee_id}><td>{r.employee_id}</td><th scope="row">{r.name}</th><td>{r.email}</td><td className="num">{money(r.amount)}</td></tr>)}
                </tbody>
              </table>
              {file.rows.length > 50 && <p className="hint pad">Showing the first 50 of {int(file.rows.length)} employees.</p>}
            </div>
          )}
        </>
      )}

      <h2 className="section">History</h2>
      <div className="card flush">
        {batches.failed && !batches.data ? <p className="error pad" role="alert">Couldn't load batches. <button className="link" onClick={batches.retry}>Try Again</button></p>
          : !batches.data ? <p className="muted pad" role="status">Loading…</p>
          : batches.data.length === 0 ? <p className="muted pad">No batches yet.</p>
          : (
            <table>
              <thead><tr><th scope="col">Date</th><th scope="col" className="num">Employees</th><th scope="col" className="num">Total</th><th scope="col" className="num">Held</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
              <tbody>
                {batches.data.map((b) => (
                  <tr key={b.id}>
                    <th scope="row">{new Date(b.created_at).toLocaleString()}</th>
                    <td className="num">{int(b.rows)}</td><td className="num">{money(b.total)}</td><td className="num">{money(b.held)}</td>
                    <td className="actions"><button type="button" className="ghost" onClick={() => openBatch(b.id)}>Details</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
      </div>

      {confirm && file && (
        <Modal title={busy ? "Running Batch" : "Run Batch"} onClose={() => setConfirm(false)} locked={busy}>
          {busy ? (
            <div className="running" role="status" aria-live="polite">
              <span className="spinner" aria-hidden />
              <p className="running-title">Crediting {int(file.rows.length)} employee{file.rows.length === 1 ? "" : "s"}…</p>
              <p className="hint">Moving {money(file.total)}. Keep this window open.</p>
            </div>
          ) : (
            <>
              <p>Credit <strong>{money(file.total)}</strong> to <strong>{int(file.rows.length)}</strong> employee{file.rows.length === 1 ? "" : "s"} from your wallet? This can't be undone.</p>
              <div className="modal-actions">
                <button type="button" onClick={() => void run()}>Confirm Run</button>
                <button type="button" className="ghost" onClick={() => setConfirm(false)}>Cancel</button>
              </div>
            </>
          )}
        </Modal>
      )}
      {report && (
        <Modal title={report.kind === "success" ? "Batch Complete" : "Batch Not Run"} onClose={() => setReport(null)}>
          {report.kind === "success" ? (
            <>
              <p className="done"><span className="done-mark" aria-hidden>✓</span>{money(report.result.batch.total)} was credited to {int(report.result.batch.rows)} employee{report.result.batch.rows === 1 ? "" : "s"}.</p>
              <div className="modal-actions">
                <button type="button" onClick={() => { const id = report.result.batch.id; setReport(null); openBatch(id); }}>View Batch</button>
                <button type="button" className="ghost" onClick={() => setReport(null)}>Close</button>
              </div>
            </>
          ) : (
            <>
              <p className="error" role="alert">{report.message}</p>
              <p>Nothing was sent and nothing was charged.</p>
              <div className="modal-actions"><button type="button" onClick={() => setReport(null)}>Close</button></div>
            </>
          )}
        </Modal>
      )}
    </section>
  );
}
