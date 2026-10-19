import { useCallback, useState } from "react";
import type { Api, Employee } from "../api";
import { money } from "../format";
import { usePageTitle } from "../title";
import { useList } from "../useList";
import { RefreshButton } from "./RefreshButton";

type Filter = "" | "claimed" | "unclaimed";

/** Everyone the organization has credited: who has claimed, and how much is held for those who have not. */
export function Employees({ api, onError }: { api: Api; onError: (e: unknown) => void }) {
  usePageTitle("Employees");
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<Filter>("");
  const { data, failed, retry } = useList<Employee[]>(useCallback(() => api.employees(q.trim(), status), [api, q, status]), onError, `employees:${status}:${q.trim()}`);

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
          : data.length === 0 ? <p className="muted pad">{q || status ? "No employees match." : "No employees yet. Upload a credit CSV to add them."}</p>
          : (
            <table>
              <thead><tr><th scope="col">Name</th><th scope="col">Employee ID</th><th scope="col">Email</th><th scope="col">Status</th><th scope="col" className="num">Held</th></tr></thead>
              <tbody>
                {data.map((e) => (
                  <tr key={e.id}>
                    <th scope="row">{e.name}</th>
                    <td>{e.employee_id}</td>
                    <td>{e.email}</td>
                    <td>{e.claimed ? "Claimed" : "Not claimed"}</td>
                    <td className="num">{e.claimed ? "—" : money(e.balance)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
      </div>
    </section>
  );
}
