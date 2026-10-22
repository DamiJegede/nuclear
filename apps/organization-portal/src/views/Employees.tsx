import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, type Api, type Employee } from "../api";
import { int, money } from "../format";
import { usePageTitle } from "../title";
import { useList } from "../useList";
import { usePaged } from "../usePaged";
import { BulkModal, type BulkKind } from "./BulkActions";
import { EditFixedBenefit, UploadFixedBenefits } from "./FixedBenefits";
import { Modal } from "./Modal";

type Filter = "" | "claimed" | "unclaimed";

/** Everyone the organization has credited: who has claimed, and how much is held for those who have not. */
export function Employees({ api, onError }: { api: Api; onError: (e: unknown) => void }) {
  usePageTitle("Employees");
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<Filter>("");
  const { rows: data, total, hasMore, more, failed, retry, loadMore } = usePaged<Employee>(useCallback(async (cursor?: string) => { const r = await api.employees(q.trim(), status, cursor); return { items: r.employees, next: r.next_cursor, total: r.total }; }, [api, q, status]), onError);
  const program = useList(useCallback(async () => ({ p: await api.program() }), [api]), onError, "program");
  const fixedMode = program.data?.p.mode === "fixed";
  const [uploading, setUploading] = useState(false);
  const [editing, setEditing] = useState<Employee | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [bulk, setBulk] = useState<BulkKind | null>(null);
  const allBox = useRef<HTMLInputElement>(null);
  const [remove, setRemove] = useState<Employee | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const rows = data ?? [];
  const selected = rows.filter((e) => picked.has(e.id));            // only what is on screen counts
  const allPicked = rows.length > 0 && selected.length === rows.length;
  useEffect(() => { if (allBox.current) allBox.current.indeterminate = selected.length > 0 && !allPicked; }, [selected.length, allPicked]);
  const toggle = (id: string) => setPicked((p) => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const toggleAll = () => setPicked(allPicked ? new Set() : new Set(rows.map((e) => e.id)));

  async function confirmRemove() {
    if (!remove) return;
    setBusy(true); setError(null);
    try { await api.removeEmployee(remove.id); setRemove(null); retry(); }
    catch (e) {
      onError(e);
      setError(e instanceof ApiError && e.status === 404 ? "They no longer exist. Refresh the page." : "Couldn't remove them. Try again.");
    } finally { setBusy(false); }
  }

  return (
    <section>
      <div className="head"><h1>Employees</h1>{fixedMode && <div className="head-actions"><button type="button" onClick={() => setUploading(true)}>Upload Fixed Benefits</button></div>}</div>
      <div className="filters">
        <input type="search" aria-label="Search employees" placeholder="Search name, email or ID" value={q} maxLength={80} onChange={(e) => setQ(e.target.value)} />
        <select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value as Filter)}>
          <option value="">ALL</option><option value="claimed">CLAIMED</option><option value="unclaimed">NOT CLAIMED</option>
        </select>
      </div>
      {selected.length > 0 && (
        <div className="bulkbar" role="toolbar" aria-label="Selected employees">
          <strong>{int(selected.length)} selected</strong>
          <div className="bulk-actions">
            {fixedMode && <button type="button" onClick={() => setBulk("set_fixed")}>Set Fixed Benefit</button>}
            {fixedMode && <button type="button" className="ghost" onClick={() => setBulk("clear_fixed")}>Clear Fixed Benefit</button>}
            <button type="button" className="ghost" onClick={() => setBulk("remove")}>Remove</button>
            <button type="button" className="link" onClick={() => setPicked(new Set())}>Clear Selection</button>
          </div>
        </div>
      )}
      <div className="card flush">
        {failed && !data ? <p className="error pad" role="alert">Couldn't load employees. <button className="link" onClick={retry}>Try Again</button></p>
          : !data ? <p className="muted pad" role="status">Loading…</p>
          : data.length === 0 ? <p className="muted pad">{q || status ? "No employees match." : "No employees yet. Upload a benefits CSV to add them."}</p>
          : (
            <table>
              <thead><tr><th scope="col" className="check-col"><input ref={allBox} type="checkbox" aria-label="Select all employees" checked={allPicked} onChange={toggleAll} /></th><th scope="col">Name</th><th scope="col">Employee ID</th><th scope="col">Email</th><th scope="col">Status</th>{fixedMode && <th scope="col" className="num">Fixed Benefit</th>}<th scope="col" className="num">Held</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
              <tbody>
                {data.map((e) => (
                  <tr key={e.id} className={picked.has(e.id) ? "picked" : undefined}>
                    <td className="check-col"><input type="checkbox" aria-label={`Select ${e.name}`} checked={picked.has(e.id)} onChange={() => toggle(e.id)} /></td>
                    <th scope="row">{e.name}</th>
                    <td>{e.employee_id}</td>
                    <td>{e.email}</td>
                    <td>{e.claimed ? "Claimed" : "Not claimed"}</td>
                    {fixedMode && <td className="num">{e.fixed_benefit ? money(e.fixed_benefit) : <span className="dim">—</span>} <button type="button" className="link" aria-label={`Edit fixed benefit for ${e.name}`} onClick={() => setEditing(e)}>Edit</button></td>}
                    <td className="num">{e.claimed ? "—" : money(e.balance)}</td>
                    <td className="actions"><button type="button" className="ghost" onClick={() => { setError(null); setRemove(e); }}>Remove</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
      </div>
      {data && data.length > 0 && (
        <p className="more">
          <span className="muted">Showing {int(data.length)} of {int(total)}</span>
          {hasMore && <button type="button" className="ghost" disabled={more} onClick={() => void loadMore()}>{more ? "Loading…" : "Load More"}</button>}
        </p>
      )}
      {bulk && <BulkModal api={api} kind={bulk} selected={selected} onClose={() => setBulk(null)} onDone={() => { setBulk(null); setPicked(new Set()); retry(); program.retry(); }} onError={onError} />}
      {uploading && <UploadFixedBenefits api={api} onClose={() => setUploading(false)} onDone={() => { setUploading(false); retry(); program.retry(); }} onError={onError} />}
      {editing && <EditFixedBenefit api={api} employee={editing} onClose={() => setEditing(null)} onDone={() => { setEditing(null); retry(); program.retry(); }} onError={onError} />}
      {remove && (
        <Modal title="Remove Employee" onClose={() => setRemove(null)} locked={busy}>
          <p>Remove <strong>{remove.name}</strong>? They disappear from this list and are no longer paid a fixed benefit. Adding their employee ID to a later file brings them back.</p>
          {!remove.claimed && remove.balance > 0 && <p className="hint" role="status">{money(remove.balance)} of credit is held for them. It stays theirs: they can still claim it with their link.</p>}
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
