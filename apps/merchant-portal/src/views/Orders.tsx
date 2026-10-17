import { Fragment, useCallback, useState } from "react";
import type { Api, Checkout } from "../api";
import { money } from "../format";
import { usePageTitle } from "../title";
import { useList, when } from "../useList";
import { Modal } from "./Modal";

const TABS = [["open", "Open"], ["paid", "Paid"], ["canceled", "Canceled"], ["expired", "Expired"]] as const;

/** Orders made at the terminals: what is waiting to be paid, what was paid, and cancel one that is still open. */
export function Orders({ api, onError }: { api: Api; onError: (e: unknown) => void }) {
  usePageTitle("Orders");
  const [tab, setTab] = useState<Checkout["status"]>("open");
  const { data, failed, retry } = useList<Checkout[]>(useCallback(() => api.checkouts(tab), [api, tab]), onError);
  const [open, setOpen] = useState<string | null>(null);
  const [target, setTarget] = useState<Checkout | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function cancel() {
    if (!target) return;
    setBusy(true); setError(null);
    try { await api.cancelCheckout(target.id); setTarget(null); retry(); }
    catch (e) { onError(e); setError("Couldn't cancel it. It may already be paid; reload the page."); }
    finally { setBusy(false); }
  }

  return (
    <section>
      <div className="head"><h1>Orders</h1></div>
      <div className="tabbar" role="tablist" aria-label="Orders">
        {TABS.map(([v, label]) => <button key={v} type="button" role="tab" aria-selected={tab === v} className={tab === v ? "subtab active" : "subtab"} onClick={() => setTab(v)}>{label}</button>)}
      </div>
      <div className="card flush">
        {failed && !data ? <p className="error pad" role="alert">Couldn't load orders. <button className="link" onClick={retry}>Try Again</button></p>
          : !data ? <p className="muted pad" role="status">Loading…</p>
          : data.length === 0 ? <p className="muted pad">No {tab} orders.</p>
          : (
            <table>
              <thead><tr><th scope="col">Created</th><th scope="col">Reference</th><th scope="col">Items</th><th scope="col" className="num">Total</th><th scope="col">Status</th>{tab === "open" && <th scope="col"><span className="sr-only">Actions</span></th>}</tr></thead>
              <tbody>
                {data.map((c) => (
                  <Fragment key={c.id}>
                    <tr className="tx-row" tabIndex={0} aria-expanded={open === c.id} onClick={(e) => { if (!(e.target as HTMLElement).closest("button")) setOpen(open === c.id ? null : c.id); }}
                      onKeyDown={(e) => { if ((e.key === "Enter" || e.key === " ") && e.target === e.currentTarget) { e.preventDefault(); setOpen(open === c.id ? null : c.id); } }}>
                      <td className="when">{when(c.created_at)}</td>
                      <td>{c.reference ?? "—"}</td>
                      <td>{c.items.length === 0 ? <span className="muted">Amount only</span> : `${c.items.reduce((n, i) => n + i.quantity, 0)} item${c.items.reduce((n, i) => n + i.quantity, 0) === 1 ? "" : "s"}`}</td>
                      <td className="num">{money(c.total)}</td>
                      <td><span className={`pill ${c.status === "paid" ? "available" : c.status === "open" ? "pending" : "closed"}`}>{c.status}</span></td>
                      {tab === "open" && <td className="actions"><button type="button" className="ghost" onClick={() => { setError(null); setTarget(c); }}>Cancel Order</button></td>}
                    </tr>
                    {open === c.id && (
                      <tr className="tx-detail open">
                        <td colSpan={tab === "open" ? 6 : 5}>
                          <p className="tx-line">Order ID: <span className="tx-id">{c.id}</span></p>
                          {c.items.length === 0 ? <p className="muted">A keyed-in amount with no items.</p>
                            : <ul className="order-items">{c.items.map((i) => <li key={i.id}><span>{i.quantity} × {i.name}</span><span className="muted">{money(i.net_price)} each{i.refunded_quantity > 0 ? ` · ${i.refunded_quantity} refunded` : ""}</span></li>)}</ul>}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          )}
      </div>
      {target && (
        <Modal title="Cancel Order" onClose={() => setTarget(null)} locked={busy}>
          <p>Cancel this order for <strong>{money(target.total)}</strong>{target.reference ? ` (${target.reference})` : ""}? It can't be paid afterwards.</p>
          {error && <p className="error" role="alert">{error}</p>}
          <div className="modal-actions">
            <button type="button" disabled={busy} onClick={() => void cancel()}>{busy ? "Canceling…" : "Confirm Cancel"}</button>
            <button type="button" className="ghost" disabled={busy} onClick={() => setTarget(null)}>Keep Order</button>
          </div>
        </Modal>
      )}
    </section>
  );
}
