import { useCallback, useState } from "react";
import { RefreshButton } from "./RefreshButton";
import { ApiError, type Api, type HandleLookup, type StaffMember } from "../api";
import { usePageTitle } from "../title";
import { useList, day } from "../useList";
import { Modal } from "./Modal";

const ROLE_TEXT = { read: "Read: can look up orders", write: "Write: can approve refunds with a tap" } as const;

/** People who work for the business: add by handle, change between read and write, remove. */
export function Staff({ api, onError }: { api: Api; onError: (e: unknown) => void }) {
  usePageTitle("Staff");
  const { data, failed, retry } = useList<StaffMember[]>(useCallback(() => api.staff(), [api]), onError, "staff");
  const [adding, setAdding] = useState(false);
  const [remove, setRemove] = useState<StaffMember | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function setRole(s: StaffMember, role: "read" | "write") {
    try { await api.setStaffRole(s.id, role); retry(); } catch (e) { onError(e); setError("Couldn't change the role. Try again."); }
  }
  async function confirmRemove() {
    if (!remove) return;
    setBusy(true); setError(null);
    try { await api.removeStaff(remove.id); setRemove(null); retry(); }
    catch (e) { onError(e); setError("Couldn't remove them. Try again."); }
    finally { setBusy(false); }
  }

  return (
    <section>
      <div className="head"><h1>Staff</h1><div className="head-actions"><button type="button" onClick={() => setAdding(true)}>Add Staff</button><RefreshButton onClick={retry} /></div></div>
      {error && !remove && <p className="error" role="alert">{error}</p>}
      <div className="card flush">
        {failed && !data ? <p className="error pad" role="alert">Couldn't load staff. <button className="link" onClick={retry}>Try Again</button></p>
          : !data ? <p className="muted pad" role="status">Loading…</p>
          : data.length === 0 ? <p className="muted pad">No staff yet. Add people by their Nuclear handle.</p>
          : (
            <table>
              <thead><tr><th scope="col">Name</th><th scope="col">Handle</th><th scope="col">Role</th><th scope="col">Added</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
              <tbody>
                {data.map((s) => (
                  <tr key={s.id}>
                    <th scope="row">{s.name ?? "—"}</th>
                    <td>{s.handle ? `@${s.handle}` : "—"}</td>
                    <td>
                      <select aria-label={`Role for ${s.name ?? "staff member"}`} value={s.role} onChange={(e) => void setRole(s, e.target.value as "read" | "write")}>
                        <option value="read">READ</option><option value="write">WRITE</option>
                      </select>
                    </td>
                    <td className="when">{day(s.created_at)}</td>
                    <td className="actions"><button type="button" className="ghost" onClick={() => { setError(null); setRemove(s); }}>Remove</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
      </div>
      {adding && <AddStaff api={api} onClose={() => setAdding(false)} onError={onError} onAdded={() => { setAdding(false); retry(); }} />}
      {remove && (
        <Modal title="Remove Staff" onClose={() => setRemove(null)} locked={busy}>
          <p>Remove <strong>{remove.name ?? "this person"}</strong> from your staff? They can no longer approve refunds for you.</p>
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

function AddStaff({ api, onAdded, onClose, onError }: { api: Api; onAdded: () => void; onClose: () => void; onError: (e: unknown) => void }) {
  const [handle, setHandle] = useState("");
  const [found, setFound] = useState<HandleLookup | null>(null);
  const [role, setRole] = useState<"read" | "write">("read");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function look() {
    setError(null); setFound(null);
    const h = handle.trim().replace(/^@/, "").toLowerCase();
    if (!/^[a-z0-9]{4,12}$/.test(h)) return setError("A handle is 4 to 12 lowercase letters and numbers.");
    setBusy(true);
    try {
      const r = await api.lookupHandle(h);
      if (r.type !== "C") setError("Staff must be personal accounts, not businesses."); else setFound(r);
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) setError("No one has that handle.");
      else if (e instanceof ApiError && e.status === 429) setError("Too many lookups. Wait a minute.");
      else { onError(e); setError("Couldn't look that up. Try again."); }
    } finally { setBusy(false); }
  }
  async function add() {
    if (!found) return;
    setBusy(true); setError(null);
    try { await api.addStaff(found.account_id, role); onAdded(); }
    catch (e) { onError(e); setError(e instanceof ApiError && e.code === "already_staff" ? "They are already on your staff." : "Couldn't add them. Try again."); }
    finally { setBusy(false); }
  }
  return (
    <Modal title="Add Staff" onClose={onClose} locked={busy}>
      <div className="modal-form">
        <label>Handle
          <div className="inline">
            <input value={handle} maxLength={13} placeholder="@handle" autoCapitalize="none" spellCheck={false} onChange={(e) => { setHandle(e.target.value.toLowerCase()); setFound(null); }} />
            <button type="button" className="ghost" disabled={busy || !handle.trim()} onClick={() => void look()}>Find</button>
          </div>
        </label>
        {found && (
          <>
            <p className="notice ok-note" role="status">Found <strong>{found.display_name}</strong> (@{found.handle}).</p>
            <label>Role
              <select value={role} onChange={(e) => setRole(e.target.value as "read" | "write")}>
                <option value="read">READ</option><option value="write">WRITE</option>
              </select>
            </label>
            <p className="hint">{ROLE_TEXT[role]}</p>
          </>
        )}
        {error && <p className="error" role="alert">{error}</p>}
        <div className="modal-actions">
          <button type="button" disabled={busy || !found} onClick={() => void add()}>{busy ? "Adding…" : "Add Staff"}</button>
          <button type="button" className="ghost" disabled={busy} onClick={onClose}>Cancel</button>
        </div>
      </div>
    </Modal>
  );
}
