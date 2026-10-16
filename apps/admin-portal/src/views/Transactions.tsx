import { useCallback, useEffect, useState } from "react";
import type { Api, TxKind, TxPage, TxRow } from "../api";
import { int, money } from "../format";

const KINDS: { kind: TxKind; label: string }[] = [
  { kind: "all", label: "All" }, { kind: "sends", label: "Sends" }, { kind: "taps", label: "Taps" },
  { kind: "funds", label: "Funds" }, { kind: "agents", label: "Agents" },
];

const pill = (status: string) => (
  <span className={`pill ${status === "completed" ? "available" : status === "failed" ? "closed" : "pending"}`}>{status}</span>
);
const party = (name: string | null, wallet: string | null) =>
  name ? <>{name}{wallet && wallet !== name ? <span className="muted note">{wallet}</span> : null}</> : "—";

export function Transactions({ api, onError }: { api: Api; onError: (e: unknown) => void }) {
  const [kind, setKind] = useState<TxKind>("all");
  const [rows, setRows] = useState<TxRow[] | null>(null);
  const [counts, setCounts] = useState<TxPage["counts"] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [more, setMore] = useState(false);

  const load = useCallback(async (k: TxKind) => {
    setRows(null);
    try {
      const p = await api.transactions(k);
      setRows(p.transactions); setCounts(p.counts); setNext(p.next_cursor); setFailed(false);
    } catch (e) {
      setFailed(true); onError(e);
    }
  }, [api, onError]);

  useEffect(() => { void load(kind); }, [kind, load]);

  async function loadMore() {
    if (!next) return;
    setMore(true);
    try {
      const p = await api.transactions(kind, next);
      setRows((r) => [...(r ?? []), ...p.transactions]); setNext(p.next_cursor);
    } catch (e) {
      onError(e);
    } finally {
      setMore(false);
    }
  }

  return (
    <section>
      <div className="head"><h1>Transactions</h1></div>

      <div className="choice-grid kind-grid" role="radiogroup" aria-label="Show">
        {KINDS.map(({ kind: k, label }) => (
          <label key={k} className="choice kind">
            <input type="radio" name="tx-kind" value={k} checked={kind === k} onChange={() => setKind(k)} />
            <span>{label}</span>
            <span className="kind-count">{counts ? int(counts[k]) : "–"}</span>
          </label>
        ))}
      </div>

      <div className="card flush">
        {failed && !rows ? <p className="error pad" role="alert">Couldn't load transactions. <button className="link" onClick={() => void load(kind)}>Try Again</button></p>
          : !rows ? <p className="muted pad" role="status">Loading…</p>
          : rows.length === 0 ? <p className="muted pad">No transactions here yet.</p>
          : (
            <table>
              <thead>
                <tr>
                  <th scope="col">When</th><th scope="col">Type</th><th scope="col">From</th><th scope="col">To</th>
                  <th scope="col" className="num">Amount</th><th scope="col">Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((t) => (
                  <tr key={t.id}>
                    <td>{new Date(t.timestamp).toLocaleString()}</td>
                    <td>
                      <span className="pill">{t.type}</span>
                      {t.via && <span className="pill via">{t.via}</span>}
                      {t.agent && <span className="pill via">agent</span>}
                    </td>
                    <td>{party(t.from, t.from_wallet)}</td>
                    <td>{party(t.to, t.to_wallet)}</td>
                    <td className="num">{money(t.amount)}</td>
                    <td>{pill(t.status)}{t.status_code && <span className="muted note">{t.status_code}</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
      </div>
      {next && <p className="more"><button type="button" className="ghost" disabled={more} onClick={() => void loadMore()}>{more ? "Loading…" : "Load More"}</button></p>}
    </section>
  );
}
