import { useState } from "react";
import type { Credentials } from "../api";
import { credentialsText, downloadText } from "../token";
import { CopyButton } from "./CopyButton";

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
  const [note, setNote] = useState<{ at: "download"; text: string } | null>(null);

  function download() {
    const ok = downloadText(
      `nuclear-admin-${credentials.access_id}.txt`,
      credentialsText(name, credentials.access_id, credentials.access_token, window.location.origin),
    );
    setNote({ at: "download", text: ok ? "Downloaded. Keep the file private." : "Couldn't download. Copy the values instead." });
  }

  return (
    <div className="creds" role="group" aria-label={`Credentials for ${name}`}>
      <p className="notice warn" role="status">
        This is the <strong>only time</strong> the Access Token is shown. It can't be looked up later. It is hidden here: download it or copy it now.
      </p>
      <dl className="cred-list">
        <div>
          <dt>Access ID</dt>
          <dd><code data-testid="access-id">{credentials.access_id}</code> <CopyButton className="ghost small" value={credentials.access_id} /></dd>
        </div>
        <div>
          <dt>Access Token</dt>
          <dd><code data-testid="access-token" className="token" aria-label="Access Token (hidden)">{"•".repeat(32)}</code> <CopyButton className="ghost small" value={credentials.access_token} /></dd>
        </div>
      </dl>
      <div className="row">
        <button type="button" onClick={download}>Download credentials</button>
        {note?.at === "download" && <span className="muted note" role="status">{note.text}</span>}
      </div>
      <p className="hint">{name} signs in with it and sets up two-step verification the first time. Keep it safe: it cannot be shown again.</p>
      <label className="check"><input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} /> I have saved these credentials</label>
      <button type="button" disabled={!saved} onClick={onDone}>{doneLabel}</button>
    </div>
  );
}
