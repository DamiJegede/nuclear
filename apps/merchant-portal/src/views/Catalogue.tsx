import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { ApiError, type Api, type Category, type Product } from "../api";
import { dollarsToCents, int, money } from "../format";
import { decimalOnly, digitsOnly } from "../inputs";
import { usePageTitle } from "../title";
import { Modal } from "./Modal";

type Load = { categories: Category[]; products: Product[] };

/** The product catalogue: categories on the left, products on the right (add, edit, deactivate, delete, picture). */
export function Catalogue({ api, onError }: { api: Api; onError: (e: unknown) => void }) {
  usePageTitle("Catalogue");
  const [data, setData] = useState<Load | null>(null);
  const [failed, setFailed] = useState(false);
  const [filter, setFilter] = useState<string>("");          // category id; "" = all
  const [q, setQ] = useState("");
  const [form, setForm] = useState<Product | "new" | null>(null);
  const [removing, setRemoving] = useState<Product | null>(null);
  const [catForm, setCatForm] = useState<Category | "new" | null>(null);
  const [catRemoving, setCatRemoving] = useState<Category | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try { const [categories, products] = await Promise.all([api.categories(), api.products()]); setData({ categories, products }); setFailed(false); }
    catch (e) { setFailed(true); onError(e); }
  }, [api, onError]);
  useEffect(() => { void load(); }, [load]);

  async function remove() {
    if (!removing) return;
    setBusy(true); setError(null);
    try { await api.deleteProduct(removing.id); setRemoving(null); await load(); }
    catch (e) { onError(e); setError(e instanceof ApiError && e.code === "product_in_use" ? "This product has been sold, so it can't be deleted. Deactivate it instead." : "Couldn't delete it. Try again."); }
    finally { setBusy(false); }
  }
  async function removeCategory() {
    if (!catRemoving) return;
    setBusy(true); setError(null);
    try { await api.deleteCategory(catRemoving.id); setCatRemoving(null); if (filter === catRemoving.id) setFilter(""); await load(); }
    catch (e) { onError(e); setError(e instanceof ApiError && e.code === "category_has_products" ? "Move or delete its products first." : "Couldn't delete it. Try again."); }
    finally { setBusy(false); }
  }
  async function toggle(p: Product) {
    try { await api.updateProduct(p.id, { active: !p.active }); await load(); } catch (e) { onError(e); }
  }

  if (!data) return <section><h1>Catalogue</h1>{failed ? <p className="error" role="alert">Couldn't load the catalogue. <button className="link" onClick={() => void load()}>Try Again</button></p> : <p className="muted" role="status">Loading…</p>}</section>;
  const term = q.trim().toLowerCase();
  const rows = data.products.filter((p) => (filter === "" || p.category_id === filter) && (!term || p.name.toLowerCase().includes(term)));
  const catName = (id: string | null) => data.categories.find((c) => c.id === id)?.name ?? "—";

  return (
    <section>
      <div className="head"><h1>Catalogue</h1><div className="head-actions"><button type="button" onClick={() => setForm("new")}>Add Product</button></div></div>
      <div className="catalogue">
        <aside className="card categories" aria-label="Categories">
          <h2>Categories</h2>
          <ul>
            <li><button type="button" className={filter === "" ? "cat active" : "cat"} onClick={() => setFilter("")}>All products <span className="subtab-n">{data.products.length}</span></button></li>
            {data.categories.map((c) => (
              <li key={c.id} className="cat-row">
                <button type="button" className={filter === c.id ? "cat active" : "cat"} onClick={() => setFilter(c.id)}>{c.name} <span className="subtab-n">{c.products}</span></button>
                <button type="button" className="ghost small" aria-label={`Rename ${c.name}`} onClick={() => setCatForm(c)}>Edit</button>
                <button type="button" className="ghost small" aria-label={`Delete ${c.name}`} onClick={() => { setError(null); setCatRemoving(c); }}>Delete</button>
              </li>
            ))}
          </ul>
          <button type="button" className="ghost" onClick={() => setCatForm("new")}>Add Category</button>
        </aside>
        <div>
          <div className="filter-box"><input type="search" aria-label="Filter products by name" placeholder="Filter by name" value={q} onChange={(e) => setQ(e.target.value)} autoComplete="off" /></div>
          <div className="card flush">
            {rows.length === 0 ? <p className="muted pad">{data.products.length === 0 ? "No products yet. Add your first one." : "No products match."}</p> : (
              <table>
                <thead><tr><th scope="col">Product</th><th scope="col">Category</th><th scope="col" className="num">Price</th><th scope="col" className="num">Stock</th><th scope="col" className="num">Sold Today</th><th scope="col" className="num">Sold</th><th scope="col">Status</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
                <tbody>
                  {rows.map((p) => (
                    <tr key={p.id}>
                      <th scope="row"><span className="cell-flex">{p.photo ? <img className="thumb" src={p.photo} alt="" width={40} height={40} loading="lazy" /> : <span className="thumb thumb-empty" aria-hidden>▭</span>}<span>{p.name}</span></span></th>
                      <td>{catName(p.category_id)}</td>
                      <td className="num">{p.discount > 0 ? <><s className="muted">{money(p.price)}</s> {money(p.effective_price)}</> : money(p.price)}</td>
                      <td className="num">{p.stock === null ? "Untracked" : int(p.stock)}</td>
                      <td className="num">{int(p.sold_today)}</td>
                      <td className="num">{int(p.total_sold)}</td>
                      <td><span className={`pill ${!p.active ? "closed" : p.status === "sold_out" ? "pending" : "available"}`}>{!p.active ? "inactive" : p.status === "sold_out" ? "sold out" : "active"}</span></td>
                      <td className="actions row-actions">
                        <button type="button" className="ghost" onClick={() => void toggle(p)}>{p.active ? "Deactivate" : "Activate"}</button>
                        <button type="button" className="ghost" onClick={() => setForm(p)}>Edit</button>
                        <button type="button" className="ghost" onClick={() => { setError(null); setRemoving(p); }}>Delete</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>

      {form && <ProductForm api={api} product={form === "new" ? undefined : form} categories={data.categories} defaultCategory={filter} onClose={() => setForm(null)} onError={onError} onSaved={async () => { setForm(null); await load(); }} />}
      {catForm && <CategoryForm api={api} category={catForm === "new" ? undefined : catForm} onClose={() => setCatForm(null)} onError={onError} onSaved={async () => { setCatForm(null); await load(); }} />}
      {removing && (
        <Modal title="Delete Product" onClose={() => setRemoving(null)} locked={busy}>
          <p>Delete <strong>{removing.name}</strong>? This can't be undone. A product that has already been sold can only be deactivated.</p>
          {error && <p className="error" role="alert">{error}</p>}
          <div className="modal-actions">
            <button type="button" disabled={busy} onClick={() => void remove()}>{busy ? "Deleting…" : "Confirm Delete"}</button>
            <button type="button" className="ghost" disabled={busy} onClick={() => setRemoving(null)}>Cancel</button>
          </div>
        </Modal>
      )}
      {catRemoving && (
        <Modal title="Delete Category" onClose={() => setCatRemoving(null)} locked={busy}>
          <p>Delete the category <strong>{catRemoving.name}</strong>? It must have no products.</p>
          {error && <p className="error" role="alert">{error}</p>}
          <div className="modal-actions">
            <button type="button" disabled={busy} onClick={() => void removeCategory()}>{busy ? "Deleting…" : "Confirm Delete"}</button>
            <button type="button" className="ghost" disabled={busy} onClick={() => setCatRemoving(null)}>Cancel</button>
          </div>
        </Modal>
      )}
    </section>
  );
}

function CategoryForm({ api, category, onSaved, onClose, onError }: { api: Api; category?: Category; onSaved: () => Promise<void>; onClose: () => void; onError: (e: unknown) => void }) {
  const [name, setName] = useState(category?.name ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return setError("Give the category a name.");
    setBusy(true); setError(null);
    try { if (category) await api.updateCategory(category.id, { name: name.trim() }); else await api.createCategory(name.trim()); await onSaved(); }
    catch (err) { onError(err); setError("Couldn't save the category. Try again."); }
    finally { setBusy(false); }
  }
  return (
    <Modal title={category ? "Rename Category" : "Add a Category"} onClose={onClose} locked={busy}>
      <form onSubmit={submit} className="modal-form">
        <label>Name<input value={name} maxLength={120} onChange={(e) => setName(e.target.value)} /></label>
        {error && <p className="error" role="alert">{error}</p>}
        <div className="modal-actions">
          <button type="submit" disabled={busy}>{busy ? "Saving…" : category ? "Save Changes" : "Add Category"}</button>
          <button type="button" className="ghost" disabled={busy} onClick={onClose}>Cancel</button>
        </div>
      </form>
    </Modal>
  );
}

function ProductForm({ api, product, categories, defaultCategory, onSaved, onClose, onError }: {
  api: Api; product?: Product; categories: Category[]; defaultCategory: string; onSaved: () => Promise<void>; onClose: () => void; onError: (e: unknown) => void;
}) {
  const editing = !!product;
  const [name, setName] = useState(product?.name ?? "");
  const [price, setPrice] = useState(product ? (product.price / 100).toFixed(2) : "");
  const [discount, setDiscount] = useState(product && product.discount > 0 ? (product.discount / 100).toFixed(2) : "");
  const [category, setCategory] = useState(product?.category_id ?? defaultCategory);
  const [stock, setStock] = useState(product?.stock === null || product?.stock === undefined ? "" : String(product.stock));
  const [active, setActive] = useState(product?.active ?? true);
  const [photo, setPhoto] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(product?.photo ?? null);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
    const off = discount.trim() === "" ? 0 : dollarsToCents(discount);
    const qty = stock.trim() === "" ? null : Number(stock);
    if (!name.trim()) return setError("Give the product a name.");
    if (cents === null) return setError("Enter the price in dollars, like 4.50.");
    if (off === null) return setError("Enter the discount in dollars, like 0.50.");
    if (off > cents) return setError("The discount can't be more than the price.");
    setBusy(true);
    try {
      const fields = { name: name.trim(), price: cents, discount: off, category_id: category || null, stock: qty, active };
      const saved = product ? await api.updateProduct(product.id, fields) : await api.createProduct(fields);
      if (photo) { try { await api.uploadProductPhoto(saved.id, photo); } catch (err) { onError(err); } }
      await onSaved();
    } catch (err) {
      onError(err);
      setError(err instanceof ApiError && err.code === "discount_exceeds_price" ? "The discount can't be more than the price." : "Couldn't save the product. Try again.");
    } finally { setBusy(false); }
  }

  return (
    <Modal title={editing ? "Edit Product" : "Add a Product"} onClose={onClose} locked={busy}>
      <form onSubmit={submit} className="modal-form">
        <div className="fields">
          <label className="wide">Name<input value={name} maxLength={120} onChange={(e) => setName(e.target.value)} /></label>
          <label>Price (USD)<input inputMode="decimal" placeholder="4.50" value={price} onChange={(e) => setPrice(decimalOnly(e.target.value))} /></label>
          <label>Discount (USD)<input inputMode="decimal" placeholder="0.00" value={discount} onChange={(e) => setDiscount(decimalOnly(e.target.value))} /></label>
          <label>Category
            <select value={category} onChange={(e) => setCategory(e.target.value)}>
              <option value="">NONE</option>
              {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
          <label>Stock<input inputMode="numeric" placeholder="Empty = not tracked" value={stock} onChange={(e) => setStock(digitsOnly(e.target.value))} /></label>
          <div className="wide">
            <span className="field-label">Picture</span>
            <div className="file-pick">
              <span className="cell-flex">{preview ? <img className="thumb" src={preview} alt="Product preview" width={40} height={40} /> : null}<span className="muted file-name">{photo ? photo.name : preview ? "Picture saved" : "No picture yet"}</span></span>
              <button type="button" className="ghost" onClick={() => input.current?.click()}>{preview ? "Replace" : "Select"}</button>
              <input ref={input} type="file" className="sr-only" aria-label="Picture" accept="image/png,image/jpeg,image/webp" onChange={(e) => { pick(e.target.files?.[0]); e.target.value = ""; }} />
            </div>
            {photoError && <p className="error" role="alert">{photoError}</p>}
          </div>
          <label className="toggle-card wide">
            <span className="toggle-text"><strong>Active (shown on terminals)</strong></span>
            <input type="checkbox" role="switch" checked={active} onChange={(e) => setActive(e.target.checked)} aria-label="Active" />
            <span className="switch" aria-hidden />
          </label>
        </div>
        {error && <p className="error" role="alert">{error}</p>}
        <div className="modal-actions">
          <button type="submit" disabled={busy}>{busy ? "Saving…" : editing ? "Save Changes" : "Add Product"}</button>
          <button type="button" className="ghost" disabled={busy} onClick={onClose}>Cancel</button>
        </div>
      </form>
    </Modal>
  );
}
