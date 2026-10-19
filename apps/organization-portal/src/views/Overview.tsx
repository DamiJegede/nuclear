import { useCallback, useState } from "react";
import { ApiError, type Account, type Api, type Overview as OverviewData } from "../api";
import { decimalOnly } from "../inputs";
import { dollarsToCents, int, money } from "../format";
import { usePageTitle } from "../title";
import { useList } from "../useList";
import { Avatar } from "./Avatar";
import { Modal } from "./Modal";
import { RefreshButton } from "./RefreshButton";

/** The organization at a glance: wallet, employees, money held for people who have not claimed yet, and the last batch. */
export function Overview({ api, account, onError, go }: { api: Api; account: Account; onError: (e: unknown) => void; go: (page: string) => void }) {
  usePageTitle("Overview");
  const { data, failed, retry } = useList<OverviewData>(useCallback(() => api.overview(), [api]), onError, "overview");
  const [adding, setAdding] = useState(false);
  const nav = (page: string) => (e: React.MouseEvent) => { e.preventDefault(); go(page); };

  if (!data) return <section><h1>Overview</h1>{failed ? <p className="error" role="alert">Couldn't load the numbers. <button className="link" onClick={retry}>Try Again</button></p> : <p className="muted" role="status">Loading…</p>}</section>;
  const last = data.last_batch;

  return (
    <section>
      <div className="head"><h1>Overview</h1><div className="head-actions"><RefreshButton onClick={retry} /></div></div>
      <div className="grid three">
        <article className="card linkcard profile-tile" aria-label="Organization">
          <Avatar name={account.name} photo={account.photo} />
          <div className="tile-text">
            <a href="/profile" className="stretched tile-name" onClick={nav("profile")}>{account.name}</a>
            <p className="tile-line muted">{account.email}</p>
          </div>
        </article>

        <article className="card" aria-label="Wallet">
          <h2>Wallet</h2>
          <p className="big xl">{money(data.balance)}</p>
          <p className="sub">available to credit employees</p>
          <hr className="tile-rule" />
          <button type="button" onClick={() => setAdding(true)}>Add Funds</button>
        </article>

        <article className="card linkcard" aria-label="Employees">
          <h2><a href="/employees" className="stretched" onClick={nav("employees")}>Employees</a></h2>
          <p className="big xl">{int(data.employees.total)}</p>
          <p className="sub">{int(data.employees.claimed)} claimed • {int(data.employees.unclaimed)} not yet</p>
          <hr className="tile-rule" />
          <h3 className="tile-label">Held for Unclaimed</h3>
          <p className="big md">{money(data.held)}</p>
        </article>
      </div>

      <div className="grid">
        <article className="card linkcard" aria-label="Last batch">
          <h2><a href="/credits" className="stretched" onClick={nav("credits")}>Last Credit Batch</a></h2>
          {last ? (
            <>
              <p className="big">{money(last.total)}</p>
              <p className="sub">{int(last.rows)} employee{last.rows === 1 ? "" : "s"} • {new Date(last.created_at).toLocaleDateString()}</p>
            </>
          ) : <p className="sub">No batches yet. Upload a CSV to credit your employees.</p>}
        </article>
      </div>
      {adding && <AddFunds api={api} onClose={() => setAdding(false)} onDone={() => { setAdding(false); retry(); }} onError={onError} />}
    </section>
  );
}

function AddFunds({ api, onClose, onDone, onError }: { api: Api; onClose: () => void; onDone: () => void; onError: (e: unknown) => void }) {
  const [amount, setAmount] = useState("");
  const [key] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function add() {
    setError(null);
    const cents = dollarsToCents(amount);
    if (cents === null || cents <= 0) return setError("Enter an amount greater than zero.");
    setBusy(true);
    try { await api.addFunds(cents, key); onDone(); }
    catch (e) {
      onError(e);
      if (e instanceof ApiError && e.status === 404) setError("Adding funds isn't available yet.");
      else if (e instanceof ApiError && e.status === 422) setError("That amount was declined. Try a smaller amount.");
      else setError("Couldn't add funds. Try again.");
    } finally { setBusy(false); }
  }
  return (
    <Modal title="Add Funds" onClose={onClose} locked={busy}>
      <div className="modal-form">
        <label htmlFor="funds">Amount (USD)</label>
        <input id="funds" inputMode="decimal" value={amount} placeholder="0.00" onChange={(e) => setAmount(decimalOnly(e.target.value))} />
        {error && <p className="error" role="alert">{error}</p>}
        <div className="modal-actions">
          <button type="button" disabled={busy} onClick={() => void add()}>{busy ? "Adding…" : "Add Funds"}</button>
          <button type="button" className="ghost" disabled={busy} onClick={onClose}>Cancel</button>
        </div>
      </div>
    </Modal>
  );
}
