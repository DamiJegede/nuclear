import { useCallback, useEffect, useState, type FormEvent } from "react";
import { ApiError, type AdminRow, type Api, type Credentials } from "../api";
import { CredentialsPanel } from "./Credentials";

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : "Never");

export function Admins({ api, onError }: { api: Api; onError: (e: unknown) => void }) {
  const [rows, setRows] = useState<AdminRow[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [issued, setIssued] = useState<{ name: string; credentials: Credentials } | null>(null);

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
                <th scope="col">Two-step</th>
                <th scope="col">Last sign-in</th>
                <th scope="col">Added by</th>
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
                    {a.must_change_access_token && <span className="muted note">has not signed in yet</span>}
                  </td>
                  <td>{a.mfa_enabled ? "On" : "Not set up"}</td>
                  <td>{when(a.last_login_at)}</td>
                  <td>{a.created_by ?? "Operator"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

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

function NewAdminForm({
  api, onError, onCreated,
}: { api: Api; onError: (e: unknown) => void; onCreated: (name: string, c: Credentials) => void }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const n = name.trim();
    if (!n) return setError("Enter the person's name.");
    setBusy(true);
    setError(null);
    try {
      const r = await api.createAdmin(n);
      setName("");
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
      {error && <p className="error" role="alert">{error}</p>}
      <button type="submit" disabled={busy}>{busy ? "Creating…" : "Create admin"}</button>
      <p className="hint">The system generates a 12-character Access ID and a 32-character Access Token and shows them once, with a download. The new admin replaces the token and sets up two-step verification the first time they sign in.</p>
    </form>
  );
}
