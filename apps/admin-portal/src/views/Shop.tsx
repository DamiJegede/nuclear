import { useCallback, useEffect, useState, type FormEvent } from "react";
import { ApiError, type Api, type ShopItem } from "../api";
import { dollarsToCents, int, money } from "../format";
import { resizePhoto } from "../image";
import { usePageTitle } from "../title";
import { Modal } from "./Modal";
import { PhotoDrop } from "./TagForm";

const STATUSES: ShopItem["status"][] = ["pending", "available", "closed"];
const tone = (s: string) => (s === "available" ? "available" : s === "pending" ? "pending" : "closed");

/** Merchandise we sell in the store (shirts, caps...). Tags are sold from the Tags page's models. */
export function Shop({ api, onError, canWrite }: { api: Api; onError: (e: unknown) => void; canWrite: boolean }) {
  usePageTitle("Shop");
  const [items, setItems] = useState<ShopItem[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [form, setForm] = useState<ShopItem | "new" | null>(null);

  const load = useCallback(async () => {
    try { setItems(await api.shopItems()); setFailed(false); } catch (e) { setFailed(true); onError(e); }
  }, [api, onError]);
  useEffect(() => { void load(); }, [load]);

  return (
    <section>
      <div className="head">
        <h1>Shop</h1>
        {canWrite && <div className="head-actions"><button type="button" onClick={() => setForm("new")}>Add Item</button></div>}
      </div>
      <div className="card flush">
        {failed && !items ? <p className="error pad" role="alert">Couldn't load the shop. <button className="link" onClick={() => void load()}>Try Again</button></p>
          : !items ? <p className="muted pad" role="status">Loading…</p>
          : items.length === 0 ? <p className="muted pad">No items yet.</p>
          : (
            <table>
              <thead><tr><th scope="col">Item</th><th scope="col" className="num">Price</th><th scope="col" className="num">Stock</th><th scope="col" className="num">Sold</th><th scope="col">Status</th>{canWrite && <th scope="col"><span className="sr-only">Actions</span></th>}</tr></thead>
              <tbody>
                {items.map((i) => (
                  <tr key={i.id}>
                    <th scope="row">
                      <span className="cell-flex">
                        {i.photo ? <img className="thumb" src={i.photo} alt="" width={40} height={40} loading="lazy" /> : <span className="thumb thumb-empty" aria-hidden>▭</span>}
                        <span>{i.name}{i.description ? <span className="muted block">{i.description}</span> : null}</span>
                      </span>
                    </th>
                    <td className="num">{money(i.price)}</td>
                    <td className="num">{i.stock === null ? "Untracked" : int(i.stock)}</td>
                    <td className="num">{int(i.sold)}</td>
                    <td><span className={`pill ${tone(i.status)}`}>{i.status}</span></td>
                    {canWrite && <td className="num"><button type="button" className="ghost" onClick={() => setForm(i)}>Edit</button></td>}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
      </div>
      {form && <ItemForm api={api} item={form === "new" ? undefined : form} onClose={() => setForm(null)} onError={onError} onSaved={async () => { setForm(null); await load(); }} />}
    </section>
  );
}

function ItemForm({ api, item, onSaved, onClose, onError }: { api: Api; item?: ShopItem; onSaved: () => Promise<void>; onClose: () => void; onError: (e: unknown) => void }) {
  const editing = !!item;
  const [name, setName] = useState(item?.name ?? "");
  const [description, setDescription] = useState(item?.description ?? "");
  const [price, setPrice] = useState(item ? (item.price / 100).toFixed(2) : "");
  const [stock, setStock] = useState(item ? (item.stock === null ? "" : String(item.stock)) : "");
  const [status, setStatus] = useState<ShopItem["status"]>(item?.status ?? "pending");
  const [photo, setPhoto] = useState<Blob | null>(null);
  const [preview, setPreview] = useState<string | null>(item?.photo ?? null);
  const [photoError, setPhotoError] = useState<string | null>(null);
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
    } catch { setPhotoError("Couldn't read that image. Choose a PNG picture."); }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const cents = dollarsToCents(price);
    const qty = stock.trim() === "" ? null : Number(stock);
    if (!name.trim()) return setError("Give the item a name.");
    if (cents === null) return setError("Enter the price in dollars, like 24.99.");
    if (qty !== null && (!Number.isInteger(qty) || qty < 0)) return setError("Stock must be a whole number, or empty if not tracked.");
    if (!editing && !photo) return setError("Add a PNG image of the item.");
    setBusy(true);
    try {
      const fields = { name: name.trim(), description: description.trim() || null, price: cents, stock: qty, status };
      const saved = editing ? await api.updateShopItem(item!.id, fields) : await api.createShopItem(fields);
      if (photo) { try { await api.uploadShopItemPhoto(saved.id, photo); } catch (err) { onError(err); } }
      await onSaved();
    } catch (err) {
      onError(err);
      setError(err instanceof ApiError && err.status === 400 ? "The API rejected those details. Check each field." : "Couldn't save the item. Try again.");
    } finally { setBusy(false); }
  }

  return (
    <Modal title={editing ? "Edit Item" : "Add an Item"} onClose={onClose} locked={busy}>
      <form onSubmit={submit} className="modal-form">
        <div className="fields">
          <label className="wide">Name<input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} /></label>
          <label className="wide">Description<input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} /></label>
          <label>Price (USD)<input inputMode="decimal" placeholder="24.99" value={price} onChange={(e) => setPrice(e.target.value)} /></label>
          <label>Stock<input inputMode="numeric" placeholder="Empty = not tracked" value={stock} onChange={(e) => setStock(e.target.value)} /></label>
          <PhotoDrop preview={preview} error={photoError} onFile={(f) => void pick(f)} label="Item Image (PNG only)" />
          <label>Status
            <select value={status} onChange={(e) => setStatus(e.target.value as ShopItem["status"])}>
              {STATUSES.map((s) => <option key={s} value={s}>{s.toUpperCase()}</option>)}
            </select>
          </label>
        </div>
        {error && <p className="error" role="alert">{error}</p>}
        <div className="modal-actions">
          <button type="submit" disabled={busy}>{busy ? "Saving…" : editing ? "Save Changes" : "Add Item"}</button>
          <button type="button" className="ghost" onClick={onClose} disabled={busy}>Cancel</button>
        </div>
      </form>
    </Modal>
  );
}
