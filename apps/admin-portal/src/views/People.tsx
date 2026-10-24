import { useCallback, useEffect, useState } from "react";
import { usePaged, type Page } from "../usePaged";
import type { Api, MerchantRow, OrganizationRow, UserRow } from "../api";
import { int, money } from "../format";
import { EmailMerchants } from "./EmailMerchants";

const joined = (iso: string) => new Date(iso).toLocaleDateString();
const statusPill = (s: string) => <span className={`pill ${s === "active" ? "available" : s === "pending" ? "pending" : "closed"}`}>{s}</span>;

/** Shared by Merchants, Users and Organizations: a name filter (typed, sent to the API after a short pause) over a table that loads a page at a time. */
function useFiltered<T>(load: (q: string, cursor?: string) => Promise<Page<T>>, onError: (e: unknown) => void) {
  const [q, setQ] = useState("");
  const [term, setTerm] = useState("");
  useEffect(() => { const t = setTimeout(() => setTerm(q.trim()), q ? 250 : 0); return () => clearTimeout(t); }, [q]);
  const paged = usePaged<T>(useCallback((cursor?: string) => load(term, cursor), [load, term]), onError);
  return { q, setQ, ...paged };
}

function More({ shown, total, hasMore, more, loadMore }: { shown: number; total: number; hasMore: boolean; more: boolean; loadMore: () => Promise<void> }) {
  return (
    <p className="more">
      <span className="muted">Showing {int(shown)} of {int(total)}</span>
      {hasMore && <button type="button" className="ghost" disabled={more} onClick={() => void loadMore()}>{more ? "Loading…" : "Load More"}</button>}
    </p>
  );
}

function FilterBox({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <div className="filter-box">
      <input type="search" aria-label={label} placeholder="Filter by name" value={value} onChange={(e) => onChange(e.target.value)} autoComplete="off" spellCheck={false} />
    </div>
  );
}

export function Merchants({ api, onError, open, canEmail = false }: { api: Api; onError: (e: unknown) => void; open?: (id: string) => void; canEmail?: boolean }) {
  const [emailing, setEmailing] = useState(false);
  const load = useCallback(async (q: string, cursor?: string) => { const r = await api.merchants(q || undefined, cursor); return { items: r.merchants, next: r.next_cursor, total: r.total }; }, [api]);
  const { q, setQ, rows, total, hasMore, more, failed, retry, loadMore } = useFiltered<MerchantRow>(load, onError);
  return (
    <section>
      <div className="head">
        <h1>Merchants</h1>
        {canEmail && <div className="head-actions"><button type="button" onClick={() => setEmailing(true)}>Email Merchants</button></div>}
      </div>
      {emailing && <EmailMerchants api={api} target={{ kind: "many" }} onClose={() => setEmailing(false)} onError={onError} />}
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
      {rows && rows.length > 0 && <More shown={rows.length} total={total} hasMore={hasMore} more={more} loadMore={loadMore} />}
    </section>
  );
}

export function Users({ api, onError, open }: { api: Api; onError: (e: unknown) => void; open?: (id: string) => void }) {
  const load = useCallback(async (q: string, cursor?: string) => { const r = await api.users(q || undefined, cursor); return { items: r.users, next: r.next_cursor, total: r.total }; }, [api]);
  const { q, setQ, rows, total, hasMore, more, failed, retry, loadMore } = useFiltered<UserRow>(load, onError);
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
      {rows && rows.length > 0 && <More shown={rows.length} total={total} hasMore={hasMore} more={more} loadMore={loadMore} />}
    </section>
  );
}

export function Organizations({ api, onError, open }: { api: Api; onError: (e: unknown) => void; open?: (id: string) => void }) {
  const load = useCallback(async (q: string, cursor?: string) => { const r = await api.organizations(q || undefined, cursor); return { items: r.organizations, next: r.next_cursor, total: r.total }; }, [api]);
  const { q, setQ, rows, total, hasMore, more, failed, retry, loadMore } = useFiltered<OrganizationRow>(load, onError);
  return (
    <section>
      <div className="head"><h1>Organizations</h1></div>
      <FilterBox label="Filter organizations by name or email" value={q} onChange={setQ} />
      <div className="card flush">
        {failed && !rows ? <p className="error pad" role="alert">Couldn't load organizations. <button className="link" onClick={retry}>Try Again</button></p>
          : !rows ? <p className="muted pad" role="status">Loading…</p>
          : rows.length === 0 ? <p className="muted pad">{q ? "No organizations match that." : "No organizations yet."}</p>
          : (
            <table>
              <thead>
                <tr>
                  <th scope="col">Name</th><th scope="col">Email</th><th scope="col">Status</th><th scope="col">Benefits</th>
                  <th scope="col" className="num">Wallet</th><th scope="col" className="num">Employees</th><th scope="col" className="num">Claimed</th>
                  <th scope="col" className="num">Held</th><th scope="col">Joined</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((o) => (
                  <tr key={o.id}>
                    <th scope="row">{open ? <a className="row-link" href={`/organizations/${o.id}`} onClick={(e) => { e.preventDefault(); open(o.id); }}>{o.name}</a> : o.name}</th>
                    <td>{o.email ?? "—"}</td>
                    <td>{statusPill(o.status)}</td>
                    <td>{o.chosen ? <span className="pill">{o.mode}</span> : <span className="muted">Not chosen</span>}</td>
                    <td className="num">{money(o.balance)}</td>
                    <td className="num">{int(o.employees)}</td>
                    <td className="num">{int(o.claimed)}</td>
                    <td className="num">{money(o.held)}</td>
                    <td>{joined(o.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
      </div>
      {rows && rows.length > 0 && <More shown={rows.length} total={total} hasMore={hasMore} more={more} loadMore={loadMore} />}
    </section>
  );
}
