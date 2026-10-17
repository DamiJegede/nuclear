import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { ApiError, type Api, type ShopItem } from "../api";
import { dollarsToCents, int, money } from "../format";
import { decimalOnly, digitsOnly } from "../inputs";
import { usePageTitle } from "../title";
import { Modal } from "./Modal";
import { PhotoDrop } from "./TagForm";

const tone = (s: string) => (s === "available" ? "available" : s === "pending" ? "pending" : "closed");

/** Merchandise we sell in the store (shirts, caps...). Tags are sold from the Tags page's models. */
export function Shop({ api, onError, canWrite }: { api: Api; onError: (e: unknown) => void; canWrite: boolean }) {
  usePageTitle("Shop");
  const [items, setItems] = useState<ShopItem[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [form, setForm] = useState<ShopItem | "new" | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function changeStatus(i: ShopItem, next: ShopItem["status"]) {
    setNotice(null);
    try { await api.updateShopItem(i.id, { status: next }); await load(); }
    catch (e) { onError(e); setNotice(e instanceof ApiError && e.code === "file_required" ? `Add the download file to "${i.name}" first (Edit).` : "Couldn't change the status. Try again."); }
  }

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
      {notice && <p className="error" role="alert">{notice}</p>}
      <div className="card flush">
        {failed && !items ? <p className="error pad" role="alert">Couldn't load the shop. <button className="link" onClick={() => void load()}>Try Again</button></p>
          : !items ? <p className="muted pad" role="status">Loading…</p>
          : items.length === 0 ? <p className="muted pad">No items yet.</p>
          : (
            <table>
              <thead><tr><th scope="col">Item</th><th scope="col">Type</th><th scope="col" className="num">Price</th><th scope="col" className="num">Stock</th><th scope="col" className="num">Sold</th><th scope="col">Status</th>{canWrite && <th scope="col"><span className="sr-only">Actions</span></th>}</tr></thead>
              <tbody>
                {items.map((i) => (
                  <tr key={i.id}>
                    <th scope="row">
                      <span className="cell-flex">
                        {i.photo ? <img className="thumb" src={i.photo} alt="" width={40} height={40} loading="lazy" /> : <span className="thumb thumb-empty" aria-hidden>▭</span>}
                        <span>{i.name}{i.description ? <span className="muted block">{i.description}</span> : null}</span>
                      </span>
                    </th>
                    <td><span className="pill">{i.kind}</span></td>
                    <td className="num">{money(i.price)}</td>
                    <td className="num">{i.kind === "digital" ? "—" : i.stock === null ? "Untracked" : int(i.stock)}</td>
                    <td className="num">{int(i.sold)}</td>
                    <td><span className={`pill ${tone(i.status)}`}>{i.status}</span></td>
                    {canWrite && (
                      <td className="num actions">
                        <button type="button" className="ghost" onClick={() => void changeStatus(i, i.status === "available" ? "closed" : "available")}>{i.status === "available" ? "Close" : i.status === "closed" ? "Reopen" : "Publish"}</button>{" "}
                        <button type="button" className="ghost" onClick={() => setForm(i)}>Edit</button>
                      </td>
                    )}
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
  const [kind, setKind] = useState<ShopItem["kind"]>(item?.kind ?? "physical");
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [photo, setPhoto] = useState<Blob | null>(null);
  const [preview, setPreview] = useState<string | null>(item?.photo ?? null);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Any common image format is fine here; the server crops it to 256 x 256 and compresses it.
  function pick(file: File | undefined) {
    setPhotoError(null);
    if (!file) return;
    if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) return setPhotoError("Choose a PNG, JPEG or WebP image.");
    if (file.size > 8 * 1024 * 1024) return setPhotoError("The image is over 8 MB.");
    setPhoto(file);
    setPreview((old) => { if (old && old.startsWith("blob:")) URL.revokeObjectURL(old); return URL.createObjectURL(file); });
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const cents = dollarsToCents(price);
    const qty = stock.trim() === "" ? null : Number(stock);
    if (!name.trim()) return setError("Give the item a name.");
    if (cents === null) return setError("Enter the price in dollars, like 24.99.");
    if (kind === "physical" && qty !== null && (!Number.isInteger(qty) || qty < 0)) return setError("Stock must be a whole number, or empty if not tracked.");
    if (!editing && !photo) return setError("Add an image of the item.");
    setBusy(true);
    try {
      const fields = { name: name.trim(), description: description.trim() || null, price: cents, kind, ...(kind === "physical" ? { stock: qty } : {}) };
      const saved = editing ? await api.updateShopItem(item!.id, fields) : await api.createShopItem(fields);
      if (photo) { try { await api.uploadShopItemPhoto(saved.id, photo); } catch (err) { onError(err); } }
      if (kind === "digital" && file) {
        try {
          await api.uploadShopItemFile(saved.id, file);
        } catch (err) { onError(err); setError("The item was saved, but its file could not be uploaded. Edit the item to add it again."); setBusy(false); return; }
      }
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
          <fieldset className="wide choice-field">
            <div className="choice-grid" role="radiogroup" aria-label="Product Type">
              {([["physical", "Physical Product", "Requires handling, shipping and delivery"], ["digital", "Digital Product", "Available for download after payment"]] as const).map(([value, title, text]) => (
                <label key={value} className="choice product-kind">
                  <input type="radio" name="item-kind" value={value} checked={kind === value} disabled={!!item && item.sold > 0 && item.kind !== value} onChange={() => setKind(value)} />
                  <strong>{title}</strong>
                  <span className="kind-text">{text}</span>
                </label>
              ))}
            </div>
          </fieldset>
          <label className="wide">Name<input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} /></label>
          <label className="wide">Description<input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} /></label>
          <label>Price (USD)<input inputMode="decimal" placeholder="24.99" value={price} onChange={(e) => setPrice(decimalOnly(e.target.value))} /></label>
          {kind === "physical"
            ? <label>Stock<input inputMode="numeric" placeholder="Empty = not tracked" value={stock} onChange={(e) => setStock(digitsOnly(e.target.value))} /></label>
            : <DownloadFile current={item?.has_file ? item.file_ext : null} file={file} error={fileError} onFile={(f) => { setFileError(null); if (f && f.size > 25 * 1024 * 1024) { setFileError("The file is over 25 MB."); return; } setFile(f ?? null); }} />}
          <PhotoDrop preview={preview} error={photoError} onFile={(f) => pick(f)} label="Item Image" accept="image/png,image/jpeg,image/webp" noun="an image" />
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

/** The file buyers get after paying (digital products): one compact row, the name is cut short so it never widens the form. */
function DownloadFile({ current, file, error, onFile }: { current: string | null; file: File | null; error: string | null; onFile: (f: File | undefined) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const label = file ? file.name : current ? `${current.toUpperCase()} file saved` : "No file yet";
  return (
    <div className="download-file">
      <span className="field-label">Download File (25 MB max)</span>
      <div className="file-pick">
        <span className="muted file-name" title={label}>{label}</span>
        <button type="button" className="ghost" onClick={() => input.current?.click()}>{file || current ? "Replace" : "Select"}</button>
        <input ref={input} type="file" className="sr-only" aria-label="Download File" accept=".pdf,.zip,.epub,.mp3,.mp4,.png,.jpg,.jpeg,.txt" onChange={(e) => { onFile(e.target.files?.[0]); e.target.value = ""; }} />
      </div>
      {error && <p className="error" role="alert">{error}</p>}
    </div>
  );
}
