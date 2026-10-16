import { useState } from "react";
import type { Credentials } from "../api";
import { copyText, credentialsText, downloadText } from "../token";

/**
 * Freshly issued credentials, shown exactly once. The Access ID is always visible; the Access Token is
 * on screen now and is not recoverable later, so the person must download or copy it and confirm.
 */
export function CredentialsPanel({
  name,
  credentials,
  onDone,
  doneLabel = "Done",
}: {
  name: string;
  credentials: Credentials;
  onDone: () => void;
  doneLabel?: string;
}) {
  const [saved, setSaved] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  async function copy(label: string, value: string) {
    setNote((await copyText(value)) ? `${label} copied.` : `Couldn't copy the ${label.toLowerCase()}. Select it and copy by hand.`);
  }
  function download() {
    const ok = downloadText(
      `nuclear-admin-${credentials.access_id}.txt`,
      credentialsText(name, credentials.access_id, credentials.access_token, window.location.origin),
    );
    setNote(ok ? "Downloaded. Keep the file private." : "Couldn't download. Copy the values instead.");
  }

  return (
    <div className="creds" role="group" aria-label={`Credentials for ${name}`}>
      <p className="notice warn" role="status">
        This is the <strong>only time</strong> the Access Token is shown. It can't be looked up later. Download it or copy it now.
      </p>
      <dl className="cred-list">
        <div>
          <dt>Access ID</dt>
          <dd><code data-testid="access-id">{credentials.access_id}</code> <button type="button" className="ghost small" onClick={() => void copy("Access ID", credentials.access_id)}>Copy</button></dd>
        </div>
        <div>
          <dt>Access Token</dt>
          <dd><code data-testid="access-token" className="token">{credentials.access_token}</code> <button type="button" className="ghost small" onClick={() => void copy("Access Token", credentials.access_token)}>Copy</button></dd>
        </div>
      </dl>
      <div className="row">
        <button type="button" onClick={download}>Download credentials</button>
      </div>
      {note && <p className="muted" role="status">{note}</p>}
      <p className="hint">{name} must replace this token with their own and set up two-step verification the first time they sign in. Then this one stops working.</p>
      <label className="check"><input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} /> I have saved these credentials</label>
      <button type="button" disabled={!saved} onClick={onDone}>{doneLabel}</button>
    </div>
  );
}
