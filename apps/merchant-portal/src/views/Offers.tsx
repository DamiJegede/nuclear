import { useCallback, useEffect, useState } from "react";
import { RefreshButton } from "./RefreshButton";
import { RowMenu } from "./RowMenu";
import { Modal } from "./Modal";
import { type Api, type Offer, type Product } from "../api";
import { usePageTitle } from "../title";
import { useList } from "../useList";

/** Offers (docs/OFFERS.md): buy X, get Y free or part price. The server applies them to every order: the terminal, the customer's app and the table menu all show the same price. */
export function Offers({ api, onError }: { api: Api; onError: (e: unknown) => void }) {
  usePageTitle("Offers");
  const { data, failed, retry } = useList<Offer[]>(useCallback(() => api.offers(), [api]), onError, "offers");
  const [form, setForm] = useState<Offer | "new" | null>(null);
  const [removing, setRemoving] = useState<Offer | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function remove() {
    if (!removing) return;
    setBusy(true); setError(null);
    try { await api.deleteOffer(removing.id); setRemoving(null); retry(); }
    catch (e) { onError(e); setError("Couldn't delete the offer. Try again."); }
    finally { setBusy(false); }
  }

  return (
    <section>
      <div className="head"><h1>Offers</h1><div className="head-actions"><button type="button" onClick={() => setForm("new")}>Add Offer</button><RefreshButton onClick={retry} /></div></div>
      <div className="card flush">
        {failed && !data ? <p className="error pad" role="alert">Couldn't load offers. <button className="link" onClick={retry}>Try Again</button></p>
          : !data ? <p className="muted pad" role="status">Loading…</p>
          : data.length === 0 ? <p className="muted pad">No offers yet. Add one, such as buy one get one free.</p>
          : (
            <table>
              <thead><tr><th scope="col">Offer</th><th scope="col">Rule</th><th scope="col">Status</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
              <tbody>
                {data.map((o) => (
                  <tr key={o.id}>
                    <th scope="row">{o.name}</th>
                    <td>{o.description}</td>
                    <td><span className={`pill ${o.active ? "available" : "pending"}`}>{o.active ? "active" : "off"}</span></td>
                    <td className="actions">
                      <RowMenu label={`Actions for ${o.name}`} items={[
                        { label: o.active ? "Turn Off" : "Turn On", onSelect: () => void api.updateOffer(o.id, { active: !o.active }).then(retry).catch(onError) },
                        { label: "Edit", onSelect: () => setForm(o) },
                        { label: "Delete", danger: true, onSelect: () => { setError(null); setRemoving(o); } },
                      ]} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
      </div>
      <p className="note muted">An offer applies by itself at the counter, in the customer's app and on the table menu. When more than one fits the same items, the customer gets the one that saves them most. Sales tax is worked out on what they pay.</p>
      {form && <OfferForm api={api} offer={form === "new" ? undefined : form} onClose={() => setForm(null)} onError={onError} onSaved={() => { setForm(null); retry(); }} />}
      {removing && (
        <Modal title="Delete Offer" onClose={() => setRemoving(null)} locked={busy}>
          <p>Delete <strong>{removing.name}</strong>? Orders already made keep the price they were given.</p>
          {error && <p className="error" role="alert">{error}</p>}
          <div className="modal-actions"><button type="button" className="ghost" onClick={() => setRemoving(null)} disabled={busy}>Cancel</button><button type="button" className="danger" onClick={() => void remove()} disabled={busy}>Delete Offer</button></div>
        </Modal>
      )}
    </section>
  );
}

const DISCOUNTS: { label: string; percent: number | "custom" }[] = [{ label: "Free", percent: 100 }, { label: "Half price", percent: 50 }, { label: "Custom", percent: "custom" }];

/** A product choice with a search box: the list is read from the server by name, so a long catalogue is never cut off. */
function ProductPicker({ api, label, value, valueName, onPick, onError }: { api: Api; label: string; value: string; valueName: string; onPick: (p: { id: string; name: string }) => void; onError: (e: unknown) => void }) {
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<Product[] | null>(null);
  useEffect(() => {
    let live = true;
    const t = setTimeout(() => { api.products({ q: q.trim() || undefined, limit: 100 }).then((r) => { if (live) setRows(r.products.filter((p) => p.active)); }).catch(onError); }, q ? 250 : 0);
    return () => { live = false; clearTimeout(t); };
  }, [api, q, onError]);
  const list = rows ?? [];
  const shown = value && !list.some((p) => p.id === value) ? [{ id: value, name: valueName } as Product, ...list] : list;
  return (
    <div className="picker">
      <label>{label}<input type="search" aria-label={`Search ${label}`} placeholder="Search products" value={q} onChange={(e) => setQ(e.target.value)} autoComplete="off" /></label>
      <select aria-label={label} value={value} onChange={(e) => { const p = shown.find((x) => x.id === e.target.value); if (p) onPick({ id: p.id, name: p.name }); }}>
        <option value="">{rows === null ? "Loading…" : "Choose a product…"}</option>
        {shown.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select>
    </div>
  );
}

function OfferForm({ api, offer, onSaved, onClose, onError }: { api: Api; offer?: Offer; onSaved: () => void; onClose: () => void; onError: (e: unknown) => void }) {
  const [buy, setBuy] = useState({ id: offer?.buy_product_id ?? "", name: offer?.buy_product_name ?? "" });
  const [buyQty, setBuyQty] = useState(String(offer?.buy_qty ?? 1));
  const [same, setSame] = useState(offer ? offer.same_product : true);
  const [get, setGet] = useState({ id: offer && !offer.same_product ? offer.get_product_id : "", name: offer && !offer.same_product ? offer.get_product_name : "" });
  const [getQty, setGetQty] = useState(String(offer?.get_qty ?? 1));
  const preset = offer ? (offer.percent_off === 100 ? 100 : offer.percent_off === 50 ? 50 : "custom") : 100;
  const [kind, setKind] = useState<number | "custom">(preset);
  const [custom, setCustom] = useState(offer && preset === "custom" ? String(offer.percent_off) : "25");
  const [name, setName] = useState(offer?.name ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const percent = kind === "custom" ? Number(custom) : kind;
  const ok = !!buy.id && (same || !!get.id) && Number(buyQty) >= 1 && Number(getQty) >= 1 && Number.isInteger(percent) && percent >= 1 && percent <= 100;

  async function save() {
    setBusy(true); setError(null);
    const input = { buy_product_id: buy.id, buy_qty: Number(buyQty), get_product_id: same ? null : get.id, get_qty: Number(getQty), percent_off: percent, ...(name.trim() ? { name: name.trim() } : {}) };
    try { if (offer) await api.updateOffer(offer.id, input); else await api.createOffer(input); onSaved(); }
    catch (e) { onError(e); setError("Couldn't save the offer. Try again."); }
    finally { setBusy(false); }
  }

  return (
    <Modal title={offer ? "Edit Offer" : "Add Offer"} onClose={onClose} locked={busy}>
      <form onSubmit={(e) => { e.preventDefault(); if (ok) void save(); }}>
        <ProductPicker api={api} label="Customer buys" value={buy.id} valueName={buy.name} onPick={setBuy} onError={onError} />
        <label>How many<input inputMode="numeric" value={buyQty} maxLength={2} onChange={(e) => setBuyQty(e.target.value.replace(/\D/g, ""))} /></label>
        <fieldset className="choice-grid" role="radiogroup" aria-label="What they get">
          <label className="choice"><input type="radio" name="get-kind" checked={same} onChange={() => setSame(true)} /><span>The same product</span></label>
          <label className="choice"><input type="radio" name="get-kind" checked={!same} onChange={() => setSame(false)} /><span>Another product</span></label>
        </fieldset>
        {!same && <ProductPicker api={api} label="Customer gets" value={get.id} valueName={get.name} onPick={setGet} onError={onError} />}
        <label>How many they get<input inputMode="numeric" value={getQty} maxLength={2} onChange={(e) => setGetQty(e.target.value.replace(/\D/g, ""))} /></label>
        <fieldset className="choice-grid" role="radiogroup" aria-label="Discount">
          {DISCOUNTS.map((d) => (
            <label key={d.label} className="choice"><input type="radio" name="discount" checked={kind === d.percent} onChange={() => setKind(d.percent)} /><span>{d.label}</span></label>
          ))}
        </fieldset>
        {kind === "custom" && <label>Percent off<input inputMode="numeric" value={custom} maxLength={3} onChange={(e) => setCustom(e.target.value.replace(/\D/g, ""))} /></label>}
        <label>Name (optional)<input value={name} maxLength={80} onChange={(e) => setName(e.target.value)} placeholder="Shown to customers; we write one if you leave it empty" /></label>
        {error && <p className="error" role="alert">{error}</p>}
        <div className="modal-actions"><button type="button" className="ghost" onClick={onClose} disabled={busy}>Cancel</button><button type="submit" disabled={busy || !ok}>Save</button></div>
      </form>
    </Modal>
  );
}
