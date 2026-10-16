import { useCallback, useEffect, useState, type FormEvent } from "react";
import { ApiError, type Api, type TagModel } from "../api";
import { dollarsToCents, int, money } from "../format";

const STATUSES: TagModel["status"][] = ["pending", "preorder", "available", "closed"];

export function Models({ api, onError }: { api: Api; onError: (e: unknown) => void }) {
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

  return (
    <section>
      <div className="head"><h1>Tag models</h1></div>

      <div className="card flush">
        {failed && !models ? (
          <p className="error pad" role="alert">Couldn't load models. <button className="link" onClick={() => void load()}>Try again</button></p>
        ) : !models ? (
          <p className="muted pad" role="status">Loading…</p>
        ) : models.length === 0 ? (
          <p className="muted pad">No models yet. Add the first one below.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th scope="col">Model</th>
                <th scope="col">Status</th>
                <th scope="col" className="num">Price</th>
                <th scope="col" className="num">Allocated</th>
                <th scope="col" className="num">Sold</th>
                <th scope="col" className="num">UIDs loaded</th>
                <th scope="col" className="num">Unassigned</th>
              </tr>
            </thead>
            <tbody>
              {models.map((m) => (
                <tr key={m.id}>
                  <th scope="row">{m.name} <span className="muted note">{m.type}{m.limited ? " · limited" : ""}</span></th>
                  <td><span className={`pill ${m.status}`}>{m.status}</span></td>
                  <td className="num">{money(m.price)}</td>
                  <td className="num">{int(m.quantity)}</td>
                  <td className="num">{int(m.sold)}</td>
                  <td className="num">{int(m.tags ?? 0)}</td>
                  <td className="num">{int(m.unassigned ?? 0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <NewModelForm api={api} onCreated={load} onError={onError} />
    </section>
  );
}

function NewModelForm({ api, onCreated, onError }: { api: Api; onCreated: () => Promise<void>; onError: (e: unknown) => void }) {
  const [name, setName] = useState("");
  const [type, setType] = useState<"band" | "card">("band");
  const [price, setPrice] = useState("");
  const [quantity, setQuantity] = useState("");
  const [photo, setPhoto] = useState("");
  const [limited, setLimited] = useState(false);
  const [status, setStatus] = useState<TagModel["status"]>("pending"); // new models start pending
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setDone(null);
    const cents = dollarsToCents(price);
    const qty = Number(quantity);
    if (!name.trim()) return setError("Give the model a name.");
    if (cents === null) return setError("Enter the price in dollars, like 29.99.");
    if (!Number.isInteger(qty) || qty < 0) return setError("Quantity must be a whole number.");

    setBusy(true);
    try {
      const m = await api.createModel({
        type, name: name.trim(), price: cents, quantity: qty, limited, status,
        ...(photo.trim() ? { photo: photo.trim() } : {}),
      });
      setDone(`Added ${m.name}.`);
      setName(""); setPrice(""); setQuantity(""); setPhoto(""); setLimited(false); setStatus("pending");
      await onCreated();
    } catch (err) {
      onError(err);
      setError(err instanceof ApiError && err.status === 400 ? "The API rejected those details. Check each field." : "Couldn't add the model. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card form" onSubmit={submit} aria-labelledby="new-model">
      <h2 id="new-model">Add a model</h2>
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
        <label className="wide">Photo URL (optional)<input type="url" value={photo} onChange={(e) => setPhoto(e.target.value)} /></label>
        <label>Status
          <select value={status} onChange={(e) => setStatus(e.target.value as TagModel["status"])}>
            {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </label>
        <label className="check"><input type="checkbox" checked={limited} onChange={(e) => setLimited(e.target.checked)} /> Limited edition</label>
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      {done && <p className="ok" role="status">{done}</p>}
      <button type="submit" disabled={busy}>{busy ? "Adding…" : "Add model"}</button>
      <p className="hint">Supplier UID lists are loaded separately for now; the table above shows how many each model has.</p>
    </form>
  );
}
