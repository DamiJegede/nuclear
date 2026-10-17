import { useCallback, useEffect, useState } from "react";
import { ApiError, type Api, type MerchantDocument } from "../api";
import { Modal } from "./Modal";

const EMAIL_NOTE = { sent: "The business was emailed.", failed: "The email could not be sent. The text is saved in the Logs.", not_configured: "Email isn't set up yet, so nothing was sent. The text is saved in the Logs." } as const;

/** A business waiting for approval (or declined): read its document, then approve it or decline it with a reason that is emailed to the business. */
export function BusinessApproval({ api, id, name, status, canAct, onChanged, onError }: {
  api: Api; id: string; name: string; status: "pending" | "declined"; canAct: boolean; onChanged: () => void; onError: (e: unknown) => void;
}) {
  const [docs, setDocs] = useState<MerchantDocument[] | null>(null);
  const [docError, setDocError] = useState(false);
  const [action, setAction] = useState<"approve" | "decline" | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [downloading, setDownloading] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!canAct) return;
    try { setDocs(await api.merchantDocuments(id)); setDocError(false); } catch (e) { setDocError(true); onError(e); }
  }, [api, id, canAct, onError]);
  useEffect(() => { void load(); }, [load]);

  async function download(d: MerchantDocument, n: number) {
    setDownloading(d.id);
    try {
      const blob = await api.downloadMerchantDocument(id, d.id);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = `${name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-document-${n}.${d.file}`;
      document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) { onError(e); setDocError(true); }
    finally { setDownloading(null); }
  }

  async function decide() {
    if (!action) return;
    if (action === "decline" && reason.trim().length < 5) return setError("Write the reason, at least a few words. The business receives it by email.");
    setBusy(true); setError(null);
    try {
      const r = action === "approve" ? await api.approveMerchant(id) : await api.declineMerchant(id, reason.trim());
      setAction(null); setReason(""); setNote(`${action === "approve" ? "Approved" : "Declined"}. ${EMAIL_NOTE[r.email]}`);
      onChanged();
    } catch (e) {
      onError(e);
      setError(e instanceof ApiError && e.code === "not_pending" ? "This business was already decided. Reload the page." : "Couldn't save the decision. Try again.");
    } finally { setBusy(false); }
  }

  return (
    <div className="card approval" role="region" aria-label="Business approval">
      <h2>Business Approval</h2>
      <p className="muted">
        {status === "pending"
          ? "This business is waiting for approval. It can sign in but can't take payments until you approve it."
          : "This business was declined. It can upload a new document, which sends it back here for review."}
      </p>
      {!canAct ? <p className="muted">Only Admin and Merchants can review business documents.</p>
        : docError && !docs ? <p className="error" role="alert">Couldn't load the documents. <button className="link" onClick={() => void load()}>Try Again</button></p>
        : !docs ? <p className="muted" role="status">Loading…</p>
        : docs.length === 0 ? <p className="muted">No document uploaded yet.</p>
        : (
          <ul className="doc-list">
            {docs.map((d, i) => (
              <li key={d.id}>
                <span>Business document {docs.length - i} <span className="muted note">{d.file.toUpperCase()} · uploaded {new Date(d.created_at).toLocaleString()}</span></span>
                <button type="button" className="ghost" disabled={downloading === d.id} onClick={() => void download(d, docs.length - i)}>{downloading === d.id ? "Downloading…" : "Download"}</button>
              </li>
            ))}
          </ul>
        )}
      {note && <p className="muted" role="status">{note}</p>}
      {canAct && (
        <div className="modal-actions left">
          <button type="button" disabled={!docs || docs.length === 0} onClick={() => { setError(null); setAction("approve"); }}>Approve Business</button>
          {status === "pending" && <button type="button" className="ghost" disabled={!docs || docs.length === 0} onClick={() => { setError(null); setAction("decline"); }}>Decline Business</button>}
        </div>
      )}
      {action && (
        <Modal title={action === "approve" ? "Approve Business" : "Decline Business"} onClose={() => setAction(null)} locked={busy}>
          {action === "approve"
            ? <p>Approve <strong>{name}</strong>? It can take payments straight away, and an email tells it so.</p>
            : (
              <>
                <p>Decline <strong>{name}</strong>? Explain what is wrong and what it needs to do. This text is emailed to the business.</p>
                <label className="wide">Reason<textarea rows={5} maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="The document is blurry. Upload a clear copy of your registration certificate." /></label>
              </>
            )}
          {error && <p className="error" role="alert">{error}</p>}
          <div className="modal-actions">
            <button type="button" disabled={busy} onClick={() => void decide()}>{busy ? "Saving…" : action === "approve" ? "Confirm Approve" : "Confirm Decline"}</button>
            <button type="button" className="ghost" disabled={busy} onClick={() => setAction(null)}>Cancel</button>
          </div>
        </Modal>
      )}
    </div>
  );
}
