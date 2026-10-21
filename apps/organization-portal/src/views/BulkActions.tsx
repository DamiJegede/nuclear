import { useState } from "react";
import { ApiError, type Api, type BulkAction, type Employee } from "../api";
import { dollarsToCents, int, money } from "../format";
import { decimalOnly } from "../inputs";
import { Modal } from "./Modal";

export type BulkKind = "set_fixed" | "clear_fixed" | "remove";

/** The confirmation window for a mass edit. One action, on every selected employee, all or nothing. */
export function BulkModal({ api, kind, selected, onClose, onDone, onError }: {
  api: Api; kind: BulkKind; selected: Employee[]; onClose: () => void; onDone: () => void; onError: (e: unknown) => void;
}) {
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const n = selected.length;
  const people = `${int(n)} employee${n === 1 ? "" : "s"}`;
  // Removing only hides people. Credit held for them stays theirs and their claim link keeps working.
  const held = kind === "remove" ? selected.filter((e) => !e.claimed && e.balance > 0) : [];
  const heldTotal = held.reduce((t, e) => t + e.balance, 0);

  async function run() {
    setError(null);
    let op: BulkAction;
    if (kind === "set_fixed") {
      const cents = dollarsToCents(amount);
      if (cents === null || cents <= 0 || cents > 10_000_000) return setError("Enter an amount in dollars, more than zero and up to $100,000.00.");
      op = { action: "set_fixed", amount: cents };
    } else op = { action: kind };
    setBusy(true);
    try { await api.bulkEmployees(selected.map((e) => e.id), op); onDone(); }
    catch (e) {
      onError(e);
      setError(e instanceof ApiError && e.status === 404 ? "Some of these employees no longer exist. Refresh the page and try again." : "Couldn't make the change. Nothing was changed. Try again.");
    } finally { setBusy(false); }
  }

  const title = kind === "set_fixed" ? "Set Fixed Benefit" : kind === "clear_fixed" ? "Clear Fixed Benefit" : "Remove Employees";
  return (
    <Modal title={title} onClose={onClose} locked={busy}>
      <div className="modal-form">
        {kind === "set_fixed" && (
          <>
            <p>Set the fixed benefit of <strong>{people}</strong>. Each payment date credits this amount to each of them.</p>
            <label htmlFor="bulk-amount">Amount (USD)</label>
            <input id="bulk-amount" inputMode="decimal" value={amount} placeholder="0.00" onChange={(e) => setAmount(decimalOnly(e.target.value))} />
            {amount && dollarsToCents(amount) !== null && <p className="hint">{money(dollarsToCents(amount)!)} each, {money(dollarsToCents(amount)! * n)} in total per payment.</p>}
          </>
        )}
        {kind === "clear_fixed" && <p>Clear the fixed benefit of <strong>{people}</strong>? They will no longer be credited on the payment date.</p>}
        {kind === "remove" && (
          <>
            <p>Remove <strong>{people}</strong>? They disappear from the list and are no longer paid a fixed benefit. Adding their employee IDs to a later file brings them back.</p>
            {held.length > 0 && <p className="hint" role="status">{int(held.length)} of them {held.length === 1 ? "has" : "have"} {money(heldTotal)} of credit held. It stays theirs: they can still claim it with their link.</p>}
          </>
        )}
        {error && <p className="error" role="alert">{error}</p>}
        <div className="modal-actions">
          <button type="button" disabled={busy} onClick={() => void run()}>{busy ? "Working…" : kind === "remove" ? "Confirm Remove" : kind === "clear_fixed" ? "Confirm Clear" : "Save"}</button>
          <button type="button" className="ghost" disabled={busy} onClick={onClose}>Cancel</button>
        </div>
      </div>
    </Modal>
  );
}
