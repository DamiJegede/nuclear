import { useCallback, useRef, useState } from "react";
import { ApiError, type Api, type Batch, type BatchResult, type BatchRowResult, type CreditRow, type Overview } from "../api";
import { CSV_TEMPLATE, readCreditCsv } from "../csv";
import { int, money } from "../format";
import { usePageTitle } from "../title";
import { downloadText } from "../token";
import { useList } from "../useList";
import { Modal } from "./Modal";
import { RefreshButton } from "./RefreshButton";

type Loaded = { name: string; rows: CreditRow[]; total: number; errors: string[]; key: string };

/** Credit employees from a CSV: read it here, check it, see the total against the wallet, then run it as one batch. */
export function Credits({ api, onError }: { api: Api; onError: (e: unknown) => void }) {
  usePageTitle("Credits");
  const batches = useList<Batch[]>(useCallback(() => api.batches(), [api]), onError, "batches");
  const overview = useList<Overview>(useCallback(() => api.overview(), [api]), onError, "overview");
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<Loaded | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<BatchResult | null>(null);
  const [detail, setDetail] = useState<string | null>(null);
  const balance = overview.data?.balance ?? null;

  async function pick(f: File | undefined) {
    setError(null); setResult(null);
    if (!f) return;
    if (f.size > 2 * 1024 * 1024) { setFile(null); return setError("The file is over 2 MB."); }
    const r = readCreditCsv(await f.text());
    setFile({ name: f.name, rows: r.rows, total: r.total, errors: r.errors, key: crypto.randomUUID() });
  }
  async function run() {
    if (!file) return;
    setBusy(true); setError(null);
    try {
      const r = await api.runBatch(file.rows, file.key);
      setResult(r); setFile(null); setConfirm(false);
      batches.retry(); overview.retry();
    } catch (e) {
      onError(e);
      setConfirm(false);
      if (e instanceof ApiError && e.code === "insufficient_balance") setError(`Your wallet has ${money(Number(e.extra?.available ?? 0))}, and this file needs ${money(Number(e.extra?.required ?? 0))}. Add funds, then run it again. Nothing was sent.`);
      else if (e instanceof ApiError && e.code === "recipient_unavailable") setError("One or more employees' accounts can't receive money right now, so nothing was sent.");
      else if (e instanceof ApiError && e.code === "idempotency_mismatch") setError("This file was already used with different contents. Choose the file again.");
      else if (e instanceof ApiError && e.status === 0) setError("Can't reach the API. Run it again; it will not be applied twice.");
      else setError("Couldn't run the batch. Nothing was sent. Try again.");
    } finally { setBusy(false); }
  }

  const short = file && balance !== null && file.total > balance;
  const ready = !!file && file.errors.length === 0 && file.rows.length > 0;

  return (
    <section>
      <div className="head"><h1>Credits</h1><div className="head-actions"><RefreshButton onClick={() => { batches.retry(); overview.retry(); }} /></div></div>

      <div className="card upload">
        <h2>Upload a CSV</h2>
        <p className="hint">One row per employee with the columns <strong>employee_id</strong>, <strong>name</strong>, <strong>email</strong> and <strong>amount</strong> (in dollars). The whole file is credited together or not at all. Employees who haven't joined Nuclear yet are emailed a link and their credit is held for them until they claim it.</p>
        <div className="row">
          <button type="button" onClick={() => input.current?.click()}>Choose CSV File</button>
          <button type="button" className="ghost" onClick={() => downloadText("employee-credits-template.csv", CSV_TEMPLATE)}>Download Template</button>
          <input ref={input} type="file" accept=".csv,text/csv" className="sr-only" aria-label="CSV file" onChange={(e) => { void pick(e.target.files?.[0]); e.target.value = ""; }} />
        </div>
        {error && <p className="error" role="alert">{error}</p>}
        {file && file.errors.length > 0 && (
          <div role="alert">
            <p className="error">{file.name} has problems. Fix them and choose the file again.</p>
            <ul className="problems">{file.errors.map((m) => <li key={m}>{m}</li>)}</ul>
          </div>
        )}
        {file && ready && (
          <>
            <dl className="facts">
              <div><dt>File</dt><dd>{file.name}</dd></div>
              <div><dt>Employees</dt><dd>{int(file.rows.length)}</dd></div>
              <div><dt>Total</dt><dd>{money(file.total)}</dd></div>
              <div><dt>Wallet</dt><dd>{balance === null ? "…" : money(balance)}</dd></div>
            </dl>
            {short && <p className="error" role="alert">Your wallet is {money(file.total - (balance ?? 0))} short for this file. Add funds first; nothing runs until the wallet covers the total.</p>}
            <table>
              <thead><tr><th scope="col">Employee ID</th><th scope="col">Name</th><th scope="col">Email</th><th scope="col" className="num">Amount</th></tr></thead>
              <tbody>
                {file.rows.slice(0, 50).map((r) => <tr key={r.employee_id}><td>{r.employee_id}</td><th scope="row">{r.name}</th><td>{r.email}</td><td className="num">{money(r.amount)}</td></tr>)}
              </tbody>
            </table>
            {file.rows.length > 50 && <p className="hint">Showing the first 50 of {int(file.rows.length)} employees.</p>}
            <div className="modal-actions"><button type="button" disabled={!!short} onClick={() => setConfirm(true)}>Run Batch</button></div>
          </>
        )}
        {result && (
          <p className="ok" role="status">
            Done: {money(result.batch.total)} credited to {int(result.batch.rows)} employee{result.batch.rows === 1 ? "" : "s"} ({money(result.batch.sent)} sent, {money(result.batch.held)} held for people who haven't claimed).
            {result.emails.sent > 0 && <> {int(result.emails.sent)} email{result.emails.sent === 1 ? "" : "s"} sent.</>}
            {result.emails.failed + result.emails.not_configured > 0 && <> {int(result.emails.failed + result.emails.not_configured)} email{result.emails.failed + result.emails.not_configured === 1 ? "" : "s"} could not be sent; they will be tried again.</>}
          </p>
        )}
      </div>

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
                    <td className="actions"><button type="button" className="ghost" onClick={() => setDetail(b.id)}>Details</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
      </div>

      {confirm && file && (
        <Modal title="Run Batch" onClose={() => setConfirm(false)} locked={busy}>
          <p>Credit <strong>{money(file.total)}</strong> to <strong>{int(file.rows.length)}</strong> employee{file.rows.length === 1 ? "" : "s"} from your wallet? This can't be undone.</p>
          <div className="modal-actions">
            <button type="button" disabled={busy} onClick={() => void run()}>{busy ? "Running…" : "Confirm Run"}</button>
            <button type="button" className="ghost" disabled={busy} onClick={() => setConfirm(false)}>Cancel</button>
          </div>
        </Modal>
      )}
      {detail && <BatchDetail api={api} id={detail} onClose={() => setDetail(null)} onError={onError} />}
    </section>
  );
}

function BatchDetail({ api, id, onClose, onError }: { api: Api; id: string; onClose: () => void; onError: (e: unknown) => void }) {
  const { data, failed } = useList<{ batch: Batch; rows: BatchRowResult[] }>(useCallback(() => api.batch(id), [api, id]), onError, `batch:${id}`);
  return (
    <Modal title="Batch Details" onClose={onClose}>
      {failed && !data ? <p className="error" role="alert">Couldn't load this batch.</p>
        : !data ? <p className="muted" role="status">Loading…</p>
        : (
          <>
            <p className="hint">{new Date(data.batch.created_at).toLocaleString()} • {money(data.batch.total)} to {int(data.batch.rows)} employees</p>
            <div className="scroll">
              <table>
                <thead><tr><th scope="col">Name</th><th scope="col">How</th><th scope="col" className="num">Amount</th></tr></thead>
                <tbody>{data.rows.map((r) => <tr key={r.transaction_id}><th scope="row">{r.name}</th><td>{r.mode === "sent" ? "Sent" : "Held"}</td><td className="num">{money(r.amount)}</td></tr>)}</tbody>
              </table>
            </div>
          </>
        )}
      <div className="modal-actions"><button type="button" className="ghost" onClick={onClose}>Close</button></div>
    </Modal>
  );
}
