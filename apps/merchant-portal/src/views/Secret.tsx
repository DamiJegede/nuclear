import { useState } from "react";
import { downloadText } from "../token";
import { CopyButton } from "./CopyButton";

/** A secret shown exactly once: masked, with Copy and Download, and a confirm that it was saved. */
export function SecretPanel({ title, value, filename, text, onDone }: { title: string; value: string; filename: string; text: string; onDone: () => void }) {
  const [saved, setSaved] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  return (
    <div className="creds" role="group" aria-label={title}>
      <p className="notice warn" role="status">This is the <strong>only time</strong> this is shown. It can't be looked up later. It is hidden here: download it or copy it now.</p>
      <dl className="cred-list">
        <div>
          <dt>{title}</dt>
          <dd><code className="token" aria-label={`${title} (hidden)`}>{"•".repeat(32)}</code> <CopyButton className="ghost small" value={value} /></dd>
        </div>
      </dl>
      <div className="row">
        <button type="button" onClick={() => setNote(downloadText(filename, text) ? "Downloaded. Keep the file private." : "Couldn't download. Copy the value instead.")}>Download</button>
        {note && <span className="muted note" role="status">{note}</span>}
      </div>
      <label className="check"><input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} /> I have saved it</label>
      <button type="button" disabled={!saved} onClick={onDone}>Done</button>
    </div>
  );
}
