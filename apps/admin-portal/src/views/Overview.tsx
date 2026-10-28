import { useCallback, useEffect, useState } from "react";
import { ago, int, money } from "../format";
import type { Api, Stats, Vol } from "../api";

const REFRESH_MS = 60_000;

export function Overview({ api, onError, needsLogo = 0, openBanks }: { api: Api; onError: (e: unknown) => void; needsLogo?: number; openBanks?: () => void }) {
  const [stats, setStats] = useState<Stats | null>(null);
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [now, setNow] = useState(Date.now());

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setStats(await api.stats());
      setFailed(false);
    } catch (e) {
      setFailed(true);
      onError(e);
    } finally {
      setLoading(false);
      setNow(Date.now());
    }
  }, [api, onError]);

  // The Refresh button asks the API to recompute; the 60-second poll only reads the cached snapshot.
  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setStats(await api.refreshStats());
      setFailed(false);
    } catch (e) {
      setFailed(true);
      onError(e);
    } finally {
      setLoading(false);
      setNow(Date.now());
    }
  }, [api, onError]);

  const [checking, setChecking] = useState(false);
  const [checkFailed, setCheckFailed] = useState(false);
  const runCheck = useCallback(async () => {
    setChecking(true);
    setCheckFailed(false);
    try { setStats(await api.runReconciliation()); } catch (e) { setCheckFailed(true); onError(e); }
    finally { setChecking(false); setNow(Date.now()); }
  }, [api, onError]);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(t);
  }, [load]);

  if (!stats) {
    return (
      <section aria-busy={!failed}>
        <h1>System overview</h1>
        {failed ? (
          <p className="error" role="alert">Couldn't load the numbers. <button className="link" onClick={() => void load()}>Try again</button></p>
        ) : (
          <p className="muted" role="status">Loading…</p>
        )}
      </section>
    );
  }

  const p = stats.payments;
  const r = stats.reconciliation;
  const ok = r.balances_match_ledger && r.credit_matches_ledger && r.ledger_balanced;

  return (
    <section>
      {needsLogo > 0 && openBanks && (
        <p className="notice-bar" role="status">{needsLogo} bank{needsLogo === 1 ? " needs" : "s need"} a logo. <a href="/banks" onClick={(e) => { e.preventDefault(); openBanks(); }}>Add Logos</a></p>
      )}
      <div className="head">
        <h1>System overview</h1>
        <div className="asof">
          <span className="muted">Updated {ago(stats.as_of, now)}{failed ? " · refresh failed" : ""}</span>
          <button onClick={() => void refresh()} disabled={loading}>{loading ? "Refreshing…" : "Refresh"}</button>
        </div>
      </div>

      {stats.estimate && (
        <p className="muted note" role="note">
          Exact through the end of {new Date(`${stats.estimate.snapshot_date}T12:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" })} (New York time). Today's activity is an estimate and is replaced by the exact figures at midnight.
        </p>
      )}

      <div className={ok ? "banner good" : "banner bad"} role={ok ? "status" : "alert"}>
        <strong>{ok ? "Books reconcile" : "Books do not reconcile"}</strong>
        {ok ? (
          <span>Account balances and credit match the ledger, and every posting balances.</span>
        ) : (
          <span>
            {!r.balances_match_ledger && <>Balances differ from the ledger by {money(Math.abs(r.balance_difference))}. </>}
            {!r.credit_matches_ledger && <>Credit differs from the ledger by {money(Math.abs(r.credit_difference))}. </>}
            {!r.ledger_balanced && <>The ledger is unbalanced. </>}
            Investigate before moving more money.
          </span>
        )}
        <span className="muted note">
          Checked {ago(stats.reconciliation_checked_at, now)}{stats.reconciliation_stale ? " · the nightly check is overdue" : ""}{checkFailed ? " · check failed" : ""}
        </span>
        <button type="button" className="ghost" onClick={() => void runCheck()} disabled={checking}>{checking ? "Checking…" : "Run Check"}</button>
      </div>

      <div className="grid">
        <article className="card hero" aria-label="Scheme balance">
          <h2>Scheme balance</h2>
          <p className="big">{money(stats.scheme.balance)}</p>
          <p className="sub">Consumers {money(stats.scheme.consumer_balance)}</p>
          <p className="sub">Merchants {money(stats.scheme.merchant_balance)}</p>
          <p className="sub">Organizations {money(stats.scheme.organization_balance)}</p>
        </article>
        <article className="card" aria-label="Users">
          <h2>Users</h2>
          <p className="big">{int(stats.users.total)}</p>
          <p className="sub">{int(stats.users.active)} active · {int(stats.users.new_today)} new today</p>
          <p className="sub">{int(stats.users.wallets)} {stats.users.wallets === 1 ? "wallet" : "wallets"}</p>
        </article>
        <article className="card" aria-label="Merchants">
          <h2>Merchants</h2>
          <p className="big">{int(stats.merchants.total)}</p>
          <p className="sub">{int(stats.merchants.transacting)} accepting payments</p>
          <p className="sub">{int(stats.merchants.terminals)} {stats.merchants.terminals === 1 ? "terminal" : "terminals"}</p>
        </article>
        <article className="card" aria-label="Payments processed">
          <h2>Payments processed</h2>
          <p className="big">{money(p.total.volume)}</p>
          <p className="sub">{int(p.total.count)} payments, lifetime</p>
        </article>
      </div>

      <h2 className="section">Payments</h2>
      <div className="card flush">
        <table>
          <thead>
            <tr>
              <th scope="col">Type</th>
              <th scope="col" className="num">Lifetime count</th>
              <th scope="col" className="num">Lifetime volume</th>
              <th scope="col" className="num">Today count</th>
              <th scope="col" className="num">Today volume</th>
            </tr>
          </thead>
          <tbody>
            <Row label="Sent" note="wallet to wallet" life={p.sent} today={p.today.sent} />
            <Row label="Tapped" note="band or card at a terminal" life={p.tapped} today={p.today.tapped} />
            <Row label="Agents" note="from agent wallets (already counted above)" life={p.agents} today={p.today.agents} />
            <Row label="In app" note="customer-confirmed" life={p.in_app} today={p.today.in_app} />
            <tr className="total">
              <th scope="row">All payments</th>
              <td className="num">{int(p.total.count)}</td>
              <td className="num">{money(p.total.volume)}</td>
              <td className="num">{int(p.today.sent.count + p.today.tapped.count + p.today.in_app.count)}</td>
              <td className="num">{money(p.today.sent.volume + p.today.tapped.volume + p.today.in_app.volume)}</td>
            </tr>
            <Row label="Refunds" note="returned to customers" life={p.refunds} />
            <Row label="Loaded" note="money added to the scheme" life={p.loaded} />
          </tbody>
        </table>
      </div>

      <h2 className="section">Scheme detail</h2>
      <dl className="card facts">
        <div><dt>Consumer balances</dt><dd>{money(stats.scheme.consumer_balance)}</dd></div>
        <div><dt>Merchant balances</dt><dd>{money(stats.scheme.merchant_balance)}</dd></div>
        <div><dt>Organization balances</dt><dd>{money(stats.scheme.organization_balance)}</dd></div>
        <div><dt>Merchants in debt</dt><dd>{money(stats.scheme.merchant_debt)}</dd></div>
        <div><dt>Loads awaiting clearance</dt><dd>{money(stats.scheme.pending)}</dd></div>
        <div><dt>Credit drawn</dt><dd>{money(stats.scheme.credit_outstanding)} of {money(stats.scheme.credit_limit)}</dd></div>
        <div><dt>Suspended or closed users</dt><dd>{int(stats.users.suspended + stats.users.closed)}</dd></div>
      </dl>
    </section>
  );
}

function Row({ label, note, life, today }: { label: string; note: string; life: Vol; today?: Vol }) {
  return (
    <tr>
      <th scope="row">{label} <span className="muted note">{note}</span></th>
      <td className="num">{int(life.count)}</td>
      <td className="num">{money(life.volume)}</td>
      <td className="num">{today ? int(today.count) : "–"}</td>
      <td className="num">{today ? money(today.volume) : "–"}</td>
    </tr>
  );
}
