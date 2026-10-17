import { useCallback, useState } from "react";
import { RefreshButton } from "./RefreshButton";
import type { Api, Refund } from "../api";
import { money } from "../format";
import { usePageTitle } from "../title";
import { useList, when } from "../useList";
import { Modal } from "./Modal";

const TABS = [["pending", "Awaiting Approval"], ["completed", "Completed"], ["failed", "Failed"]] as const;

/** Refunds: the ones waiting for you (approve or reject, each behind a confirm), and the history. */
export function Refunds({ api, onError }: { api: Api; onError: (e: unknown) => void }) {
  usePageTitle("Refunds");
  const [tab, setTab] = useState<Refund["status"]>("pending");
  const { data, failed, retry } = useList<Refund[]>(useCallback(() => api.refunds(tab), [api, tab]), onError, `refunds:${tab}`);
  const [target, setTarget] = useState<{ r: Refund; action: "approve" | "reject" } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function decide() {
    if (!target) return;
    setBusy(true); setError(null);
    try { await api.resolveRefund(target.r.id, target.action); setTarget(null); retry(); }
    catch (e) { onError(e); setError("Couldn't save the decision. It may already be decided; reload the page."); }
    finally { setBusy(false); }
  }

  return (
    <section>
      <div className="head"><h1>Refunds</h1><div className="head-actions"><RefreshButton onClick={retry} /></div></div>
      <div className="tabbar" role="tablist" aria-label="Refunds">
        {TABS.map(([v, label]) => <button key={v} type="button" role="tab" aria-selected={tab === v} className={tab === v ? "subtab active" : "subtab"} onClick={() => setTab(v)}>{label}</button>)}
      </div>
      <div className="card flush">
        {failed && !data ? <p className="error pad" role="alert">Couldn't load refunds. <button className="link" onClick={retry}>Try Again</button></p>
          : !data ? <p className="muted pad" role="status">Loading…</p>
          : data.length === 0 ? <p className="muted pad">{tab === "pending" ? "Nothing is waiting for approval." : "No refunds here."}</p>
          : (
            <table>
              <thead><tr><th scope="col">Requested</th><th scope="col">Customer</th><th scope="col">Reference</th><th scope="col" className="num">Original</th><th scope="col" className="num">Refund</th><th scope="col">Status</th>{tab === "pending" && <th scope="col"><span className="sr-only">Actions</span></th>}</tr></thead>
              <tbody>
                {data.map((r) => (
                  <tr key={r.id} className={r.status === "failed" ? "fail-row" : r.status === "pending" ? "refund-row" : "refund-done-row"}>
                    <td className="when">{when(r.timestamp)}</td>
                    <td>{r.payer?.display_name ?? "—"}</td>
                    <td>{r.reference ?? "—"}</td>
                    <td className="num">{money(r.payment_amount)}</td>
                    <td className="num">{money(r.amount)}</td>
                    <td><span className={`pill ${r.status === "completed" ? "available" : r.status === "failed" ? "closed" : "pending"}`}>{r.status}</span></td>
                    {tab === "pending" && (
                      <td className="actions row-actions">
                        <button type="button" aria-label={`Approve refund ${money(r.amount)} to ${r.payer?.display_name ?? "customer"}`} onClick={() => { setError(null); setTarget({ r, action: "approve" }); }}>Approve</button>
                        <button type="button" className="ghost" aria-label={`Reject refund ${money(r.amount)} to ${r.payer?.display_name ?? "customer"}`} onClick={() => { setError(null); setTarget({ r, action: "reject" }); }}>Reject</button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
      </div>
      {target && (
        <Modal title={target.action === "approve" ? "Approve Refund" : "Reject Refund"} onClose={() => setTarget(null)} locked={busy}>
          <p>{target.action === "approve"
            ? <>Approve the refund of <strong>{money(target.r.amount)}</strong> to {target.r.payer?.display_name ?? "the customer"}? The money moves from your balance right away.</>
            : <>Reject the refund of <strong>{money(target.r.amount)}</strong> to {target.r.payer?.display_name ?? "the customer"}? Nothing moves and the amount is released.</>}</p>
          {error && <p className="error" role="alert">{error}</p>}
          <div className="modal-actions">
            <button type="button" disabled={busy} onClick={() => void decide()}>{busy ? "Saving…" : target.action === "approve" ? "Confirm Approve" : "Confirm Reject"}</button>
            <button type="button" className="ghost" disabled={busy} onClick={() => setTarget(null)}>Cancel</button>
          </div>
        </Modal>
      )}
    </section>
  );
}
