import { useRef, useState } from "react";
import { ApiError, type Api, type ProvisionResult, type TagDetail } from "../api";
import { parseUids, type ParsedUids } from "../csv";
import { int } from "../format";
import { Modal } from "./Modal";

const BATCH = 5000;   // the API takes at most this many UIDs per request

/** Provision Tags: load a supplier's CSV of NFC UIDs for this tag. */
export function ProvisionModal({
  api, model, onDone, onClose, onError,
}: { api: Api; model: TagDetail; onDone: () => Promise<void> | void; onClose: () => void; onError: (e: unknown) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const [file, setFile] = useState<{ name: string; parsed: ParsedUids } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ inserted: number; existing: number } | null>(null);

  async function read(f: File | undefined) {
    setError(null);
    if (!f) return;
    try {
      const parsed = parseUids(await f.text());
      if (parsed.uids.length === 0) return setError("No UIDs found in that file. Each UID is 14 hexadecimal characters.");
      setFile({ name: f.name, parsed });
    } catch {
      setError("Couldn't read that file.");
    }
  }

  async function load() {
    if (!file) return;
    setBusy(true);
    setError(null);
    let inserted = 0, existing = 0;
    try {
      for (let i = 0; i < file.parsed.uids.length; i += BATCH) {
        const r: ProvisionResult = await api.provisionTags(model.id, file.parsed.uids.slice(i, i + BATCH));
        inserted += r.inserted;
        existing += r.already_existing.length;
      }
      setResult({ inserted, existing });
      await onDone();
    } catch (err) {
      onError(err);
      setError(err instanceof ApiError && err.code === "invalid_uids" ? "Some UIDs were rejected. Check the file and try again."
        : inserted > 0 ? `Loaded ${int(inserted)} tags before an error. Try again to load the rest.`
        : "Couldn't load the tags. Try again.");
      if (inserted > 0) await onDone();
    } finally {
      setBusy(false);
    }
  }

  const after = result ? model.tags + result.inserted : model.tags;
  const pendingAfter = Math.max(0, model.quantity - after);

  return (
    <Modal title="Provision Tags" onClose={onClose} locked={busy}>
      {result ? (
        <>
          <p><strong>{int(result.inserted)}</strong> tags loaded for {model.name}.
            {result.existing > 0 && <> {int(result.existing)} were already in the system and were left alone.</>}</p>
          <p className="muted">{int(after)} of {int(model.quantity)} provisioned, {int(pendingAfter)} pending.</p>
          <div className="modal-actions"><button type="button" onClick={onClose}>Done</button></div>
        </>
      ) : (
        <>
          <p className="muted">{int(model.tags)} of {int(model.quantity)} provisioned, {int(model.pending)} pending. Upload the supplier's CSV: one NFC UID per row (14 hexadecimal characters).</p>
          <div
            className={over ? "dropzone over" : "dropzone"}
            onDragOver={(e) => { e.preventDefault(); setOver(true); }}
            onDragLeave={() => setOver(false)}
            onDrop={(e) => { e.preventDefault(); setOver(false); void read(e.dataTransfer.files?.[0]); }}
          >
            {file ? (
              <>
                <strong>{file.name}</strong>
                <span>{int(file.parsed.uids.length)} UIDs found{file.parsed.duplicates > 0 ? `, ${int(file.parsed.duplicates)} repeated` : ""}{file.parsed.ignored > 0 ? `, ${int(file.parsed.ignored)} other values ignored` : ""}</span>
              </>
            ) : (
              <>
                <span className="dz-icon" aria-hidden>⇪</span>
                <span className="muted">Drag and drop a CSV here</span>
              </>
            )}
            <button type="button" className="ghost" onClick={() => input.current?.click()}>{file ? "Replace File" : "Select CSV"}</button>
            <input ref={input} type="file" accept=".csv,.txt,text/csv,text/plain" className="sr-only" aria-label="UID File" onChange={(e) => { void read(e.target.files?.[0]); e.target.value = ""; }} />
          </div>
          {error && <p className="error" role="alert">{error}</p>}
          <div className="modal-actions">
            <button type="button" disabled={!file || busy} onClick={() => void load()}>{busy ? "Loading…" : file ? `Load ${int(file.parsed.uids.length)} Tags` : "Load Tags"}</button>
            <button type="button" className="ghost" disabled={busy} onClick={onClose}>Cancel</button>
          </div>
        </>
      )}
    </Modal>
  );
}
