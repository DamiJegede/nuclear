import { useCallback, useRef, useState, type ReactNode } from "react";
import { ApiError, type Account, type Api, type Device, type OrgDocument, type OrgProfile } from "../api";
import { drop } from "../cache";
import { usePageTitle } from "../title";
import { useList, when } from "../useList";
import { Avatar } from "./Avatar";
import { Modal } from "./Modal";
import { PhotoCrop } from "./PhotoCrop";
import { RefreshButton } from "./RefreshButton";

/** A card whose fields are plain text until "Edit" (top right) is pressed; then it shows input borders and its Save button. */
function EditCard({ title, editing, onToggle, children }: { title: string; editing: boolean; onToggle: () => void; children: ReactNode }) {
  return (
    <div className="card">
      <div className="card-head">
        <h2>{title}</h2>
        <button type="button" className="link edit-link" onClick={onToggle}>{editing ? "Cancel" : "Edit"}</button>
      </div>
      {children}
    </div>
  );
}
const Fact = ({ label, children }: { label: string; children: ReactNode }) => (
  <div className="fact"><dt>{label}</dt><dd>{children || <span className="dim">—</span>}</dd></div>
);

/** The organization's own profile and security: picture, legal details and address, documents, and the sessions signed in to this account. */
export function Profile({ api, account, onChanged, onError }: { api: Api; account: Account; onChanged: () => void; onError: (e: unknown) => void }) {
  usePageTitle("Profile");
  const [n, setN] = useState(0);                       // Refresh rebuilds the cards so each asks the API again
  const refresh = () => { drop("documents", "profile", "devices"); onChanged(); setN((v) => v + 1); };
  return (
    <section>
      <div className="head"><h1>Profile</h1><div className="head-actions"><RefreshButton onClick={refresh} /></div></div>
      <div className="stack" key={n}>
        <Identity api={api} account={account} onChanged={onChanged} onError={onError} />
        <OrganizationDetails api={api} onError={onError} />
        <Documents api={api} onError={onError} />
      </div>
      <Sessions key={n} api={api} onError={onError} />
    </section>
  );
}

function Identity({ api, account, onChanged, onError }: { api: Api; account: Account; onChanged: () => void; onError: (e: unknown) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [editing, setEditing] = useState(false);
  const [crop, setCrop] = useState<File | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  function photo(file: File | undefined) {
    if (!file) return;
    setMsg(null);
    if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) return setMsg("Choose a PNG, JPEG or WebP image.");
    if (file.size > 8 * 1024 * 1024) return setMsg("The image is over 8 MB.");
    setCrop(file);
  }
  return (
    <EditCard title="Organization" editing={editing} onToggle={() => { setEditing((e) => !e); setMsg(null); }}>
      <div className="identity">
        <Avatar name={account.name} photo={account.photo} />
        <div>
          <p className="big small">{account.name}</p>
          <p className="muted">{account.email ?? "—"}{account.phone ? ` · ${account.phone}` : ""}</p>
          {editing && <button type="button" className="ghost" onClick={() => input.current?.click()}>{account.photo ? "Replace Picture" : "Upload Picture"}</button>}
          <input ref={input} type="file" className="sr-only" aria-label="Profile picture" accept="image/png,image/jpeg,image/webp" onChange={(e) => { photo(e.target.files?.[0]); e.target.value = ""; }} />
          {crop && <PhotoCrop file={crop} onClose={() => setCrop(null)} onSave={async (jpeg) => { try { await api.uploadPhoto(jpeg); setCrop(null); onChanged(); } catch (e) { onError(e); throw e; } }} />}
        </div>
      </div>
      {msg && <p className="error" role="alert">{msg}</p>}
    </EditCard>
  );
}

/** Legal name, tax ID, address and website. Plain text until Edit; the tax ID is write-only (only its last four digits are shown). */
function OrganizationDetails({ api, onError }: { api: Api; onError: (e: unknown) => void }) {
  // Wrapped, so "loaded, nothing saved yet" (null) is not mistaken for "still loading".
  const loaded = useList<{ profile: OrgProfile | null }>(useCallback(async () => ({ profile: await api.profile() }), [api]), onError, "profile");
  const { failed, retry } = loaded;
  const data = loaded.data?.profile ?? null;
  const ready = loaded.data !== null;
  const [editing, setEditing] = useState(false);
  const [f, setF] = useState<Record<string, string> | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const form = f ?? {
    legal_name: data?.legal_name ?? "", display_name: data?.display_name ?? "", tax_id: "", address: data?.address ?? "", city: data?.city ?? "",
    state: data?.state ?? "", post_code: data?.post_code ?? "", country: data?.country ?? "US", website: data?.website ?? "",
  };
  const set = (k: string, v: string) => setF({ ...form, [k]: v });
  const toggle = () => { setEditing((e) => !e); setF(null); setMsg(null); };

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    if (!form.legal_name!.trim() || !form.display_name!.trim()) return setMsg("Enter the legal name and the name employees see.");
    if (form.tax_id && !/^[0-9A-Za-z-]{4,20}$/.test(form.tax_id)) return setMsg("The tax ID is 4 to 20 letters, numbers or dashes.");
    if (form.country && form.country.length !== 2) return setMsg("Use the 2-letter country code, like US.");
    if (form.website && !/^https?:\/\/\S+$/.test(form.website)) return setMsg("The website must start with https://");
    setBusy(true);
    try {
      await api.saveProfile({
        legal_name: form.legal_name!.trim(), display_name: form.display_name!.trim(), ...(form.tax_id ? { tax_id: form.tax_id.trim() } : {}),
        address: form.address!.trim() || null, city: form.city!.trim() || null, state: form.state!.trim() || null, post_code: form.post_code!.trim() || null,
        country: form.country!.trim().toUpperCase() || null, website: form.website!.trim() || null,
      });
      setF(null); setEditing(false); retry();
    } catch (err) { onError(err); setMsg("Couldn't save your details. Check each field and try again."); }
    finally { setBusy(false); }
  }

  if (!ready && !failed) return <div className="card"><h2>Organization Details</h2><p className="muted" role="status">Loading…</p></div>;
  return (
    <EditCard title="Organization Details" editing={editing} onToggle={toggle}>
      {editing ? (
        <form onSubmit={save} aria-label="Organization details">
          <div className="fields">
            <label className="wide">Legal name<input value={form.legal_name} maxLength={160} onChange={(e) => set("legal_name", e.target.value)} /></label>
            <label className="wide">Name employees see<input value={form.display_name} maxLength={120} onChange={(e) => set("display_name", e.target.value)} /></label>
            <label className="wide">Tax ID<input value={form.tax_id} maxLength={20} autoComplete="off" placeholder={data?.tax_id_last4 ? `•••• ${data.tax_id_last4} saved. Type to replace` : ""} onChange={(e) => set("tax_id", e.target.value)} /></label>
            <label className="wide">Address<input value={form.address} maxLength={300} onChange={(e) => set("address", e.target.value)} /></label>
            <label>City<input value={form.city} maxLength={100} onChange={(e) => set("city", e.target.value)} /></label>
            <label>State<input value={form.state} maxLength={100} onChange={(e) => set("state", e.target.value)} /></label>
            <label>Post code<input value={form.post_code} maxLength={20} onChange={(e) => set("post_code", e.target.value)} /></label>
            <label>Country<input value={form.country} maxLength={2} onChange={(e) => set("country", e.target.value.toUpperCase())} /></label>
            <label className="wide">Website<input value={form.website} maxLength={200} placeholder="https://" onChange={(e) => set("website", e.target.value)} /></label>
          </div>
          {msg && <p className="error" role="alert">{msg}</p>}
          <button type="submit" disabled={busy}>{busy ? "Saving…" : "Save Details"}</button>
        </form>
      ) : (
        <dl className="facts" aria-label="Organization details">
          <Fact label="Legal name">{data?.legal_name ?? ""}</Fact>
          <Fact label="Name employees see">{data?.display_name ?? ""}</Fact>
          <Fact label="Tax ID">{data?.tax_id_last4 ? `•••• ${data.tax_id_last4}` : ""}</Fact>
          <Fact label="Address">{data?.address ?? ""}</Fact>
          <Fact label="City">{data?.city ?? ""}</Fact>
          <Fact label="State">{data?.state ?? ""}</Fact>
          <Fact label="Post code">{data?.post_code ?? ""}</Fact>
          <Fact label="Country">{data?.country ?? ""}</Fact>
          <Fact label="Website">{data?.website ?? ""}</Fact>
        </dl>
      )}
    </EditCard>
  );
}

function Documents({ api, onError }: { api: Api; onError: (e: unknown) => void }) {
  const { data, failed, retry } = useList<OrgDocument[]>(useCallback(() => api.documents(), [api]), onError, "documents");
  const input = useRef<HTMLInputElement>(null);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function upload(file: File | undefined) {
    if (!file) return;
    setError(null);
    if (file.size > 5 * 1024 * 1024) return setError("The file is over 5 MB.");
    setBusy(true);
    try { await api.uploadDocument(file); retry(); }
    catch (e) { onError(e); setError(e instanceof ApiError && e.code === "unsupported_file_type" ? "Upload a PDF, PNG or JPEG." : "Couldn't upload that file. Try again."); }
    finally { setBusy(false); }
  }
  return (
    <EditCard title="Organization Documents" editing={editing} onToggle={() => { setEditing((e) => !e); setError(null); }}>
      {failed && !data ? <p className="error" role="alert">Couldn't load the documents. <button className="link" onClick={retry}>Try Again</button></p>
        : !data ? <p className="muted" role="status">Loading…</p>
        : data.length === 0 ? <p className="dim">Nothing uploaded.</p>
        : <ul className="doc-list">{data.map((d, i) => <li key={d.id}><span>Document {data.length - i}</span><span className="muted">{when(d.created_at)}</span></li>)}</ul>}
      {editing && (
        <>
          <button type="button" className="ghost" disabled={busy} onClick={() => input.current?.click()}>{busy ? "Uploading…" : "Upload Document"}</button>
          <p className="hint">PDF, PNG or JPEG, up to 5 MB.</p>
        </>
      )}
      <input ref={input} type="file" className="sr-only" aria-label="Organization document" accept=".pdf,.png,.jpg,.jpeg" onChange={(e) => { void upload(e.target.files?.[0]); e.target.value = ""; }} />
      {error && <p className="error" role="alert">{error}</p>}
    </EditCard>
  );
}

function Sessions({ api, onError }: { api: Api; onError: (e: unknown) => void }) {
  const { data, failed, retry } = useList<Device[]>(useCallback(() => api.devices(), [api]), onError, "devices");
  const [target, setTarget] = useState<Device | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function revoke() {
    if (!target) return;
    setBusy(true); setError(null);
    try { await api.revokeDevice(target.id); setTarget(null); retry(); }
    catch (e) { onError(e); setError("Couldn't sign that session out. Try again."); }
    finally { setBusy(false); }
  }
  return (
    <>
      <h2 className="section">Sessions</h2>
      <div className="card flush">
        {failed && !data ? <p className="error pad" role="alert">Couldn't load sessions. <button className="link" onClick={retry}>Try Again</button></p>
          : !data ? <p className="muted pad" role="status">Loading…</p>
          : data.length === 0 ? <p className="muted pad">No sessions.</p>
          : (
            <table>
              <thead><tr><th scope="col">Started</th><th scope="col">Platform</th><th scope="col">Last used</th><th scope="col">Status</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
              <tbody>
                {data.map((d) => {
                  const active = !d.revoked_at && !!d.session_expires_at && new Date(d.session_expires_at) > new Date();
                  return (
                    <tr key={d.id}>
                      <td className="when">{when(d.created_at)}</td>
                      <td>{d.platform ?? "—"}</td>
                      <td className="when">{when(d.last_accessed_at)}</td>
                      <td><span className={`pill ${active ? "available" : "closed"}`}>{active ? "active" : d.revoked_at ? "signed out" : "expired"}</span></td>
                      <td className="actions">{active && <button type="button" className="ghost" onClick={() => { setError(null); setTarget(d); }}>Sign Out</button>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
      </div>
      {target && (
        <Modal title="Sign Out Session" onClose={() => setTarget(null)} locked={busy}>
          <p>Sign out the session started {when(target.created_at)}? Whoever is using it will need to sign in again.</p>
          {error && <p className="error" role="alert">{error}</p>}
          <div className="modal-actions">
            <button type="button" disabled={busy} onClick={() => void revoke()}>{busy ? "Signing out…" : "Confirm Sign Out"}</button>
            <button type="button" className="ghost" disabled={busy} onClick={() => setTarget(null)}>Cancel</button>
          </div>
        </Modal>
      )}
    </>
  );
}
