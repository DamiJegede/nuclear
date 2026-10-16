import { useCallback, useEffect, useState } from "react";
import type { Api, DayRange, MerchantDetailData, MerchantProduct, MerchantStaffRow, MerchantTerminal, MerchantTxKind, MerchantTxPage, MerchantTxRow } from "../api";
import { int, money } from "../format";
import { usePageTitle } from "../title";
import { Avatar } from "./Avatar";
import { Modal } from "./Modal";
import { PERIODS, StatusCell, periodRange, type Period } from "./Transactions";

export type MerchantTab = "details" | "terminals" | "staff" | "transactions" | "products";
export const MERCHANT_TABS: { value: MerchantTab; label: string }[] = [
  { value: "details", label: "Details" }, { value: "terminals", label: "Terminals" }, { value: "staff", label: "Staff" },
  { value: "transactions", label: "Transactions" }, { value: "products", label: "Products" },
];

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : "Never");
const day = (iso: string) => new Date(iso).toLocaleDateString();
const statusPill = (s: string) => <span className={`pill ${s === "active" || s === "completed" || s === "available" ? "available" : s === "pending" ? "pending" : "closed"}`}>{s}</span>;

/** One merchant, for support: numbers on top, then tabs for details, terminals, staff, transactions and products. */
export function MerchantDetail({
  api, id, tab, canAct, canAdmin = false, onTab, onBack, onError,
}: { api: Api; id: string; tab: MerchantTab; canAct: boolean; canAdmin?: boolean; onTab: (t: MerchantTab) => void; onBack: () => void; onError: (e: unknown) => void }) {
  const [m, setM] = useState<MerchantDetailData | null>(null);
  const [failed, setFailed] = useState(false);
  const [suspending, setSuspending] = useState(false);
  const [statusBusy, setStatusBusy] = useState(false);
  const [statusError, setStatusError] = useState<string | null>(null);
  usePageTitle(m ? `${m.name} · Merchants` : "Merchant");

  const load = useCallback(async () => {
    try { setM(await api.merchant(id)); setFailed(false); } catch (e) { setFailed(true); onError(e); }
  }, [api, id, onError]);
  useEffect(() => { void load(); }, [load]);

  async function changeStatus(next: "active" | "suspended") {
    setStatusBusy(true); setStatusError(null);
    try { await api.setMerchantStatus(id, next); setSuspending(false); await load(); }
    catch (e) { onError(e); setStatusError("Couldn't change the merchant's status. Try again."); }
    finally { setStatusBusy(false); }
  }

  return (
    <section>
      <div className="head">
        <h1><a href="/merchants" className="crumb" onClick={(e) => { e.preventDefault(); onBack(); }}>Merchants</a> <span className="muted">/</span> {m?.name ?? ""}
          {m && <> {statusPill(m.status)}</>}</h1>
        {m && canAdmin && m.status !== "closed" && (
          <button type="button" className={m.status === "active" ? "ghost" : ""} onClick={() => { setStatusError(null); setSuspending(true); }}>
            {m.status === "active" ? "Suspend Merchant" : "Reactivate Merchant"}
          </button>
        )}
      </div>
      {m && suspending && (
        <Modal title={m.status === "active" ? "Suspend Merchant" : "Reactivate Merchant"} onClose={() => setSuspending(false)} locked={statusBusy}>
          {m.status === "active"
            ? <p>Suspend <strong>{m.name}</strong>? It can't take payments, its owner can't sign in and its terminals stop working straight away. Customers' money and the history are untouched. You can reactivate it at any time.</p>
            : <p>Reactivate <strong>{m.name}</strong>? Payments, the owner's sign-in and its terminals work again.</p>}
          {statusError && <p className="error" role="alert">{statusError}</p>}
          <div className="modal-actions">
            <button type="button" disabled={statusBusy} onClick={() => void changeStatus(m.status === "active" ? "suspended" : "active")}>
              {statusBusy ? "Saving…" : m.status === "active" ? "Confirm Suspend" : "Confirm Reactivate"}
            </button>
            <button type="button" className="ghost" disabled={statusBusy} onClick={() => setSuspending(false)}>Cancel</button>
          </div>
        </Modal>
      )}

      {failed && !m ? (
        <p className="error pad" role="alert">Couldn't load this merchant. <button className="link" onClick={() => void load()}>Try Again</button></p>
      ) : !m ? (
        <p className="muted pad" role="status">Loading…</p>
      ) : (
        <>
          <div className="grid merchant-stats five">
            <article className="card profile-card" aria-label="Profile">
              <Avatar name={m.name} photo={m.photo} />
              <p className="profile-handle">{m.handle ? `@${m.handle}` : <span className="muted">No handle</span>}</p>
              <p className="profile-plan"><span className="pill">{m.tier ?? "free"}</span></p>
            </article>
            <article className="card" aria-label="Balance">
              <h2>Balance</h2><p className="big">{money(m.balance)}</p><p className="sub">What the platform owes this merchant</p>
            </article>
            <article className="card" aria-label="Payments">
              <h2>Payments</h2><p className="big">{int(m.stats.payments.count)}</p>
              <p className="sub">{money(m.stats.payments.volume)} lifetime</p>
              <p className="sub">{int(m.stats.payments.today.count)} today · {money(m.stats.payments.today.volume)}</p>
            </article>
            <article className="card" aria-label="Refunds">
              <h2>Refunds</h2><p className="big">{int(m.stats.refunds.count)}</p><p className="sub">{money(m.stats.refunds.volume)} refunded</p>
              <p className="sub">{int(m.stats.payments.declined)} declined payments</p>
            </article>
            <article className="card" aria-label="Awaiting approval">
              <h2>Awaiting Approval</h2><p className="big">{int(m.stats.pending_refunds.count)}</p><p className="sub">{money(m.stats.pending_refunds.volume)} in pending refunds</p>
              <p className="sub">{int(m.stats.customers)} customers · last payment {when(m.stats.last_payment_at)}</p>
            </article>
          </div>

          <div className="tabbar" role="tablist" aria-label="Merchant sections">
            {MERCHANT_TABS.map((t) => (
              <button key={t.value} type="button" role="tab" aria-selected={tab === t.value} className={tab === t.value ? "subtab active" : "subtab"} onClick={() => onTab(t.value)}>
                {t.label}
                {t.value === "terminals" && <span className="subtab-n">{m.stats.terminals}</span>}
                {t.value === "staff" && <span className="subtab-n">{m.stats.staff}</span>}
                {t.value === "products" && <span className="subtab-n">{m.stats.products}</span>}
              </button>
            ))}
          </div>

          {tab === "details" && <Details m={m} />}
          {tab === "terminals" && <Terminals api={api} id={id} canAct={canAct} onError={onError} />}
          {tab === "staff" && <Staff api={api} id={id} onError={onError} />}
          {tab === "transactions" && <MerchantTransactions api={api} id={id} canAdmin={canAdmin} onChanged={() => void load()} onError={onError} />}
          {tab === "products" && <Products api={api} id={id} onError={onError} />}
        </>
      )}
    </section>
  );
}

function Details({ m }: { m: MerchantDetailData }) {
  const a = m.address;
  const address = [a.line, [a.city, a.state].filter(Boolean).join(", "), a.post_code, a.country].filter(Boolean).join(" · ");
  const row = (k: string, v: React.ReactNode) => <div><dt>{k}</dt><dd>{v || <span className="muted">—</span>}</dd></div>;
  return (
    <div className="card">
      <dl className="detail-list">
        {row("Business name", m.name)}
        {row("Legal name", m.legal_name)}
        {row("Handle", m.handle ? `@${m.handle}` : null)}
        {row("Email", m.email)}
        {row("Phone", m.phone)}
        {row("Address", address)}
        {row("Website", m.website)}
        {row("Payout bank account", m.bank ? <>•••• {m.bank.last4} <span className="pill">{m.bank.status}</span></> : null)}
        {row("Joined", day(m.created_at))}
        {row("Merchant ID", <code>{m.id}</code>)}
      </dl>
    </div>
  );
}

/** Loads a list for a tab with loading and retry, shared by the small tabs. */
function useList<T>(load: () => Promise<T>, onError: (e: unknown) => void) {
  const [data, setData] = useState<T | null>(null);
  const [failed, setFailed] = useState(false);
  const run = useCallback(async () => { try { setData(await load()); setFailed(false); } catch (e) { setFailed(true); onError(e); } }, [load, onError]);
  useEffect(() => { void run(); }, [run]);
  return { data, failed, retry: () => void run() };
}

function Terminals({ api, id, canAct, onError }: { api: Api; id: string; canAct: boolean; onError: (e: unknown) => void }) {
  const { data, failed, retry } = useList<MerchantTerminal[]>(useCallback(() => api.merchantTerminals(id), [api, id]), onError);
  const [confirm, setConfirm] = useState<MerchantTerminal | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function signOut() {
    if (!confirm) return;
    setBusy(true); setError(null);
    try { await api.signOutTerminal(confirm.id); setConfirm(null); retry(); }
    catch (e) { onError(e); setError("Couldn't sign the terminal out. Try again."); }
    finally { setBusy(false); }
  }

  return (
    <div className="card flush">
      {failed && !data ? <p className="error pad" role="alert">Couldn't load terminals. <button className="link" onClick={retry}>Try Again</button></p>
        : !data ? <p className="muted pad" role="status">Loading…</p>
        : data.length === 0 ? <p className="muted pad">No terminals yet.</p>
        : (
          <table>
            <thead><tr>
              <th scope="col">Terminal</th><th scope="col">Refunds</th><th scope="col">Session</th><th scope="col">Orb</th>
              <th scope="col" className="num">Payments</th><th scope="col" className="num">Volume</th><th scope="col">Last payment</th><th scope="col"><span className="sr-only">Actions</span></th>
            </tr></thead>
            <tbody>
              {data.map((t) => (
                <tr key={t.id}>
                  <th scope="row">{t.name}</th>
                  <td><span className={`pill ${t.allow_refunds ? "available" : "pending"}`}>{t.allow_refunds ? "allowed" : "needs approval"}</span></td>
                  <td><span className={`pill ${t.signed_in ? "available" : "closed"}`}>{t.signed_in ? "signed in" : "signed out"}</span></td>
                  <td>{t.orb ? <>{t.orb.model ?? "Orb"} <span className="muted note">{t.orb.uid} · v{t.orb.software ?? "?"}</span></> : <span className="muted">None paired</span>}</td>
                  <td className="num">{int(t.payments)}</td>
                  <td className="num">{money(t.volume)}</td>
                  <td>{when(t.last_payment_at)}</td>
                  <td className="actions">{canAct && t.signed_in && <button type="button" className="ghost" aria-label={`Sign out terminal ${t.name}`} onClick={() => { setError(null); setConfirm(t); }}>Sign Out</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      {confirm && (
        <Modal title="Sign Out Terminal" onClose={() => setConfirm(null)} locked={busy}>
          <p>Sign <strong>{confirm.name}</strong> out? Its current session stops working at once and the merchant has to sign it in again. Payments already made are not affected.</p>
          {error && <p className="error" role="alert">{error}</p>}
          <div className="modal-actions">
            <button type="button" disabled={busy} onClick={() => void signOut()}>{busy ? "Signing out…" : "Confirm Sign Out"}</button>
            <button type="button" className="ghost" disabled={busy} onClick={() => setConfirm(null)}>Cancel</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function Staff({ api, id, onError }: { api: Api; id: string; onError: (e: unknown) => void }) {
  const { data, failed, retry } = useList<MerchantStaffRow[]>(useCallback(() => api.merchantStaff(id), [api, id]), onError);
  return (
    <div className="card flush">
      {failed && !data ? <p className="error pad" role="alert">Couldn't load staff. <button className="link" onClick={retry}>Try Again</button></p>
        : !data ? <p className="muted pad" role="status">Loading…</p>
        : data.length === 0 ? <p className="muted pad">No staff yet. Staff can approve refunds by tapping.</p>
        : (
          <table>
            <thead><tr><th scope="col">Name</th><th scope="col">Email</th><th scope="col">Handle</th><th scope="col">Role</th><th scope="col">Bank</th><th scope="col">Added</th></tr></thead>
            <tbody>
              {data.map((s) => (
                <tr key={s.id}>
                  <th scope="row">{s.name}</th>
                  <td>{s.email ?? "—"}</td>
                  <td>{s.handle ? `@${s.handle}` : "—"}</td>
                  <td><span className={`pill ${s.role === "write" ? "available" : ""}`}>{s.role === "write" ? "can approve refunds" : "read only"}</span></td>
                  <td>{s.bank_last4 ? `•••• ${s.bank_last4}` : "—"}</td>
                  <td>{day(s.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
    </div>
  );
}

function Products({ api, id, onError }: { api: Api; id: string; onError: (e: unknown) => void }) {
  const { data, failed, retry } = useList<MerchantProduct[]>(useCallback(() => api.merchantProducts(id), [api, id]), onError);
  return (
    <div className="card flush">
      {failed && !data ? <p className="error pad" role="alert">Couldn't load products. <button className="link" onClick={retry}>Try Again</button></p>
        : !data ? <p className="muted pad" role="status">Loading…</p>
        : data.length === 0 ? <p className="muted pad">No products yet.</p>
        : (
          <table>
            <thead><tr>
              <th scope="col">Product</th><th scope="col">Category</th><th scope="col" className="num">Price</th><th scope="col" className="num">Stock</th>
              <th scope="col" className="num">Sold today</th><th scope="col" className="num">Sold total</th><th scope="col">Status</th><th scope="col">Visibility</th>
            </tr></thead>
            <tbody>
              {data.map((p) => (
                <tr key={p.id}>
                  <th scope="row">{p.name}</th>
                  <td>{p.category ?? "—"}</td>
                  <td className="num">{money(p.price)}{p.discount > 0 && <span className="muted note">−{money(p.discount)}</span>}</td>
                  <td className="num">{p.stock === null ? "Not tracked" : int(p.stock)}</td>
                  <td className="num">{int(p.sold_today)}</td>
                  <td className="num">{int(p.total_sold)}</td>
                  <td>{statusPill(p.status === "sold_out" ? "sold out" : p.status)}</td>
                  <td><span className={`pill ${p.active ? "available" : "closed"}`}>{p.active ? "visible" : "hidden"}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
    </div>
  );
}

const MKINDS: { kind: MerchantTxKind; label: string }[] = [
  { kind: "all", label: "All" }, { kind: "payments", label: "Payments" }, { kind: "refunds", label: "Refunds" }, { kind: "pending", label: "Awaiting Approval" },
];

function MerchantTransactions({ api, id, canAdmin, onChanged, onError }: { api: Api; id: string; canAdmin: boolean; onChanged: () => void; onError: (e: unknown) => void }) {
  const [kind, setKind] = useState<MerchantTxKind>("all");
  const [period, setPeriod] = useState<Period>("all");
  const [custom, setCustom] = useState({ from: "", to: "" });
  const range = periodRange(period, custom);
  const rangeKey = `${range.from ?? ""}|${range.to ?? ""}`;
  const badRange = period === "custom" && !!custom.from && !!custom.to && custom.from > custom.to;
  const [rows, setRows] = useState<MerchantTxRow[] | null>(null);
  const [counts, setCounts] = useState<MerchantTxPage["counts"] | null>(null);
  const [totals, setTotals] = useState<MerchantTxPage["totals"] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [more, setMore] = useState(false);
  const [resolving, setResolving] = useState<{ row: MerchantTxRow; action: "approve" | "reject" } | null>(null);
  const [resolveBusy, setResolveBusy] = useState(false);
  const [resolveError, setResolveError] = useState<string | null>(null);

  const load = useCallback(async (k: MerchantTxKind, r: DayRange) => {
    setRows(null);
    try {
      const p = await api.merchantTransactions(id, k, undefined, r);
      setRows(p.transactions); setCounts(p.counts); setTotals(p.totals); setNext(p.next_cursor); setFailed(false);
    } catch (e) { setFailed(true); onError(e); }
  }, [api, id, onError]);

  useEffect(() => {
    if (badRange) return;
    const [from, to] = rangeKey.split("|");
    void load(kind, { ...(from ? { from } : {}), ...(to ? { to } : {}) });
  }, [kind, rangeKey, badRange, load]);

  async function resolve() {
    if (!resolving) return;
    setResolveBusy(true); setResolveError(null);
    try {
      await api.resolveMerchantRefund(id, resolving.row.id, resolving.action);
      setResolving(null);
      await load(kind, range); onChanged();
    } catch (e) { onError(e); setResolveError("Couldn't resolve the refund. Try again."); }
    finally { setResolveBusy(false); }
  }

  async function loadMore() {
    if (!next) return;
    setMore(true);
    try { const p = await api.merchantTransactions(id, kind, next, range); setRows((r) => [...(r ?? []), ...p.transactions]); setNext(p.next_cursor); }
    catch (e) { onError(e); } finally { setMore(false); }
  }

  return (
    <div>
      <div className="period-bar">
        <label className="period-field"><span className="sr-only">Period</span>
          <select value={period} onChange={(e) => setPeriod(e.target.value as Period)}>
            {PERIODS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
          </select>
        </label>
        {period === "custom" && (
          <>
            <label className="period-field">From<input type="date" value={custom.from} max={custom.to || undefined} onChange={(e) => setCustom((c) => ({ ...c, from: e.target.value }))} /></label>
            <label className="period-field">To<input type="date" value={custom.to} min={custom.from || undefined} onChange={(e) => setCustom((c) => ({ ...c, to: e.target.value }))} /></label>
          </>
        )}
        {totals && !badRange && (
          <p className="period-totals" role="status">
            <strong>{int(totals.payments.count)}</strong> payments · <strong>{money(totals.payments.volume)}</strong>
            <span className="muted"> · {int(totals.refunds.count)} refunded · {money(totals.refunds.volume)}</span>
          </p>
        )}
      </div>
      {badRange && <p className="error" role="alert">The start date is after the end date.</p>}

      <div className="choice-grid kind-grid four" role="radiogroup" aria-label="Show">
        {MKINDS.map(({ kind: k, label }) => (
          <label key={k} className="choice kind">
            <input type="radio" name="merchant-tx-kind" value={k} checked={kind === k} onChange={() => setKind(k)} />
            <span>{label}</span>
            <span className="kind-count">{counts ? int(counts[k]) : "–"}</span>
          </label>
        ))}
      </div>

      <div className="card flush">
        {failed && !rows ? <p className="error pad" role="alert">Couldn't load transactions. <button className="link" onClick={() => void load(kind, range)}>Try Again</button></p>
          : !rows ? <p className="muted pad" role="status">Loading…</p>
          : rows.length === 0 ? <p className="muted pad">No transactions here.</p>
          : (
            <table>
              <thead><tr>
                <th scope="col">When</th><th scope="col">Type</th><th scope="col">Customer</th><th scope="col">Terminal</th>
                <th scope="col">Reference</th><th scope="col" className="num">Amount</th><th scope="col" className="status-col">Status</th>
                {canAdmin && <th scope="col"><span className="sr-only">Actions</span></th>}
              </tr></thead>
              <tbody>
                {rows.map((t) => (
                  <tr key={t.id} className={t.status === "failed" ? "fail-row" : undefined}>
                    <td className="when">{new Date(t.timestamp).toLocaleString()}</td>
                    <td><span className="pill">{t.type}</span>{t.via && <span className="pill via">{t.via}</span>}</td>
                    <td>{t.customer ?? "—"}</td>
                    <td>{t.terminal ?? "—"}</td>
                    <td>{t.reference ?? "—"}{t.approved_by && <span className="muted note">approved by {t.approved_by}</span>}</td>
                    <td className="num">{money(t.amount)}</td>
                    <td className="status-col"><StatusCell status={t.status} code={t.status_code} /></td>
                    {canAdmin && (
                      <td className="actions">
                        {t.type === "refund" && t.status === "pending" && (
                          <>
                            <button type="button" aria-label={`Approve refund ${money(t.amount)} to ${t.customer ?? "customer"}`} onClick={() => { setResolveError(null); setResolving({ row: t, action: "approve" }); }}>Approve</button>{" "}
                            <button type="button" className="ghost" aria-label={`Reject refund ${money(t.amount)} to ${t.customer ?? "customer"}`} onClick={() => { setResolveError(null); setResolving({ row: t, action: "reject" }); }}>Reject</button>
                          </>
                        )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
      </div>
      {resolving && (
        <Modal title={resolving.action === "approve" ? "Approve Refund" : "Reject Refund"} onClose={() => setResolving(null)} locked={resolveBusy}>
          {resolving.action === "approve"
            ? <p>Approve the refund of <strong>{money(resolving.row.amount)}</strong> to <strong>{resolving.row.customer ?? "the customer"}</strong>? The money moves from the merchant to the customer now.</p>
            : <p>Reject the refund of <strong>{money(resolving.row.amount)}</strong> to <strong>{resolving.row.customer ?? "the customer"}</strong>? Nothing moves and the request is closed.</p>}
          {resolveError && <p className="error" role="alert">{resolveError}</p>}
          <div className="modal-actions">
            <button type="button" disabled={resolveBusy} onClick={() => void resolve()}>{resolveBusy ? "Saving…" : resolving.action === "approve" ? "Confirm Approve" : "Confirm Reject"}</button>
            <button type="button" className="ghost" disabled={resolveBusy} onClick={() => setResolving(null)}>Cancel</button>
          </div>
        </Modal>
      )}
      {next && <p className="more"><button type="button" className="ghost" disabled={more} onClick={() => void loadMore()}>{more ? "Loading…" : "Load More"}</button></p>}
    </div>
  );
}
