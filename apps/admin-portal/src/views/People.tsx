import { useCallback, useEffect, useRef, useState } from "react";
import type { Api, MerchantRow, UserRow } from "../api";
import { int, money } from "../format";

const joined = (iso: string) => new Date(iso).toLocaleDateString();
const statusPill = (s: string) => <span className={`pill ${s === "active" ? "available" : "closed"}`}>{s}</span>;

/** Shared by Merchants and Users: a name filter (typed, sent to the API after a short pause) over a table. */
function useFiltered<T>(load: (q: string) => Promise<T[]>, onError: (e: unknown) => void) {
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<T[] | null>(null);
  const [failed, setFailed] = useState(false);
  const seq = useRef(0);

  const run = useCallback(async (term: string) => {
    const mine = ++seq.current;
    try {
      const r = await load(term);
      if (mine === seq.current) { setRows(r); setFailed(false); }
    } catch (e) {
      if (mine === seq.current) { setFailed(true); onError(e); }
    }
  }, [load, onError]);

  useEffect(() => {
    const t = setTimeout(() => void run(q.trim()), q ? 250 : 0);
    return () => clearTimeout(t);
  }, [q, run]);

  return { q, setQ, rows, failed, retry: () => void run(q.trim()) };
}

function FilterBox({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <div className="filter-box">
      <input type="search" aria-label={label} placeholder="Filter by name" value={value} onChange={(e) => onChange(e.target.value)} autoComplete="off" spellCheck={false} />
    </div>
  );
}

export function Merchants({ api, onError, open }: { api: Api; onError: (e: unknown) => void; open?: (id: string) => void }) {
  const load = useCallback((q: string) => api.merchants(q || undefined), [api]);
  const { q, setQ, rows, failed, retry } = useFiltered<MerchantRow>(load, onError);
  return (
    <section>
      <div className="head"><h1>Merchants</h1></div>
      <FilterBox label="Filter merchants by name" value={q} onChange={setQ} />
      <div className="card flush">
        {failed && !rows ? <p className="error pad" role="alert">Couldn't load merchants. <button className="link" onClick={retry}>Try Again</button></p>
          : !rows ? <p className="muted pad" role="status">Loading…</p>
          : rows.length === 0 ? <p className="muted pad">{q ? "No merchants match that name." : "No merchants yet."}</p>
          : (
            <table>
              <thead>
                <tr>
                  <th scope="col">Name</th><th scope="col">Handle</th><th scope="col">Status</th>
                  <th scope="col" className="num">Balance</th><th scope="col" className="num">Terminals</th>
                  <th scope="col" className="num">Payments</th><th scope="col" className="num">Volume</th><th scope="col">Joined</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((m) => (
                  <tr key={m.id}>
                    <th scope="row">{open ? <a className="row-link" href={`/merchants/${m.id}`} onClick={(e) => { e.preventDefault(); open(m.id); }}>{m.name}</a> : m.name}</th>
                    <td>{m.handle ? `@${m.handle}` : "—"}</td>
                    <td>{statusPill(m.status)}</td>
                    <td className="num">{money(m.balance)}</td>
                    <td className="num">{int(m.terminals)}</td>
                    <td className="num">{int(m.payments)}</td>
                    <td className="num">{money(m.volume)}</td>
                    <td>{joined(m.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
      </div>
    </section>
  );
}

export function Users({ api, onError, open }: { api: Api; onError: (e: unknown) => void; open?: (id: string) => void }) {
  const load = useCallback((q: string) => api.users(q || undefined), [api]);
  const { q, setQ, rows, failed, retry } = useFiltered<UserRow>(load, onError);
  return (
    <section>
      <div className="head"><h1>Users</h1></div>
      <FilterBox label="Filter users by name" value={q} onChange={setQ} />
      <div className="card flush">
        {failed && !rows ? <p className="error pad" role="alert">Couldn't load users. <button className="link" onClick={retry}>Try Again</button></p>
          : !rows ? <p className="muted pad" role="status">Loading…</p>
          : rows.length === 0 ? <p className="muted pad">{q ? "No users match that name." : "No users yet."}</p>
          : (
            <table>
              <thead>
                <tr>
                  <th scope="col">Name</th><th scope="col">Handle</th><th scope="col">Email</th><th scope="col">Status</th>
                  <th scope="col" className="num">Balance</th><th scope="col" className="num">Wallets</th>
                  <th scope="col" className="num">Agents</th><th scope="col">Joined</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((u) => (
                  <tr key={u.id}>
                    <th scope="row">{open ? <a className="row-link" href={`/users/${u.id}`} onClick={(e) => { e.preventDefault(); open(u.id); }}>{u.name}</a> : u.name}</th>
                    <td>{u.handle ? `@${u.handle}` : "—"}</td>
                    <td>{u.email ?? "—"}</td>
                    <td>{statusPill(u.status)}</td>
                    <td className="num">{money(u.balance)}</td>
                    <td className="num">{int(u.wallets)}</td>
                    <td className="num">{int(u.agents)}</td>
                    <td>{joined(u.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
      </div>
    </section>
  );
}
