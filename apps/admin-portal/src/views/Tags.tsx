import { useCallback, useEffect, useState, type FormEvent } from "react";
import { ApiError, type Api, type TagModel } from "../api";
import { dollarsToCents, int } from "../format";
import { resizePhoto } from "../image";
import { Modal } from "./Modal";

const STATUSES: TagModel["status"][] = ["pending", "preorder", "available", "closed"];

export function Tags({ api, onError }: { api: Api; onError: (e: unknown) => void }) {
  const [models, setModels] = useState<TagModel[] | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    try {
      setModels(await api.models());
      setFailed(false);
    } catch (e) {
      setFailed(true);
      onError(e);
    }
  }, [api, onError]);

  useEffect(() => { void load(); }, [load]);

  const [adding, setAdding] = useState(false);

  return (
    <section>
      <div className="head"><h1>Tags</h1></div>

      {failed && !models ? (
        <p className="error pad" role="alert">Couldn't load models. <button className="link" onClick={() => void load()}>Try again</button></p>
      ) : !models ? (
        <p className="muted pad" role="status">Loading…</p>
      ) : (
        <ul className="model-grid" aria-label="Tag models">
          {models.map((m) => (
            <li key={m.id} className="model-card">
              {m.photo
                ? <img src={m.photo} alt="" width={256} height={256} loading="lazy" />
                : <div className="model-photo-empty" aria-hidden>{m.type === "card" ? "▭" : "◯"}</div>}
              <h3>{m.name}</h3>
              <p className="model-count"><strong>{int(m.sold)}</strong> / {int(m.quantity)} <span className="model-count-label">sold</span></p>
              <span className="model-type">{m.type.toUpperCase()}</span>
            </li>
          ))}
          <li className="model-card model-add">
            <button type="button" onClick={() => setAdding(true)} aria-label="Add model">
              <span className="plus" aria-hidden>+</span>
              <span>Add Model</span>
            </button>
          </li>
        </ul>
      )}

      {adding && (
        <Modal title="Add a model" onClose={() => setAdding(false)}>
          <NewModelForm api={api} onCreated={async () => { setAdding(false); await load(); }} onError={onError} onCancel={() => setAdding(false)} />
        </Modal>
      )}
    </section>
  );
}

function NewModelForm({ api, onCreated, onError, onCancel }: { api: Api; onCreated: () => Promise<void>; onError: (e: unknown) => void; onCancel: () => void }) {
  const [name, setName] = useState("");
  const [type, setType] = useState<"band" | "card">("band");
  const [price, setPrice] = useState("");
  const [quantity, setQuantity] = useState("");
  const [photo, setPhoto] = useState<Blob | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const [limited, setLimited] = useState(false);
  const [status, setStatus] = useState<TagModel["status"]>("pending"); // new models start pending
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function pick(file: File | undefined) {
    setPhotoError(null);
    setPhoto(null);
    setPreview((old) => { if (old) URL.revokeObjectURL(old); return null; });
    if (!file) return;
    try {
      const blob = await resizePhoto(file);
      setPhoto(blob);
      setPreview(URL.createObjectURL(blob));
    } catch {
      setPhotoError("Couldn't read that image. Choose a JPEG, PNG or WebP picture.");
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const cents = dollarsToCents(price);
    const qty = Number(quantity);
    if (!name.trim()) return setError("Give the model a name.");
    if (cents === null) return setError("Enter the price in dollars, like 29.99.");
    if (!Number.isInteger(qty) || qty < 0) return setError("Quantity must be a whole number.");

    setBusy(true);
    try {
      const created = await api.createModel({ type, name: name.trim(), price: cents, quantity: qty, limited, status });
      if (photo) {
        try { await api.uploadModelPhoto(created.id, photo); }
        catch (err) { onError(err); /* the model exists; the photo can be added again later */ }
      }
      await onCreated();
    } catch (err) {
      onError(err);
      setError(err instanceof ApiError && err.status === 400 ? "The API rejected those details. Check each field." : "Couldn't add the model. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="modal-form">
      <div className="fields">
        <label>Name<input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} /></label>
        <label>Type
          <select value={type} onChange={(e) => setType(e.target.value as "band" | "card")}>
            <option value="band">Band</option>
            <option value="card">Card</option>
          </select>
        </label>
        <label>Price (USD)<input inputMode="decimal" placeholder="29.99" value={price} onChange={(e) => setPrice(e.target.value)} /></label>
        <label>Quantity<input inputMode="numeric" placeholder="1000" value={quantity} onChange={(e) => setQuantity(e.target.value)} /></label>
        <label className="wide">Photo (optional, shown at 256 x 256)
          <input type="file" accept="image/jpeg,image/png,image/webp" onChange={(e) => void pick(e.target.files?.[0])} />
        </label>
        {preview && <img className="photo-preview wide" src={preview} alt="Photo preview" width={96} height={96} />}
        {photoError && <p className="error wide" role="alert">{photoError}</p>}
        <label>Status
          <select value={status} onChange={(e) => setStatus(e.target.value as TagModel["status"])}>
            {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </label>
        <label className="check"><input type="checkbox" checked={limited} onChange={(e) => setLimited(e.target.checked)} /> Limited edition</label>
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="modal-actions">
        <button type="button" className="ghost" onClick={onCancel}>Cancel</button>
        <button type="submit" disabled={busy}>{busy ? "Adding…" : "Add model"}</button>
      </div>
      <p className="hint">Supplier UID lists are loaded separately for now. New models start as pending.</p>
    </form>
  );
}
