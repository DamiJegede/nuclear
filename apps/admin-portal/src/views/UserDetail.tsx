import { useCallback, useEffect, useState, type ReactNode } from "react";
import type { Api, DayRange, UserDetailData, UserDevice, UserFunding, UserOrder, UserTag, UserTxKind, UserTxPage, UserTxRow, UserWallet } from "../api";
import { int, money } from "../format";
import { usePageTitle } from "../title";
import { Modal } from "./Modal";
import { PERIODS, StatusCell, periodRange, type Period } from "./Transactions";

export type UserTab = "details" | "wallets" | "transactions" | "tags" | "devices" | "funding" | "orders";
export const USER_TABS: { value: UserTab; label: string }[] = [
  { value: "details", label: "Details" }, { value: "wallets", label: "Wallets" }, { value: "transactions", label: "Transactions" },
  { value: "tags", label: "Tags" }, { value: "devices", label: "Devices" }, { value: "funding", label: "Funding" }, { value: "orders", label: "Orders" },
];

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : "Never");
const day = (iso: string) => new Date(iso).toLocaleDateString();
const pill = (label: string, tone: "available" | "closed" | "pending" | "" = "") => <span className={`pill ${tone}`}>{label}</span>;
const statusPill = (s: string) => pill(s, s === "active" || s === "completed" || s === "paid" ? "available" : s === "pending" ? "pending" : "closed");

/** One person, for support: numbers on top, tabs for details, wallets, transactions, tags, devices, funding and orders. */
export function UserDetail({
  api, id, tab, canAct, canAdmin = false, onTab, onBack, onError,
}: { api: Api; id: string; tab: UserTab; canAct: boolean; canAdmin?: boolean; onTab: (t: UserTab) => void; onBack: () => void; onError: (e: unknown) => void }) {
  const [u, setU] = useState<UserDetailData | null>(null);
  const [failed, setFailed] = useState(false);
  const [dialog, setDialog] = useState<"suspend" | "sign-out" | "unlock" | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  usePageTitle(u ? `${u.name} · Users` : "User");

  const load = useCallback(async () => {
    try { setU(await api.user(id)); setFailed(false); } catch (e) { setFailed(true); onError(e); }
  }, [api, id, onError]);
  useEffect(() => { void load(); }, [load]);

  async function run(fn: () => Promise<unknown>, message: string) {
    setBusy(true); setError(null);
    try { await fn(); setDialog(null); await load(); }
    catch (e) { onError(e); setError(message); }
    finally { setBusy(false); }
  }

  return (
    <section>
      <div className="head">
        <h1><a href="/users" className="crumb" onClick={(e) => { e.preventDefault(); onBack(); }}>Users</a> <span className="muted">/</span> {u?.name ?? ""}
          {u && <> {statusPill(u.status)}</>}{u?.login_locked && <> {pill("login locked", "pending")}</>}</h1>
        {u && (
          <div className="head-actions">
            {canAct && u.login_locked && <button type="button" onClick={() => { setError(null); setDialog("unlock"); }}>Unlock Login</button>}
            {canAct && <button type="button" className="ghost" onClick={() => { setError(null); setDialog("sign-out"); }}>Sign Out Everywhere</button>}
            {canAdmin && u.status !== "closed" && (
              <button type="button" className={u.status === "active" ? "ghost" : ""} onClick={() => { setError(null); setDialog("suspend"); }}>{u.status === "active" ? "Suspend User" : "Reactivate User"}</button>
            )}
          </div>
        )}
      </div>

      {u && dialog === "suspend" && (
        <Modal title={u.status === "active" ? "Suspend User" : "Reactivate User"} onClose={() => setDialog(null)} locked={busy}>
          {u.status === "active"
            ? <p>Suspend <strong>{u.name}</strong>? Every session and agent key stops working straight away, they can't sign in and nobody can send them money. Their balance and history are untouched. You can reactivate them at any time.</p>
            : <p>Reactivate <strong>{u.name}</strong>? They can sign in again and their wallets and agent keys work.</p>}
          {error && <p className="error" role="alert">{error}</p>}
          <div className="modal-actions">
            <button type="button" disabled={busy} onClick={() => void run(() => api.setUserStatus(id, u.status === "active" ? "suspended" : "active"), "Couldn't change the user's status. Try again.")}>
              {busy ? "Saving…" : u.status === "active" ? "Confirm Suspend" : "Confirm Reactivate"}
            </button>
            <button type="button" className="ghost" disabled={busy} onClick={() => setDialog(null)}>Cancel</button>
          </div>
        </Modal>
      )}
      {u && dialog === "sign-out" && (
        <Modal title="Sign Out Everywhere" onClose={() => setDialog(null)} locked={busy}>
          <p>Sign <strong>{u.name}</strong> out of all {int(u.stats.devices)} active sessions, including shared-wallet devices? They sign in again with their email and password; agent keys are not affected.</p>
          {error && <p className="error" role="alert">{error}</p>}
          <div className="modal-actions">
            <button type="button" disabled={busy} onClick={() => void run(() => api.signOutUser(id), "Couldn't sign them out. Try again.")}>{busy ? "Signing out…" : "Confirm Sign Out"}</button>
            <button type="button" className="ghost" disabled={busy} onClick={() => setDialog(null)}>Cancel</button>
          </div>
        </Modal>
      )}
      {u && dialog === "unlock" && (
        <Modal title="Unlock Login" onClose={() => setDialog(null)} locked={busy}>
          <p><strong>{u.name}</strong> was locked out after too many wrong passwords. Unlock so they can try again now?</p>
          {error && <p className="error" role="alert">{error}</p>}
          <div className="modal-actions">
            <button type="button" disabled={busy} onClick={() => void run(() => api.unlockUserLogin(id), "Couldn't unlock the login. Try again.")}>{busy ? "Unlocking…" : "Confirm Unlock"}</button>
            <button type="button" className="ghost" disabled={busy} onClick={() => setDialog(null)}>Cancel</button>
          </div>
        </Modal>
      )}

      {failed && !u ? (
        <p className="error pad" role="alert">Couldn't load this user. <button className="link" onClick={() => void load()}>Try Again</button></p>
      ) : !u ? (
        <p className="muted pad" role="status">Loading…</p>
      ) : (
        <>
          <div className="grid merchant-stats five">
            <article className="card profile-card" aria-label="Profile">
              <Avatar name={u.name} photo={u.photo} />
              <p className="profile-handle">{u.handle ? `@${u.handle}` : <span className="muted">No handle</span>}</p>
              <p className="profile-plan"><span className="pill">{u.tier ?? "free"}</span></p>
            </article>
            <article className="card" aria-label="Balance">
              <h2>Balance</h2><p className="big">{money(u.balances.balance)}</p>
              <p className="sub">{money(u.balances.shared)} shared · {money(u.balances.earmarked)} earmarked</p>
              {u.balances.credit_limit > 0 && <p className="sub">Credit {money(u.balances.credit_spent)} of {money(u.balances.credit_limit)}</p>}
            </article>
            <article className="card" aria-label="Money out">
              <h2>Sent and Paid</h2><p className="big">{int(u.stats.sent.count + u.stats.payments.count)}</p>
              <p className="sub">{money(u.stats.sent.volume)} sent · {money(u.stats.payments.volume)} paid</p>
            </article>
            <article className="card" aria-label="Money in">
              <h2>Received and Loaded</h2><p className="big">{int(u.stats.received.count + u.stats.loads.count)}</p>
              <p className="sub">{money(u.stats.received.volume)} received · {money(u.stats.loads.volume)} loaded</p>
            </article>
            <article className="card" aria-label="Activity">
              <h2>Activity</h2><p className="big">{int(u.stats.today)}</p>
              <p className="sub">today · {int(u.stats.failed)} failed attempts</p>
              <p className="sub">Last {when(u.stats.last_activity_at)}</p>
            </article>
          </div>

          <div className="tabbar" role="tablist" aria-label="User sections">
            {USER_TABS.map((t) => (
              <button key={t.value} type="button" role="tab" aria-selected={tab === t.value} className={tab === t.value ? "subtab active" : "subtab"} onClick={() => onTab(t.value)}>
                {t.label}
                {t.value === "wallets" && <span className="subtab-n">{u.stats.wallets}</span>}
                {t.value === "tags" && <span className="subtab-n">{u.stats.tags}</span>}
                {t.value === "devices" && <span className="subtab-n">{u.stats.devices}</span>}
                {t.value === "orders" && <span className="subtab-n">{u.stats.orders}</span>}
              </button>
            ))}
          </div>

          {tab === "details" && <Details u={u} />}
          {tab === "wallets" && <Wallets api={api} id={id} canAct={canAct} canAdmin={canAdmin} onChanged={() => void load()} onError={onError} />}
          {tab === "transactions" && <UserTransactions api={api} id={id} onError={onError} />}
          {tab === "tags" && <Tags api={api} id={id} onError={onError} />}
          {tab === "devices" && <Devices api={api} id={id} onError={onError} />}
          {tab === "funding" && <Funding api={api} id={id} onError={onError} />}
          {tab === "orders" && <Orders api={api} id={id} onError={onError} />}
        </>
      )}
    </section>
  );
}

/** A 96 x 96 photo; initials when there is none (or it is not an image address). */
function Avatar({ name, photo }: { name: string; photo: string | null }) {
  const isUrl = !!photo && /^(https?:)?\/\//.test(photo);
  const initials = name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("");
  return isUrl
    ? <img className="avatar" src={photo!} alt={`${name}'s photo`} width={96} height={96} />
    : <div className="avatar avatar-initials" role="img" aria-label={`${name}, no photo`}>{initials || "?"}</div>;
}

function Details({ u }: { u: UserDetailData }) {
  const row = (k: string, v: ReactNode) => <div><dt>{k}</dt><dd>{v || <span className="muted">—</span>}</dd></div>;
  return (
    <div className="card">
      <dl className="detail-list">
        {row("Name", u.name)}
        {row("Handle", u.handle ? `@${u.handle}` : null)}
        {row("Email", u.email)}
        {row("Phone", u.phone)}
        {row("Plan", u.tier)}
        {row("Joined", day(u.created_at))}
        {row("Pending loads", money(u.balances.pending))}
        {row("Sign-in", u.login_locked ? `Locked, retry in about ${Math.ceil(u.login_locked.retry_after / 60)} min` : "Normal")}
        {row("User ID", <code>{u.id}</code>)}
      </dl>
    </div>
  );
}

function useList<T>(load: () => Promise<T>, onError: (e: unknown) => void) {
  const [data, setData] = useState<T | null>(null);
  const [failed, setFailed] = useState(false);
  const run = useCallback(async () => { try { setData(await load()); setFailed(false); } catch (e) { setFailed(true); onError(e); } }, [load, onError]);
  useEffect(() => { void run(); }, [run]);
  return { data, failed, retry: () => void run() };
}

function Wallets({ api, id, canAct, canAdmin, onChanged, onError }: { api: Api; id: string; canAct: boolean; canAdmin: boolean; onChanged: () => void; onError: (e: unknown) => void }) {
  const { data, failed, retry } = useList<UserWallet[]>(useCallback(() => api.userWallets(id), [api, id]), onError);
  const [action, setAction] = useState<{ w: UserWallet; kind: "revoke" | "status" } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirm() {
    if (!action) return;
    setBusy(true); setError(null);
    try {
      if (action.kind === "revoke") await api.revokeAgentKey(action.w.id);
      else await api.setWalletStatus(action.w.id, action.w.status === "active" ? "suspended" : "active");
      setAction(null); retry(); onChanged();
    } catch (e) { onError(e); setError("Couldn't make that change. Try again."); }
    finally { setBusy(false); }
  }

  return (
    <div className="card flush">
      {failed && !data ? <p className="error pad" role="alert">Couldn't load wallets. <button className="link" onClick={retry}>Try Again</button></p>
        : !data ? <p className="muted pad" role="status">Loading…</p>
        : (
          <table>
            <thead><tr>
              <th scope="col">Wallet</th><th scope="col">Type</th><th scope="col">Status</th><th scope="col" className="num">Spendable balance</th>
              <th scope="col" className="num">Daily limit</th><th scope="col">Can</th><th scope="col">Agent key</th><th scope="col"><span className="sr-only">Actions</span></th>
            </tr></thead>
            <tbody>
              {data.map((w) => (
                <tr key={w.id}>
                  <th scope="row">{w.name}</th>
                  <td>{pill(w.type)}</td>
                  <td>{statusPill(w.status)}</td>
                  <td className="num">{w.earmarked ? money(w.balance ?? 0) : <span className="muted">Shared funds</span>}</td>
                  <td className="num">{w.daily_limit === null ? <span className="muted">None</span> : <>{money(w.spent_today ?? 0)} of {money(w.daily_limit)}</>}</td>
                  <td>{[w.allow_pay && "pay", w.allow_send && "send"].filter(Boolean).join(" · ") || "nothing"}</td>
                  <td>{w.key ? <>…{w.key.hint} <span className="muted note">used {when(w.key.last_used_at)}</span></> : <span className="muted">—</span>}</td>
                  <td className="actions">
                    {canAct && w.key && <button type="button" className="ghost" aria-label={`Revoke agent key for ${w.name}`} onClick={() => { setError(null); setAction({ w, kind: "revoke" }); }}>Revoke Key</button>}{" "}
                    {canAdmin && w.status !== "closed" && w.type !== "default" && (
                      <button type="button" className="ghost" aria-label={`${w.status === "active" ? "Suspend" : "Reactivate"} wallet ${w.name}`} onClick={() => { setError(null); setAction({ w, kind: "status" }); }}>{w.status === "active" ? "Suspend" : "Reactivate"}</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      {action && (
        <Modal title={action.kind === "revoke" ? "Revoke Agent Key" : action.w.status === "active" ? "Suspend Wallet" : "Reactivate Wallet"} onClose={() => setAction(null)} locked={busy}>
          {action.kind === "revoke"
            ? <p>Revoke the API key of <strong>{action.w.name}</strong>? The agent loses access at once. The owner can issue a new key from the app or API.</p>
            : action.w.status === "active"
              ? <p>Suspend the wallet <strong>{action.w.name}</strong>? It can't spend or receive and its agent key stops working. The rest of the account is unaffected.</p>
              : <p>Reactivate the wallet <strong>{action.w.name}</strong>?</p>}
          {error && <p className="error" role="alert">{error}</p>}
          <div className="modal-actions">
            <button type="button" disabled={busy} onClick={() => void confirm()}>{busy ? "Saving…" : action.kind === "revoke" ? "Confirm Revoke" : action.w.status === "active" ? "Confirm Suspend" : "Confirm Reactivate"}</button>
            <button type="button" className="ghost" disabled={busy} onClick={() => setAction(null)}>Cancel</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function Tags({ api, id, onError }: { api: Api; id: string; onError: (e: unknown) => void }) {
  const { data, failed, retry } = useList<UserTag[]>(useCallback(() => api.userTags(id), [api, id]), onError);
  return (
    <div className="card flush">
      {failed && !data ? <p className="error pad" role="alert">Couldn't load tags. <button className="link" onClick={retry}>Try Again</button></p>
        : !data ? <p className="muted pad" role="status">Loading…</p>
        : data.length === 0 ? <p className="muted pad">No bands or cards claimed.</p>
        : (
          <table>
            <thead><tr><th scope="col">Tag</th><th scope="col">Label</th><th scope="col">Wallet</th><th scope="col">Locked</th><th scope="col" className="num">Limit per tap</th><th scope="col">Last used</th></tr></thead>
            <tbody>
              {data.map((t) => (
                <tr key={t.id}>
                  <th scope="row">{t.model} <span className="pill via">{t.model_type}</span></th>
                  <td>{t.label ?? "—"}</td>
                  <td>{t.wallet}</td>
                  <td>{pill(t.locked ? "locked" : "unlocked", t.locked ? "pending" : "available")}</td>
                  <td className="num">{t.transaction_limit === null ? <span className="muted">None</span> : money(t.transaction_limit)}</td>
                  <td className="when">{when(t.last_read_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
    </div>
  );
}

function Devices({ api, id, onError }: { api: Api; id: string; onError: (e: unknown) => void }) {
  const { data, failed, retry } = useList<UserDevice[]>(useCallback(() => api.userDevices(id), [api, id]), onError);
  return (
    <div className="card flush">
      {failed && !data ? <p className="error pad" role="alert">Couldn't load devices. <button className="link" onClick={retry}>Try Again</button></p>
        : !data ? <p className="muted pad" role="status">Loading…</p>
        : data.length === 0 ? <p className="muted pad">No sessions yet.</p>
        : (
          <table>
            <thead><tr><th scope="col">Session</th><th scope="col">Platform</th><th scope="col">Shared wallet</th><th scope="col">Started</th><th scope="col">Last used</th><th scope="col">Expires</th></tr></thead>
            <tbody>
              {data.map((d) => (
                <tr key={d.id}>
                  <td>{pill(d.active ? "active" : d.revoked_at ? "signed out" : "expired", d.active ? "available" : "closed")}</td>
                  <td>{d.platform ?? "—"}</td>
                  <td>{d.wallet ?? <span className="muted">Their own login</span>}</td>
                  <td className="when">{when(d.created_at)}</td>
                  <td className="when">{when(d.last_accessed_at)}</td>
                  <td className="when">{when(d.session_expires_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
    </div>
  );
}

function Funding({ api, id, onError }: { api: Api; id: string; onError: (e: unknown) => void }) {
  const { data, failed, retry } = useList<UserFunding>(useCallback(() => api.userFunding(id), [api, id]), onError);
  return (
    <div>
      <div className="card flush">
        {failed && !data ? <p className="error pad" role="alert">Couldn't load funding. <button className="link" onClick={retry}>Try Again</button></p>
          : !data ? <p className="muted pad" role="status">Loading…</p>
          : data.fundings.length === 0 ? <p className="muted pad">No loads yet.</p>
          : (
            <table>
              <thead><tr><th scope="col">Started</th><th scope="col" className="num">Amount</th><th scope="col">Bank</th><th scope="col">Released</th><th scope="col" className="status-col">Status</th></tr></thead>
              <tbody>
                {data.fundings.map((f) => (
                  <tr key={f.id} className={f.status === "failed" ? "fail-row" : undefined}>
                    <td className="when">{when(f.created_at)}</td>
                    <td className="num">{money(f.amount)}</td>
                    <td>{f.last4 ? `•••• ${f.last4}` : "—"}</td>
                    <td className="when">{f.released_at ? when(f.released_at) : "—"}{f.returned_at && <span className="muted note">returned {when(f.returned_at)}</span>}</td>
                    <td className="status-col"><StatusCell status={f.status} code={f.failure_code} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
      </div>
      {data && data.banks.length > 0 && (
        <p className="muted bank-line">Linked banks: {data.banks.map((b) => `•••• ${b.last4} (${b.status})`).join(", ")}</p>
      )}
    </div>
  );
}

function Orders({ api, id, onError }: { api: Api; id: string; onError: (e: unknown) => void }) {
  const { data, failed, retry } = useList<UserOrder[]>(useCallback(() => api.userOrders(id), [api, id]), onError);
  return (
    <div className="card flush">
      {failed && !data ? <p className="error pad" role="alert">Couldn't load orders. <button className="link" onClick={retry}>Try Again</button></p>
        : !data ? <p className="muted pad" role="status">Loading…</p>
        : data.length === 0 ? <p className="muted pad">No store orders.</p>
        : (
          <table>
            <thead><tr><th scope="col">Ordered</th><th scope="col">Tag</th><th scope="col" className="num">Quantity</th><th scope="col" className="num">Total</th><th scope="col">Ships to</th><th scope="col">Status</th></tr></thead>
            <tbody>
              {data.map((o) => (
                <tr key={o.id}>
                  <td className="when">{when(o.created_at)}</td>
                  <th scope="row">{o.model_name} <span className="pill via">{o.model_type}</span></th>
                  <td className="num">{int(o.quantity)}</td>
                  <td className="num">{money(o.total)}</td>
                  <td>{[o.shipping.city, o.shipping.region, o.shipping.country].filter(Boolean).join(", ") || "—"}</td>
                  <td>{statusPill(o.status)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
    </div>
  );
}

const UKINDS: { kind: UserTxKind; label: string }[] = [
  { kind: "all", label: "All" }, { kind: "sends", label: "Sends" }, { kind: "received", label: "Received" },
  { kind: "payments", label: "Payments" }, { kind: "loads", label: "Loads" }, { kind: "refunds", label: "Refunds" },
];

function UserTransactions({ api, id, onError }: { api: Api; id: string; onError: (e: unknown) => void }) {
  const [kind, setKind] = useState<UserTxKind>("all");
  const [period, setPeriod] = useState<Period>("all");
  const [custom, setCustom] = useState({ from: "", to: "" });
  const range = periodRange(period, custom);
  const rangeKey = `${range.from ?? ""}|${range.to ?? ""}`;
  const badRange = period === "custom" && !!custom.from && !!custom.to && custom.from > custom.to;
  const [rows, setRows] = useState<UserTxRow[] | null>(null);
  const [counts, setCounts] = useState<UserTxPage["counts"] | null>(null);
  const [totals, setTotals] = useState<UserTxPage["totals"] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [more, setMore] = useState(false);

  const load = useCallback(async (k: UserTxKind, r: DayRange) => {
    setRows(null);
    try { const p = await api.userTransactions(id, k, undefined, r); setRows(p.transactions); setCounts(p.counts); setTotals(p.totals); setNext(p.next_cursor); setFailed(false); }
    catch (e) { setFailed(true); onError(e); }
  }, [api, id, onError]);

  useEffect(() => {
    if (badRange) return;
    const [from, to] = rangeKey.split("|");
    void load(kind, { ...(from ? { from } : {}), ...(to ? { to } : {}) });
  }, [kind, rangeKey, badRange, load]);

  async function loadMore() {
    if (!next) return;
    setMore(true);
    try { const p = await api.userTransactions(id, kind, next, range); setRows((r) => [...(r ?? []), ...p.transactions]); setNext(p.next_cursor); }
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
          <p className="period-totals" role="status"><strong>{money(totals.money_out)}</strong> out · <strong>{money(totals.money_in)}</strong> in <span className="muted">(completed)</span></p>
        )}
      </div>
      {badRange && <p className="error" role="alert">The start date is after the end date.</p>}

      <div className="choice-grid kind-grid six" role="radiogroup" aria-label="Show">
        {UKINDS.map(({ kind: k, label }) => (
          <label key={k} className="choice kind">
            <input type="radio" name="user-tx-kind" value={k} checked={kind === k} onChange={() => setKind(k)} />
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
                <th scope="col">When</th><th scope="col">Type</th><th scope="col">With</th><th scope="col">Wallet</th>
                <th scope="col" className="num">Amount</th><th scope="col" className="status-col">Status</th>
              </tr></thead>
              <tbody>
                {rows.map((t) => (
                  <tr key={t.id} className={t.status === "failed" ? "fail-row" : undefined}>
                    <td className="when">{new Date(t.timestamp).toLocaleString()}</td>
                    <td><span className="pill">{t.type}</span>{t.via && <span className="pill via">{t.via}</span>}{t.agent && <span className="pill via">agent</span>}</td>
                    <td>{t.counterparty ?? "—"}{t.reference && <span className="muted note">{t.reference}</span>}</td>
                    <td>{t.wallet ?? "—"}</td>
                    <td className="num"><span className={t.direction === "in" ? "amount-in" : ""}>{t.direction === "in" ? "+" : "−"}{money(t.amount)}</span></td>
                    <td className="status-col"><StatusCell status={t.status} code={t.status_code} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
      </div>
      {next && <p className="more"><button type="button" className="ghost" disabled={more} onClick={() => void loadMore()}>{more ? "Loading…" : "Load More"}</button></p>}
    </div>
  );
}
