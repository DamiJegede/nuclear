import { useRef, useState, type FormEvent } from "react";
import { ApiError, type Api, type TagModel } from "../api";
import { dollarsToCents } from "../format";
import { resizePhoto } from "../image";
import { Modal } from "./Modal";

const STATUSES: TagModel["status"][] = ["pending", "preorder", "available", "closed"];

/** Add a Tag / Edit Tag: one form for both. (The database calls them models; people call them tags.) */
export function TagFormModal({
  api, model, onSaved, onClose, onError,
}: {
  api: Api;
  model?: TagModel;
  onSaved: () => Promise<void> | void;
  onClose: () => void;
  onError: (e: unknown) => void;
}) {
  const editing = !!model;
  const [name, setName] = useState(model?.name ?? "");
  const [type, setType] = useState<"band" | "card">(model?.type ?? "band");
  const [price, setPrice] = useState(model ? (model.price / 100).toFixed(2) : "");
  const [quantity, setQuantity] = useState(model ? String(model.quantity) : "");
  const [photo, setPhoto] = useState<Blob | null>(null);
  const [preview, setPreview] = useState<string | null>(model?.photo ?? null);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const [limited, setLimited] = useState(model?.limited ?? false);
  const [status, setStatus] = useState<TagModel["status"]>(model?.status ?? "pending"); // new tags start pending
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function pick(file: File | undefined) {
    setPhotoError(null);
    if (!file) return;
    if (file.type !== "image/png") return setPhotoError("Only PNG images are accepted.");
    try {
      const blob = await resizePhoto(file);
      setPhoto(blob);
      setPreview((old) => { if (old && old.startsWith("blob:")) URL.revokeObjectURL(old); return URL.createObjectURL(blob); });
    } catch {
      setPhotoError("Couldn't read that image. Choose a PNG picture.");
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const cents = dollarsToCents(price);
    const qty = Number(quantity);
    if (!name.trim()) return setError("Give the tag a name.");
    if (cents === null) return setError("Enter the price in dollars, like 29.99.");
    if (!Number.isInteger(qty) || qty < 0) return setError("Quantity must be a whole number.");
    if (!editing && !photo) return setError("Add a PNG image of the tag.");

    setBusy(true);
    try {
      const fields = { type, name: name.trim(), price: cents, quantity: qty, limited, status };
      const saved = editing ? await api.updateModel(model!.id, fields) : await api.createModel(fields);
      if (photo) {
        try { await api.uploadModelPhoto(saved.id, photo); }
        catch (err) { onError(err); /* the tag is saved; the image can be added again */ }
      }
      await onSaved();
    } catch (err) {
      onError(err);
      const code = err instanceof ApiError ? err.code : "";
      setError(
        code === "quantity_below_sold" ? "Quantity can't be lower than the number already sold."
          : code === "type_locked" ? "The type can't change once tags are provisioned or sold."
          : err instanceof ApiError && err.status === 400 ? "The API rejected those details. Check each field."
          : "Couldn't save the tag. Try again.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={editing ? "Edit Tag" : "Add a Tag"} onClose={onClose} locked={busy}>
      <form onSubmit={submit} className="modal-form">
        <div className="fields">
          <label className="wide">Name<input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} /></label>

          <fieldset className="wide choice-field">
            <legend>Type</legend>
            <div className="choice-grid" role="radiogroup" aria-label="Type">
              {([["band", "Band", <BandIcon key="b" />], ["card", "Card", <CardIcon key="c" />]] as const).map(([value, label, icon]) => (
                <label key={value} className="choice">
                  <input type="radio" name="model-type" value={value} checked={type === value} onChange={() => setType(value)} />
                  {icon}
                  <span>{label}</span>
                </label>
              ))}
            </div>
          </fieldset>

          <label>Price (USD)<input inputMode="decimal" placeholder="29.99" value={price} onChange={(e) => setPrice(e.target.value)} /></label>
          <label>Quantity<input inputMode="numeric" placeholder="1000" value={quantity} onChange={(e) => setQuantity(e.target.value)} /></label>

          <PhotoDrop preview={preview} error={photoError} onFile={(f) => void pick(f)} />

          <label>Status
            <select value={status} onChange={(e) => setStatus(e.target.value as TagModel["status"])}>
              {STATUSES.map((s) => <option key={s} value={s}>{s.toUpperCase()}</option>)}
            </select>
          </label>
          <label className="toggle-card">
            <span className="toggle-text"><strong>Limited Edition</strong></span>
            <input type="checkbox" role="switch" checked={limited} onChange={(e) => setLimited(e.target.checked)} aria-label="Limited Edition" />
            <span className="switch" aria-hidden />
          </label>
        </div>
        {error && <p className="error" role="alert">{error}</p>}
        <div className="modal-actions">
          <button type="submit" disabled={busy}>{busy ? "Saving…" : editing ? "Save Changes" : "Add Tag"}</button>
          <button type="button" className="ghost" onClick={onClose} disabled={busy}>Cancel</button>
        </div>
      </form>
    </Modal>
  );
}

export const BandIcon = () => (
  <svg viewBox="0 0 48 48" width="28" height="28" aria-hidden fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M14 18c0-5 4-9 10-9s10 4 10 9M14 30c0 5 4 9 10 9s10-4 10-9" />
    <rect x="9" y="17" width="30" height="14" rx="7" />
    <circle cx="24" cy="24" r="2.5" />
  </svg>
);
export const CardIcon = () => (
  <svg viewBox="0 0 48 48" width="28" height="28" aria-hidden fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <rect x="6" y="11" width="36" height="26" rx="4" />
    <path d="M6 19h36M12 30h10" />
  </svg>
);

/** Click-or-drag PNG upload. */
function PhotoDrop({ preview, error, onFile }: { preview: string | null; error: string | null; onFile: (f: File | undefined) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  return (
    <div className="wide">
      <span className="field-label">Tag Image (PNG only)</span>
      <div
        className={over ? "dropzone over" : "dropzone"}
        onDragOver={(e) => { e.preventDefault(); setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => { e.preventDefault(); setOver(false); onFile(e.dataTransfer.files?.[0]); }}
      >
        {preview ? <img src={preview} alt="Photo preview" width={96} height={96} /> : <span className="dz-icon" aria-hidden>⇪</span>}
        <span className="muted">{preview ? "Drop another PNG to replace it" : "Drag and drop a PNG here"}</span>
        <button type="button" className="ghost" onClick={() => input.current?.click()}>{preview ? "Replace Image" : "Select Image"}</button>
        <input ref={input} type="file" accept="image/png" className="sr-only" aria-label="Tag Image" onChange={(e) => { onFile(e.target.files?.[0]); e.target.value = ""; }} />
      </div>
      {error && <p className="error" role="alert">{error}</p>}
    </div>
  );
}
