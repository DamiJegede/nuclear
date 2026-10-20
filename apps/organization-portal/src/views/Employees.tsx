import { useCallback, useState } from "react";
import { ApiError, type Api, type Employee } from "../api";
import { money } from "../format";
import { usePageTitle } from "../title";
import { useList } from "../useList";
import { Modal } from "./Modal";
import { RefreshButton } from "./RefreshButton";

type Filter = "" | "claimed" | "unclaimed";

/** Everyone the organization has credited: who has claimed, and how much is held for those who have not. */
export function Employees({ api, onError }: { api: Api; onError: (e: unknown) => void }) {
  usePageTitle("Employees");
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<Filter>("");
  const { data, failed, retry } = useList<Employee[]>(useCallback(() => api.employees(q.trim(), status), [api, q, status]), onError, `employees:${status}:${q.trim()}`);
  const [remove, setRemove] = useState<Employee | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirmRemove() {
    if (!remove) return;
    setBusy(true); setError(null);
    try { await api.removeEmployee(remove.id); setRemove(null); retry(); }
    catch (e) {
      onError(e);
      setError(e instanceof ApiError && e.code === "has_held_balance" ? "Money is still held for them. They need to claim it before they can be removed." : "Couldn't remove them. Try again.");
    } finally { setBusy(false); }
  }

  return (
    <section>
      <div className="head"><h1>Employees</h1><div className="head-actions"><RefreshButton onClick={retry} /></div></div>
      <div className="filters">
        <input type="search" aria-label="Search employees" placeholder="Search name, email or ID" value={q} maxLength={80} onChange={(e) => setQ(e.target.value)} />
        <select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value as Filter)}>
          <option value="">ALL</option><option value="claimed">CLAIMED</option><option value="unclaimed">NOT CLAIMED</option>
        </select>
      </div>
      <div className="card flush">
        {failed && !data ? <p className="error pad" role="alert">Couldn't load employees. <button className="link" onClick={retry}>Try Again</button></p>
          : !data ? <p className="muted pad" role="status">Loading…</p>
          : data.length === 0 ? <p className="muted pad">{q || status ? "No employees match." : "No employees yet. Upload a benefits CSV to add them."}</p>
          : (
            <table>
              <thead><tr><th scope="col">Name</th><th scope="col">Employee ID</th><th scope="col">Email</th><th scope="col">Status</th><th scope="col" className="num">Held</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
              <tbody>
                {data.map((e) => (
                  <tr key={e.id}>
                    <th scope="row">{e.name}</th>
                    <td>{e.employee_id}</td>
                    <td>{e.email}</td>
                    <td>{e.claimed ? "Claimed" : "Not claimed"}</td>
                    <td className="num">{e.claimed ? "—" : money(e.balance)}</td>
                    <td className="actions"><button type="button" className="ghost" onClick={() => { setError(null); setRemove(e); }}>Remove</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
      </div>
      {remove && (
        <Modal title="Remove Employee" onClose={() => setRemove(null)} locked={busy}>
          <p>Remove <strong>{remove.name}</strong>? They disappear from this list and stop getting reminders. Adding their employee ID to a later CSV brings them back.</p>
          {remove.balance > 0 && <p className="error">Money is held for them, so they can't be removed until they claim it.</p>}
          {error && <p className="error" role="alert">{error}</p>}
          <div className="modal-actions">
            <button type="button" disabled={busy} onClick={() => void confirmRemove()}>{busy ? "Removing…" : "Confirm Remove"}</button>
            <button type="button" className="ghost" disabled={busy} onClick={() => setRemove(null)}>Cancel</button>
          </div>
        </Modal>
      )}
    </section>
  );
}
