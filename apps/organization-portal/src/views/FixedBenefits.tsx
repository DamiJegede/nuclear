import { useRef, useState } from "react";
import { ApiError, type Api, type Employee } from "../api";
import { FIXED_TEMPLATE, readFixedCsv, type FixedCsvResult } from "../csv";
import { dollarsToCents, int, money } from "../format";
import { decimalOnly } from "../inputs";
import { downloadText } from "../token";
import { Modal } from "./Modal";

/** Set fixed benefits from a file: employee_id, name, email and fixed_benefit in dollars (0 or empty clears one). Creates new employees. All or nothing. */
export function UploadFixedBenefits({ api, onClose, onDone, onError }: { api: Api; onClose: () => void; onDone: () => void; onError: (e: unknown) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<{ name: string; result: FixedCsvResult } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function pick(f: File | undefined) {
    setError(null);
    if (!f) return;
    if (f.size > 2 * 1024 * 1024) { setFile(null); return setError("The file is over 2 MB."); }
    setFile({ name: f.name, result: readFixedCsv(await f.text()) });
  }
  async function save() {
    if (!file) return;
    setBusy(true); setError(null);
    try { await api.uploadFixedBenefits(file.result.rows); onDone(); }
    catch (e) { onError(e); setError(e instanceof ApiError && e.status === 400 ? "Check the file and choose it again." : "Couldn't save the fixed benefits. Nothing changed. Try again."); }
    finally { setBusy(false); }
  }
  const ok = !!file && file.result.errors.length === 0 && file.result.rows.length > 0;
  return (
    <Modal title="Upload Fixed Benefits" onClose={onClose} locked={busy}>
      <p className="hint">One row per employee with the columns <strong>employee_id</strong>, <strong>name</strong>, <strong>email</strong> and <strong>fixed_benefit</strong> (in dollars). A fixed benefit of 0, or an empty one, clears it. New employees are added. Nothing is paid now: each payment date credits these amounts.</p>
      <div className="row">
        <button type="button" onClick={() => input.current?.click()}>Choose CSV File</button>
        <button type="button" className="ghost" onClick={() => downloadText("fixed-benefits-template.csv", FIXED_TEMPLATE)}>Download Template</button>
        <input ref={input} type="file" accept=".csv,text/csv" className="sr-only" aria-label="Fixed benefits file" onChange={(e) => { void pick(e.target.files?.[0]); e.target.value = ""; }} />
      </div>
      {file && file.result.errors.length > 0 && <ul className="problems" role="alert">{file.result.errors.map((m) => <li key={m}>{m}</li>)}</ul>}
      {ok && <p className="ok" role="status">{file!.name}: {int(file!.result.rows.length)} employee{file!.result.rows.length === 1 ? "" : "s"}, {money(file!.result.total)} per payment{file!.result.clears > 0 ? `, ${int(file!.result.clears)} cleared` : ""}.</p>}
      {error && <p className="error" role="alert">{error}</p>}
      <div className="modal-actions">
        <button type="button" disabled={busy || !ok} onClick={() => void save()}>{busy ? "Saving…" : "Save Fixed Benefits"}</button>
        <button type="button" className="ghost" disabled={busy} onClick={onClose}>Cancel</button>
      </div>
    </Modal>
  );
}

/** One employee's fixed benefit. Empty (or 0) clears it. */
export function EditFixedBenefit({ api, employee, onClose, onDone, onError }: { api: Api; employee: Employee; onClose: () => void; onDone: () => void; onError: (e: unknown) => void }) {
  const [amount, setAmount] = useState(employee.fixed_benefit ? (employee.fixed_benefit / 100).toFixed(2) : "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function save() {
    setError(null);
    const cents = amount.trim() === "" ? 0 : dollarsToCents(amount);
    if (cents === null || cents > 10_000_000) return setError("Enter an amount in dollars, up to $100,000.00.");
    setBusy(true);
    try { await api.setFixedBenefit(employee.id, cents === 0 ? null : cents); onDone(); }
    catch (e) { onError(e); setError("Couldn't save. Try again."); }
    finally { setBusy(false); }
  }
  return (
    <Modal title="Fixed Benefit" onClose={onClose} locked={busy}>
      <div className="modal-form">
        <p>What <strong>{employee.name}</strong> is credited on each payment date.</p>
        <label htmlFor="fixed">Amount (USD)</label>
        <input id="fixed" inputMode="decimal" value={amount} placeholder="None" onChange={(e) => setAmount(decimalOnly(e.target.value))} />
        <p className="hint">Leave it empty to clear it.</p>
        {error && <p className="error" role="alert">{error}</p>}
        <div className="modal-actions">
          <button type="button" disabled={busy} onClick={() => void save()}>{busy ? "Saving…" : "Save"}</button>
          <button type="button" className="ghost" disabled={busy} onClick={onClose}>Cancel</button>
        </div>
      </div>
    </Modal>
  );
}
