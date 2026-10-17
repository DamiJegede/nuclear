import { useCallback, useRef, useState } from "react";
import { ApiError, type Account, type Api, type BusinessDocument, type Device, type PayoutBank as Bank, type Profile as BusinessProfile } from "../api";
import { digitsOnly } from "../inputs";
import { usePageTitle } from "../title";
import { useList, when } from "../useList";
import { Avatar } from "./Avatar";
import { LogoCrop } from "./LogoCrop";
import { Modal } from "./Modal";

const HANDLE = /^[a-z0-9]{4,12}$/;

/** The business's own profile and security: logo, handle, documents, and the sessions signed in to this account. */
export function Profile({ api, account, onChanged, onError }: { api: Api; account: Account; onChanged: () => void; onError: (e: unknown) => void }) {
  usePageTitle("Profile");
  return (
    <section>
      <div className="head"><h1>Profile</h1></div>
      <div className="two-col">
        <Identity api={api} account={account} onChanged={onChanged} onError={onError} />
        <Documents api={api} onError={onError} />
      </div>
      <div className="two-col">
        <BusinessDetails api={api} onError={onError} />
        <PayoutBank api={api} onError={onError} />
      </div>
      <Sessions api={api} onError={onError} />
    </section>
  );
}

function Identity({ api, account, onChanged, onError }: { api: Api; account: Account; onChanged: () => void; onError: (e: unknown) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [handle, setHandle] = useState(account.handle ?? "");
  const [handleMsg, setHandleMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const [crop, setCrop] = useState<File | null>(null);
  function photo(file: File | undefined) {
    if (!file) return;
    setError(null);
    if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) return setError("Choose a PNG, JPEG or WebP image.");
    if (file.size > 8 * 1024 * 1024) return setError("The image is over 8 MB.");
    setCrop(file);
  }

  async function saveHandle() {
    setHandleMsg(null);
    const h = handle.trim().toLowerCase();
    if (!HANDLE.test(h)) return setHandleMsg({ ok: false, text: "Use 4 to 12 lowercase letters and numbers." });
    try { await api.setHandle(h); setHandleMsg({ ok: true, text: "Handle saved." }); onChanged(); }
    catch (e) {
      onError(e);
      setHandleMsg({ ok: false, text: e instanceof ApiError && e.code === "handle_taken" ? "That handle is taken." : "Couldn't save the handle. Try again." });
    }
  }

  return (
    <div className="card">
      <h2>Business</h2>
      <div className="identity">
        <Avatar name={account.name} photo={account.photo} />
        <div>
          <p className="big small">{account.name}</p>
          <p className="muted">{account.email ?? "—"}{account.phone ? ` · ${account.phone}` : ""}</p>
          <button type="button" className="ghost" disabled={busy} onClick={() => input.current?.click()}>{busy ? "Uploading…" : account.photo ? "Replace Logo" : "Upload Logo"}</button>
          <input ref={input} type="file" className="sr-only" aria-label="Logo" accept="image/png,image/jpeg,image/webp" onChange={(e) => { photo(e.target.files?.[0]); e.target.value = ""; }} />
          {crop && <LogoCrop file={crop} onClose={() => setCrop(null)} onSave={async (jpeg) => { try { await api.uploadPhoto(jpeg); setCrop(null); onChanged(); } catch (e) { onError(e); throw e; } }} />}
          {error && <p className="error" role="alert">{error}</p>}
        </div>
      </div>
      <label htmlFor="handle">Handle</label>
      <div className="inline">
        <input id="handle" value={handle} maxLength={12} autoCapitalize="none" spellCheck={false} onChange={(e) => setHandle(e.target.value.toLowerCase().replace(/[^a-z0-9]/g, ""))} />
        <button type="button" disabled={handle === (account.handle ?? "")} onClick={() => void saveHandle()}>Save Handle</button>
      </div>
      {handleMsg && <p className={handleMsg.ok ? "ok" : "error"} role={handleMsg.ok ? "status" : "alert"}>{handleMsg.text}</p>}
      <p className="hint">Customers can find you by your handle. 4 to 12 lowercase letters and numbers.</p>
    </div>
  );
}

function Documents({ api, onError }: { api: Api; onError: (e: unknown) => void }) {
  const { data, failed, retry } = useList<BusinessDocument[]>(useCallback(() => api.documents(), [api]), onError);
  const input = useRef<HTMLInputElement>(null);
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
    <div className="card">
      <h2>Business Documents</h2>
      {failed && !data ? <p className="error" role="alert">Couldn't load the documents. <button className="link" onClick={retry}>Try Again</button></p>
        : !data ? <p className="muted" role="status">Loading…</p>
        : data.length === 0 ? <p className="muted">Nothing uploaded.</p>
        : <ul className="doc-list">{data.map((d, i) => <li key={d.id}><span>Business document {data.length - i}</span><span className="muted">{when(d.created_at)}</span></li>)}</ul>}
      <button type="button" className="ghost" disabled={busy} onClick={() => input.current?.click()}>{busy ? "Uploading…" : "Upload Document"}</button>
      <input ref={input} type="file" className="sr-only" aria-label="Business document" accept=".pdf,.png,.jpg,.jpeg" onChange={(e) => { void upload(e.target.files?.[0]); e.target.value = ""; }} />
      <p className="hint">PDF, PNG or JPEG, up to 5 MB.</p>
      {error && <p className="error" role="alert">{error}</p>}
    </div>
  );
}

function Sessions({ api, onError }: { api: Api; onError: (e: unknown) => void }) {
  const { data, failed, retry } = useList<Device[]>(useCallback(() => api.devices(), [api]), onError);
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

/** Legal name, tax ID, address and website. The tax ID is write-only: only its last four digits are shown. */
function BusinessDetails({ api, onError }: { api: Api; onError: (e: unknown) => void }) {
  const { data, failed, retry } = useList<BusinessProfile | null>(useCallback(() => api.profile(), [api]), onError);
  const [f, setF] = useState<Record<string, string> | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const form = f ?? {
    legal_name: data?.legal_name ?? "", display_name: data?.display_name ?? "", tax_id: "", address: data?.address ?? "", city: data?.city ?? "",
    state: data?.state ?? "", post_code: data?.post_code ?? "", country: data?.country ?? "US", website: data?.website ?? "",
  };
  const set = (k: string, v: string) => setF({ ...form, [k]: v });

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    if (!form.legal_name!.trim() || !form.display_name!.trim()) return setMsg({ ok: false, text: "Enter the legal name and the name customers see." });
    if (form.tax_id && !/^[0-9A-Za-z-]{4,20}$/.test(form.tax_id)) return setMsg({ ok: false, text: "The tax ID is 4 to 20 letters, numbers or dashes." });
    if (form.country && form.country.length !== 2) return setMsg({ ok: false, text: "Use the 2-letter country code, like US." });
    if (form.website && !/^https?:\/\/\S+$/.test(form.website)) return setMsg({ ok: false, text: "The website must start with https://" });
    setBusy(true);
    try {
      await api.saveProfile({
        legal_name: form.legal_name!.trim(), display_name: form.display_name!.trim(), ...(form.tax_id ? { tax_id: form.tax_id.trim() } : {}),
        address: form.address!.trim() || null, city: form.city!.trim() || null, state: form.state!.trim() || null, post_code: form.post_code!.trim() || null,
        country: form.country!.trim().toUpperCase() || null, website: form.website!.trim() || null,
      });
      setF(null); retry(); setMsg({ ok: true, text: "Saved." });
    } catch (err) { onError(err); setMsg({ ok: false, text: "Couldn't save your details. Check each field and try again." }); }
    finally { setBusy(false); }
  }

  if (!data && !failed) return <div className="card"><h2>Business Details</h2><p className="muted" role="status">Loading…</p></div>;
  return (
    <form className="card" onSubmit={save} aria-label="Business details">
      <h2>Business Details</h2>
      <div className="fields">
        <label className="wide">Legal name<input value={form.legal_name} maxLength={160} onChange={(e) => set("legal_name", e.target.value)} /></label>
        <label className="wide">Name customers see<input value={form.display_name} maxLength={120} onChange={(e) => set("display_name", e.target.value)} /></label>
        <label className="wide">Tax ID<input value={form.tax_id} maxLength={20} autoComplete="off" placeholder={data?.tax_id_last4 ? `•••• ${data.tax_id_last4} saved. Type to replace` : ""} onChange={(e) => set("tax_id", e.target.value)} /></label>
        <label className="wide">Address<input value={form.address} maxLength={300} onChange={(e) => set("address", e.target.value)} /></label>
        <label>City<input value={form.city} maxLength={100} onChange={(e) => set("city", e.target.value)} /></label>
        <label>State<input value={form.state} maxLength={100} onChange={(e) => set("state", e.target.value)} /></label>
        <label>Post code<input value={form.post_code} maxLength={20} onChange={(e) => set("post_code", e.target.value)} /></label>
        <label>Country<input value={form.country} maxLength={2} onChange={(e) => set("country", e.target.value.toUpperCase())} /></label>
        <label className="wide">Website<input value={form.website} maxLength={200} placeholder="https://" onChange={(e) => set("website", e.target.value)} /></label>
      </div>
      {msg && <p className={msg.ok ? "ok" : "error"} role={msg.ok ? "status" : "alert"}>{msg.text}</p>}
      <button type="submit" disabled={busy}>{busy ? "Saving…" : "Save Details"}</button>
    </form>
  );
}

/** Where settlements will be paid. Only the last four digits of the account are ever shown. */
function PayoutBank({ api, onError }: { api: Api; onError: (e: unknown) => void }) {
  const { data, failed, retry } = useList<Bank | null>(useCallback(() => api.bank(), [api]), onError);
  const [editing, setEditing] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [routing, setRouting] = useState("");
  const [account, setAccount] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (routing.length !== 9) return setError("The routing number is 9 digits.");
    if (account.length < 4 || account.length > 17) return setError("The account number is 4 to 17 digits.");
    setBusy(true);
    try { await api.saveBank({ routing_number: routing, account_number: account }); setEditing(false); setRouting(""); setAccount(""); retry(); }
    catch (err) {
      onError(err);
      setError(err instanceof ApiError && err.code === "profile_required" ? "Save your business details first." : err instanceof ApiError && err.code === "invalid_routing_number" ? "That routing number isn't valid." : "Couldn't save the bank account. Try again.");
    } finally { setBusy(false); }
  }
  async function remove() {
    setBusy(true); setError(null);
    try { await api.removeBank(); setRemoving(false); retry(); } catch (err) { onError(err); setError("Couldn't remove it. Try again."); } finally { setBusy(false); }
  }

  return (
    <div className="card">
      <h2>Payout Bank</h2>
      {failed && !data ? <p className="error" role="alert">Couldn't load the bank. <button className="link" onClick={retry}>Try Again</button></p>
        : data === null && !failed ? <p className="muted" role="status">Loading…</p>
        : null}
      {data ? <p className="big small">•••• {data.last4} <span className="pill available">{data.status}</span></p> : data === null && failed ? null : <p className="muted">No payout bank yet.</p>}
      <div className="modal-actions left">
        <button type="button" className="ghost" onClick={() => { setError(null); setEditing(true); }}>{data ? "Replace Bank" : "Add Bank"}</button>
        {data && <button type="button" className="ghost" onClick={() => { setError(null); setRemoving(true); }}>Remove</button>}
      </div>
      <p className="hint">Payouts aren't switched on yet. This is where your settlements will go.</p>
      {editing && (
        <Modal title={data ? "Replace Payout Bank" : "Add Payout Bank"} onClose={() => setEditing(false)} locked={busy}>
          <form onSubmit={save} className="modal-form">
            <div className="fields">
              <label className="wide">Routing number<input inputMode="numeric" maxLength={9} autoComplete="off" value={routing} onChange={(e) => setRouting(digitsOnly(e.target.value))} /></label>
              <label className="wide">Account number<input inputMode="numeric" maxLength={17} autoComplete="off" value={account} onChange={(e) => setAccount(digitsOnly(e.target.value))} /></label>
            </div>
            {error && <p className="error" role="alert">{error}</p>}
            <div className="modal-actions">
              <button type="submit" disabled={busy}>{busy ? "Saving…" : "Save Bank"}</button>
              <button type="button" className="ghost" disabled={busy} onClick={() => setEditing(false)}>Cancel</button>
            </div>
          </form>
        </Modal>
      )}
      {removing && (
        <Modal title="Remove Payout Bank" onClose={() => setRemoving(false)} locked={busy}>
          <p>Remove the bank account ending {data?.last4}? Add another before payouts start.</p>
          {error && <p className="error" role="alert">{error}</p>}
          <div className="modal-actions">
            <button type="button" disabled={busy} onClick={() => void remove()}>{busy ? "Removing…" : "Confirm Remove"}</button>
            <button type="button" className="ghost" disabled={busy} onClick={() => setRemoving(false)}>Cancel</button>
          </div>
        </Modal>
      )}
    </div>
  );
}
