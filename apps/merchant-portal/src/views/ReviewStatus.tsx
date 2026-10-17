import { useCallback, useRef, useState } from "react";
import { ApiError, type Account, type Api, type BusinessDocument } from "../api";
import { usePageTitle } from "../title";
import { useList, when } from "../useList";

/** What a business sees until it is approved: its review status and the document upload (a declined business can upload again). */
export function ReviewStatus({ api, account, onChanged, onSignOut, onError }: { api: Api; account: Account; onChanged: () => void; onSignOut: () => void; onError: (e: unknown) => void }) {
  usePageTitle("Account Review");
  const declined = account.status === "declined";
  const { data: docs, failed, retry } = useList<BusinessDocument[]>(useCallback(() => api.documents(), [api]), onError);
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function upload(file: File | undefined) {
    if (!file) return;
    setError(null);
    if (file.size > 5 * 1024 * 1024) return setError("The file is over 5 MB.");
    setBusy(true);
    try { await api.uploadDocument(file); retry(); onChanged(); }
    catch (e) {
      onError(e);
      setError(e instanceof ApiError && e.code === "unsupported_file_type" ? "Upload a PDF, PNG or JPEG." : e instanceof ApiError && e.code === "too_many_documents" ? "You have uploaded the most documents allowed." : "Couldn't upload that file. Try again.");
    } finally { setBusy(false); }
  }

  return (
    <div className="login">
      <div className="card login-card review">
        <div className="brand big"><span className="mark" aria-hidden>◎</span> Nuclear <span className="muted">Business</span></div>
        <h1>{declined ? "We couldn't approve your account yet" : "Your account is being reviewed"}</h1>
        <p><span className={`pill ${declined ? "closed" : "pending"}`}>{account.status}</span> <strong>{account.name}</strong></p>
        {declined ? (
          <>
            {account.decline?.reason && <blockquote className="reason">{account.decline.reason}</blockquote>}
            <p className="muted">Upload a corrected business document and we will review it again.</p>
          </>
        ) : (
          <p className="muted">Upload your business document, such as a registration certificate. Reviews usually take one to two business days and we will email you with the decision.</p>
        )}

        <h2 className="section">Business documents</h2>
        {failed && !docs ? <p className="error" role="alert">Couldn't load your documents. <button className="link" onClick={retry}>Try Again</button></p>
          : !docs ? <p className="muted" role="status">Loading…</p>
          : docs.length === 0 ? <p className="muted">Nothing uploaded yet.</p>
          : <ul className="doc-list">{docs.map((d, i) => <li key={d.id}><span>Business document {docs.length - i}</span><span className="muted">{when(d.created_at)}</span></li>)}</ul>}
        <div className="modal-actions left">
          <button type="button" disabled={busy} onClick={() => input.current?.click()}>{busy ? "Uploading…" : declined ? "Upload New Document" : "Upload Document"}</button>
          <input ref={input} type="file" className="sr-only" aria-label="Business document" accept=".pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg" onChange={(e) => { void upload(e.target.files?.[0]); e.target.value = ""; }} />
        </div>
        <p className="hint">PDF, PNG or JPEG, up to 5 MB.</p>
        {error && <p className="error" role="alert">{error}</p>}
        <p className="hint"><button type="button" className="link" onClick={onSignOut}>Sign out</button></p>
      </div>
    </div>
  );
}
