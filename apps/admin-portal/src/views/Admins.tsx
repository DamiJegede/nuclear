import { useCallback, useEffect, useState, type FormEvent } from "react";
import { ApiError, type AdminMe, type AdminRow, type Api, type Credentials } from "../api";
import { ROLES, ROLE_LABEL, ROLE_SUMMARY, type Role } from "../roles";
import { CredentialsPanel } from "./Credentials";
import { Modal } from "./Modal";

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : "Never");

export function Admins({ api, me, onError }: { api: Api; me: AdminMe; onError: (e: unknown) => void }) {
  const [rows, setRows] = useState<AdminRow[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [issued, setIssued] = useState<{ name: string; credentials: Credentials } | null>(null);
  const [rotation, setRotation] = useState<{ admin: AdminRow; credentials?: Credentials } | null>(null);
  const [rotating, setRotating] = useState(false);
  const [rotateError, setRotateError] = useState<string | null>(null);
  const [roleFor, setRoleFor] = useState<AdminRow | null>(null);

  async function rotate(a: AdminRow) {
    setRotating(true);
    setRotateError(null);
    try {
      const r = await api.rotateAccessToken(a.id);
      setRotation({ admin: a, credentials: r.credentials });
      void load();
    } catch (e) {
      onError(e);
      setRotateError("Couldn't rotate the Access Token. Try again.");
    } finally {
      setRotating(false);
    }
  }

  const load = useCallback(async () => {
    try {
      setRows(await api.admins());
      setFailed(false);
    } catch (e) {
      setFailed(true);
      onError(e);
    }
  }, [api, onError]);

  useEffect(() => { void load(); }, [load]);

  return (
    <section>
      <div className="head"><h1>Admins</h1></div>

      <div className="card flush">
        {failed && !rows ? (
          <p className="error pad" role="alert">Couldn't load admins. <button className="link" onClick={() => void load()}>Try again</button></p>
        ) : !rows ? (
          <p className="muted pad" role="status">Loading…</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th scope="col">Access ID</th>
                <th scope="col">Name</th>
                <th scope="col">Status</th>
                <th scope="col">Role</th>
                <th scope="col">Last sign-in</th>
                <th scope="col">Added by</th>
                <th scope="col"><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((a) => (
                <tr key={a.id}>
                  <th scope="row"><code>{a.access_id}</code></th>
                  <td>{a.name}</td>
                  <td>
                    <span className={`pill ${a.status === "active" ? "available" : "closed"}`}>{a.status}</span>
                    {a.locked && <span className="pill pending"> locked</span>}
                    {!a.last_login_at && <span className="muted note">has not signed in yet</span>}
                  </td>
                  <td><span className="pill role">{ROLE_LABEL[a.role]}</span></td>
                  <td>{when(a.last_login_at)}</td>
                  <td>{a.created_by ?? "Operator"}</td>
                  <td className="actions">
                    {a.access_id !== me.access_id && (
                      <button type="button" className="ghost" aria-label={`Change role for ${a.name}`} onClick={() => setRoleFor(a)}>Change Role</button>
                    )}{" "}
                    <button type="button" className="ghost" aria-label={`Rotate Access Token for ${a.name}`} onClick={() => { setRotateError(null); setRotation({ admin: a }); }}>Rotate Access Token</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {rotation && (
        <Modal title={rotation.credentials ? `New Access Token for ${rotation.admin.name}` : "Rotate Access Token"} locked={!!rotation.credentials || rotating} onClose={() => setRotation(null)}>
          {rotation.credentials ? (
            <CredentialsPanel
              name={rotation.admin.name}
              credentials={rotation.credentials}
              onDone={() => { setRotation(null); void load(); }}
            />
          ) : (
            <>
              <p>Replace <strong>{rotation.admin.name}</strong>'s Access Token? The current one stops working straight away and any sessions they have are signed out. The new token is shown once.</p>
              {rotateError && <p className="error" role="alert">{rotateError}</p>}
              <div className="modal-actions">
                <button type="button" disabled={rotating} onClick={() => void rotate(rotation.admin)}>{rotating ? "Rotating…" : "Confirm rotate"}</button>
                <button type="button" className="ghost" disabled={rotating} onClick={() => setRotation(null)}>Cancel</button>
              </div>
            </>
          )}
        </Modal>
      )}
      {roleFor && (
        <RoleModal api={api} admin={roleFor} onClose={() => setRoleFor(null)} onError={onError} onDone={() => { setRoleFor(null); void load(); }} />
      )}
      {issued ? (
        <div className="card form">
          <h2>New admin created</h2>
          <CredentialsPanel
            name={issued.name}
            credentials={issued.credentials}
            onDone={() => { setIssued(null); void load(); }}
          />
        </div>
      ) : (
        <NewAdminForm api={api} onError={onError} onCreated={(name, credentials) => { setIssued({ name, credentials }); void load(); }} />
      )}
    </section>
  );
}

/** Pick one of the roles, each with a line saying what it can open. */
function RolePicker({ value, onChange }: { value: Role | ""; onChange: (r: Role) => void }) {
  return (
    <fieldset className="role-field">
      <legend>Role</legend>
      <div className="role-list" role="radiogroup" aria-label="Role">
        {ROLES.map((r) => (
          <label key={r} className="role-option">
            <input type="radio" name="role" value={r} checked={value === r} onChange={() => onChange(r)} />
            <span className="role-name">{ROLE_LABEL[r]}</span>
            <span className="role-sum">{ROLE_SUMMARY[r]}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function RoleModal({ api, admin, onClose, onDone, onError }: { api: Api; admin: AdminRow; onClose: () => void; onDone: () => void; onError: (e: unknown) => void }) {
  const [role, setRole] = useState<Role>(admin.role);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function save() {
    setBusy(true);
    setError(null);
    try {
      await api.setAdminRole(admin.id, role);
      onDone();
    } catch (e) {
      onError(e);
      setError(e instanceof ApiError && e.code === "cannot_change_own_role" ? "You can't change your own role." : "Couldn't change the role. Try again.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title={`Role for ${admin.name}`} onClose={onClose} locked={busy}>
      <RolePicker value={role} onChange={setRole} />
      <p className="muted">It takes effect on their next request; they don't need to sign in again.</p>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="modal-actions">
        <button type="button" disabled={busy || role === admin.role} onClick={() => void save()}>{busy ? "Saving…" : "Save Role"}</button>
        <button type="button" className="ghost" disabled={busy} onClick={onClose}>Cancel</button>
      </div>
    </Modal>
  );
}

function NewAdminForm({
  api, onError, onCreated,
}: { api: Api; onError: (e: unknown) => void; onCreated: (name: string, c: Credentials) => void }) {
  const [name, setName] = useState("");
  const [role, setRole] = useState<Role | "">("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const n = name.trim();
    if (!n) return setError("Enter the person's name.");
    if (!role) return setError("Choose a role.");
    setBusy(true);
    setError(null);
    try {
      const r = await api.createAdmin(n, role);
      setName(""); setRole("");
      onCreated(r.admin.name, r.credentials);
    } catch (err) {
      onError(err);
      setError(err instanceof ApiError && err.status === 400 ? "The API rejected that name." : "Couldn't create the admin. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card form" onSubmit={submit} aria-labelledby="new-admin">
      <h2 id="new-admin">Add an admin</h2>
      <div className="fields">
        <label className="wide">Full name<input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} /></label>
      </div>
      <RolePicker value={role} onChange={setRole} />
      {error && <p className="error" role="alert">{error}</p>}
      <button type="submit" disabled={busy}>{busy ? "Creating…" : "Create admin"}</button>
      <p className="hint">The system generates a 12-character Access ID and a 32-character Access Token and shows them once, with a download. The new admin sets up two-step verification the first time they sign in.</p>
    </form>
  );
}
