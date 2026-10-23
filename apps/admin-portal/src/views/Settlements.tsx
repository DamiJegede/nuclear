import { useCallback, useState } from "react";
import { ApiError, type Api, type SettlementItem, type SettlementRun } from "../api";
import { useList } from "./useList";
import { Modal } from "./Modal";
import { int, money } from "../format";
import { usePageTitle } from "../title";

const pill = (s: string) => <span className={`pill ${s === "completed" || s === "settled" ? "available" : s === "failed" || s === "returned" ? "closed" : "pending"}`}>{s}</span>;
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : "—");

/**
 * Settlement: the daily payouts to merchants' banks and collections from them, one row per merchant per day (a "run" is a day). Everyone with the
 * Transactions page can read it; Admin can run settlement now and ask the bank for the answer to a day that is still waiting.
 */
export function Settlements({ api, canAdmin, openMerchant, onError }: { api: Api; canAdmin: boolean; openMerchant?: (id: string) => void; onError: (e: unknown) => void }) {
  usePageTitle("Settlements");
  const [day, setDay] = useState<string | null>(null);
  const [dialog, setDialog] = useState<"run" | "confirm" | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const runs = useList<SettlementRun[]>(useCallback(() => api.settlements(), [api]), onError);

  if (day) {
    return <Day api={api} date={day} canAdmin={canAdmin} openMerchant={openMerchant} onBack={() => { setDay(null); runs.retry(); }} onError={onError} />;
  }

  async function run() {
    setBusy(true); setError(null);
    try {
      const r = await api.runSettlement();
      setDialog(null);
      setNotice(!r.ran ? (r.reason === "already_done" ? "Yesterday is already settled." : "No bank rail is configured, so nothing was sent.")
        : `Settled ${r.cutoff_date}: ${r.payouts} payouts (${money(r.payout_total)}) and ${r.collections} collections (${money(r.collection_total)}).`);
      runs.retry();
    } catch (e) {
      if (e instanceof ApiError && e.code === "no_payment_provider") { setDialog(null); setNotice("No bank rail is configured, so nothing was sent."); }
      else { setError("Couldn't run settlement. Try again."); onError(e); }
    } finally { setBusy(false); }
  }

  return (
    <section>
      <div className="head">
        <h1>Settlements</h1>
        {canAdmin && <div className="head-actions"><button type="button" onClick={() => { setError(null); setDialog("run"); }}>Run Settlement Now</button></div>}
      </div>
      <p className="muted">Each night every active merchant with a payout bank is settled for its whole net balance: a payout to its bank, or a collection from it. Nothing moves for a collection until the bank confirms.</p>
      {notice && <p role="status" className="hint">{notice}</p>}
      <div className="card flush">
        {runs.failed && !runs.data ? <p className="error pad" role="alert">Couldn't load settlements. <button className="link" onClick={runs.retry}>Try Again</button></p>
          : !runs.data ? <p className="muted pad" role="status">Loading…</p>
          : runs.data.length === 0 ? <p className="muted pad">No settlements yet.</p>
          : (
            <table>
              <thead><tr><th scope="col">Day</th><th scope="col">Merchants</th><th scope="col" className="num">Payouts</th><th scope="col" className="num">Collections</th><th scope="col">Bank Reference</th><th scope="col" className="status-col">Status</th></tr></thead>
              <tbody>
                {runs.data.map((r) => (
                  <tr key={r.id}>
                    <th scope="row"><button type="button" className="link" onClick={() => setDay(r.cutoff_date)}>{r.cutoff_date}</button></th>
                    <td>{int(r.merchants)}</td>
                    <td className="num">{money(r.payout_total)}</td>
                    <td className="num">{money(r.collection_total)}</td>
                    <td className="muted">{r.provider_reference ?? "—"}</td>
                    <td className="status-col">{pill(r.status)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
      </div>
      {dialog === "run" && (
        <Modal title="Run Settlement Now" onClose={() => setDialog(null)} locked={busy}>
          <p>Settle yesterday for every active merchant with a payout bank. A day that is already settled does nothing.</p>
          {error && <p className="error" role="alert">{error}</p>}
          <div className="modal-actions"><button type="button" className="ghost" onClick={() => setDialog(null)} disabled={busy}>Cancel</button><button type="button" onClick={() => void run()} disabled={busy}>{busy ? "Running…" : "Run Settlement"}</button></div>
        </Modal>
      )}
    </section>
  );
}

function Day({ api, date, canAdmin, openMerchant, onBack, onError }: { api: Api; date: string; canAdmin: boolean; openMerchant?: (id: string) => void; onBack: () => void; onError: (e: unknown) => void }) {
  usePageTitle(`Settlement ${date}`);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const d = useList<{ settlement: { status: string; provider_reference: string | null }; items: SettlementItem[] }>(useCallback(() => api.settlement(date), [api, date]), onError);
  const items = d.data?.items ?? [];
  const total = (k: "payout" | "collection") => items.filter((i) => i.kind === k && i.status !== "failed" && i.status !== "returned").reduce((t, i) => t + i.amount, 0);

  async function ask() {
    setBusy(true); setError(null);
    try {
      const r = await api.confirmSettlement(date);
      setConfirm(false);
      setNotice(r.status === "completed" ? `The bank answered: ${r.settled} settled, ${r.returned} returned.` : "The bank has not answered yet.");
      d.retry();
    } catch (e) {
      setError(e instanceof ApiError && e.code === "no_payment_provider" ? "No bank rail is configured." : "Couldn't ask the bank. Try again.");
      onError(e);
    } finally { setBusy(false); }
  }

  return (
    <section>
      <p><button type="button" className="link" onClick={onBack}>‹ Settlements</button></p>
      <div className="head">
        <h1>Settlement {date}</h1>
        {canAdmin && d.data?.settlement.status === "submitted" && <div className="head-actions"><button type="button" onClick={() => { setError(null); setConfirm(true); }}>Confirm With Bank</button></div>}
      </div>
      {d.data && <p className="muted">{pill(d.data.settlement.status)} {items.length} merchants · payouts {money(total("payout"))} · collections {money(total("collection"))}</p>}
      {notice && <p role="status" className="hint">{notice}</p>}
      <div className="card flush">
        {d.failed && !d.data ? <p className="error pad" role="alert">Couldn't load this day. <button className="link" onClick={d.retry}>Try Again</button></p>
          : !d.data ? <p className="muted pad" role="status">Loading…</p>
          : (
            <table>
              <thead><tr><th scope="col">Merchant</th><th scope="col">Kind</th><th scope="col" className="num">Amount</th><th scope="col">Bank</th><th scope="col">Reason</th><th scope="col" className="status-col">Status</th></tr></thead>
              <tbody>
                {items.map((i) => (
                  <tr key={i.id} className={i.status === "failed" || i.status === "returned" ? "fail-row" : undefined}>
                    <th scope="row">{openMerchant ? <button type="button" className="link" onClick={() => openMerchant(i.merchant_id)}>{i.merchant}</button> : i.merchant}</th>
                    <td>{i.kind === "payout" ? "Payout" : "Collection"}</td>
                    <td className="num">{money(i.amount)}</td>
                    <td>{i.bank_last4 ? `•••• ${i.bank_last4}` : "—"}</td>
                    <td className="muted">{i.status_code ?? "—"}</td>
                    <td className="status-col">{pill(i.status === "settled" ? "completed" : i.status === "submitted" ? "pending" : i.status)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
      </div>
      {confirm && (
        <Modal title="Confirm With Bank" onClose={() => setConfirm(false)} locked={busy}>
          <p>Ask the bank for the answer to {date}. Settled payouts and collections are finished; returned ones are reversed.</p>
          {error && <p className="error" role="alert">{error}</p>}
          <div className="modal-actions"><button type="button" className="ghost" onClick={() => setConfirm(false)} disabled={busy}>Cancel</button><button type="button" onClick={() => void ask()} disabled={busy}>{busy ? "Asking…" : "Ask The Bank"}</button></div>
        </Modal>
      )}
    </section>
  );
}
