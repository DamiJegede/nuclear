import { useEffect, useState } from "react";
import { ApiError, type Api, type EmailResult } from "../api";
import { Modal } from "./Modal";

/** Message starters. {{name}} becomes each merchant's name when the email is sent. */
export const EMAIL_TEMPLATES = [
  { id: "welcome", title: "Welcome", subject: "Welcome to Nuclear, {{name}}",
    body: "Hello {{name}},\n\nWelcome to Nuclear. Your business is set up and ready to take payments. If you need help connecting a terminal or adding your products, just reply to this email and we will walk you through it.\n\nThe Nuclear team" },
  { id: "documents", title: "Documents needed", subject: "We need a document to finish setting up {{name}}",
    body: "Hello {{name}},\n\nTo finish reviewing your business we need your business document, such as a registration certificate. Please sign in, upload a clear copy (PDF, PNG or JPEG, up to 5 MB) and we will review it right away.\n\nThe Nuclear team" },
  { id: "review", title: "Under review", subject: "{{name}} is being reviewed",
    body: "Hello {{name}},\n\nThank you for applying. We received your documents and are reviewing them now. Reviews usually take one to two business days, and we will email you as soon as there is a decision. You do not need to do anything else.\n\nThe Nuclear team" },
  { id: "approved", title: "Approved", subject: "Your Nuclear business account is approved",
    body: "Hello {{name}},\n\nGood news: your business account on Nuclear has been approved. You can now sign in and start accepting payments.\n\nThe Nuclear team" },
  { id: "notice", title: "Action required", subject: "Action required on your Nuclear account",
    body: "Hello {{name}},\n\nWe need something from you to keep your account in good standing:\n\n- [describe what is needed]\n\nPlease take care of this by [date]. If anything is unclear, reply to this email.\n\nThe Nuclear team" },
  { id: "custom", title: "Custom", subject: "", body: "" },
] as const;

export type EmailTarget = { kind: "one"; id: string; name: string } | { kind: "many" };
const AUDIENCES = [["active_pending", "Active and Pending"], ["active", "Active"], ["pending", "Pending"]] as const;
const SENT_NOTE = { sent: "was emailed", failed: "could not be emailed", not_configured: "was not emailed because email isn't set up yet (the text is saved in the Logs)", no_address: "has no email address" } as const;

/** Compose and send an email to one merchant, or to every active and/or pending merchant. */
export function EmailMerchants({ api, target, onClose, onError }: { api: Api; target: EmailTarget; onClose: () => void; onError: (e: unknown) => void }) {
  const [tpl, setTpl] = useState<string>("custom");
  const [subject, setSubject] = useState("");
  const [message, setMessage] = useState("");
  const [audience, setAudience] = useState<(typeof AUDIENCES)[number][0]>("active_pending");
  const [counts, setCounts] = useState<{ active: number; pending: number } | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<EmailResult | null>(null);

  useEffect(() => {
    if (target.kind !== "many") return;
    let alive = true;
    api.merchants().then((r) => { if (alive) setCounts({ active: r.counts.active ?? 0, pending: r.counts.pending ?? 0 }); }).catch(onError);
    return () => { alive = false; };
  }, [api, target.kind, onError]);

  const recipients = target.kind === "one" ? 1 : !counts ? null : audience === "active" ? counts.active : audience === "pending" ? counts.pending : counts.active + counts.pending;

  function choose(id: string) {
    setTpl(id);
    const t = EMAIL_TEMPLATES.find((x) => x.id === id)!;
    setSubject(t.subject); setMessage(t.body); setError(null);
  }

  async function send() {
    setBusy(true); setError(null);
    try {
      setResult(await api.emailMerchants({ ...(target.kind === "one" ? { merchant_ids: [target.id] } : { audience }), subject: subject.trim(), body: message.trim() }));
      setConfirming(false);
    } catch (e) {
      onError(e);
      setConfirming(false);
      setError(e instanceof ApiError && e.code === "no_recipients" ? "There is nobody to send this to." : "Couldn't send the email. Try again.");
    } finally { setBusy(false); }
  }

  function review() {
    if (!subject.trim()) return setError("Write a subject.");
    if (!message.trim()) return setError("Write the message.");
    setError(null);
    if (target.kind === "many") setConfirming(true); else void send();
  }

  if (result) {
    const lines = result.results.length === 1 ? `${result.results[0]!.name} ${SENT_NOTE[result.results[0]!.email]}.` : `${result.sent} of ${result.total} merchants were emailed.${result.not_configured ? " Email isn't set up yet, so nothing was sent. The text is saved in the Logs." : ""}${result.failed ? ` ${result.failed} could not be sent.` : ""}${result.no_address ? ` ${result.no_address} have no email address.` : ""}`;
    return (
      <Modal title="Email Sent" onClose={onClose}>
        <p role="status">{lines}</p>
        <div className="modal-actions"><button type="button" onClick={onClose}>Done</button></div>
      </Modal>
    );
  }

  if (confirming) {
    return (
      <Modal title="Send to Merchants" onClose={() => setConfirming(false)} locked={busy}>
        <p>Send “<strong>{subject.trim()}</strong>” to <strong>{recipients}</strong> {AUDIENCES.find((a) => a[0] === audience)![1].toLowerCase()} merchant{recipients === 1 ? "" : "s"}? Each one gets their own copy.</p>
        <div className="modal-actions">
          <button type="button" disabled={busy} onClick={() => void send()}>{busy ? "Sending…" : "Confirm Send"}</button>
          <button type="button" className="ghost" disabled={busy} onClick={() => setConfirming(false)}>Back</button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title={target.kind === "one" ? "Email Merchant" : "Email Merchants"} onClose={onClose} locked={busy}>
      <div className="email-compose">
        <fieldset className="choice-field">
          <legend>Template</legend>
          <div className="choice-grid template-grid" role="radiogroup" aria-label="Template">
            {EMAIL_TEMPLATES.map((t) => (
              <label key={t.id} className="choice template">
                <input type="radio" name="email-template" value={t.id} checked={tpl === t.id} onChange={() => choose(t.id)} />
                <span>{t.title}</span>
              </label>
            ))}
          </div>
        </fieldset>

        {target.kind === "one"
          ? <p className="muted email-to">To: <strong>{target.name}</strong></p>
          : (
            <label className="email-to">To
              <select value={audience} onChange={(e) => setAudience(e.target.value as typeof audience)}>
                {AUDIENCES.map(([v, l]) => <option key={v} value={v}>{l}{counts ? ` (${v === "active" ? counts.active : v === "pending" ? counts.pending : counts.active + counts.pending})` : ""}</option>)}
              </select>
            </label>
          )}
        <label>Subject<input value={subject} maxLength={150} onChange={(e) => setSubject(e.target.value)} /></label>
        <label>Message<textarea rows={10} maxLength={5000} value={message} onChange={(e) => setMessage(e.target.value)} /></label>
        <p className="muted note-line">Use {"{{name}}"} to insert each merchant's name.</p>
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="modal-actions">
        <button type="button" disabled={busy || recipients === 0} onClick={review}>{busy ? "Sending…" : "Send Email"}</button>
        <button type="button" className="ghost" disabled={busy} onClick={onClose}>Cancel</button>
      </div>
    </Modal>
  );
}
