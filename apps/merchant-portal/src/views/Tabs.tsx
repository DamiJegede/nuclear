import { useCallback, useEffect, useState } from "react";
import { RefreshButton } from "./RefreshButton";
import { Avatar } from "./Avatar";
import { Modal } from "./Modal";
import { ApiError, type Api, type Product, type TabDetail, type TabStatus, type TabSummary } from "../api";
import { money } from "../format";
import { usePageTitle } from "../title";
import { useList, when } from "../useList";

const MODES: Record<string, string> = { own: "Own Tab", pitch: "Pitch In", equal: "Equal Shares", host: "On Me" };
const FILTERS: { value: TabStatus | ""; label: string }[] = [
  { value: "", label: "All" }, { value: "open", label: "Open" }, { value: "paying", label: "Paying" }, { value: "unpaid", label: "Unpaid" }, { value: "closed", label: "Closed" },
];
const REFUSED: Record<string, string> = {
  shortfall: "Someone can't cover their share yet.", stale_version: "The tab changed. Look again and retry.", tip_needs_server: "A tip needs a server to receive it.",
  position_closed: "That person closed their tab. Reopen it first or assign it to the Table.", tab_not_open: "The tab isn't open for orders.", member_has_items: "Void their items first.",
};
const explain = (e: unknown) => (e instanceof ApiError ? REFUSED[e.code] ?? `Refused: ${e.code}` : "Couldn't do that. Try again.");

/** Tabs: open and unpaid tabs with who is on them, what they ordered and who pays what; staff can add verbal orders, void, lock, Clear Table, cancel and Pay (docs/TABS.md). */
export function Tabs({ api, onError }: { api: Api; onError: (e: unknown) => void }) {
  usePageTitle("Tabs");
  const [status, setStatus] = useState<TabStatus | "">("");
  const { data, failed, retry } = useList<TabSummary[]>(useCallback(() => api.tabs(status || undefined), [api, status]), onError, `tabs:${status}`);
  const [openId, setOpenId] = useState<string | null>(null);
  return (
    <section>
      <div className="head"><h1>Tabs</h1>
        <div className="head-actions">
          <RefreshButton onClick={retry} />
        </div>
      </div>
      <div className="tabbar" role="group" aria-label="Status">
        {FILTERS.map((f) => <button key={f.value} type="button" className={status === f.value ? "subtab active" : "subtab"} aria-pressed={status === f.value} onClick={() => setStatus(f.value)}>{f.label}</button>)}
      </div>
      <div className="card flush">
        {failed && !data ? <p className="error pad" role="alert">Couldn't load tabs. <button className="link" onClick={retry}>Try Again</button></p>
          : !data ? <p className="muted pad" role="status">Loading…</p>
          : data.length === 0 ? <p className="muted pad">No tabs.</p>
          : (
            <table>
              <thead><tr><th scope="col">Table</th><th scope="col">Status</th><th scope="col">Split</th><th scope="col" className="num">People</th><th scope="col" className="num">Items</th><th scope="col">Opened</th></tr></thead>
              <tbody>
                {data.map((t) => (
                  <tr key={t.id} className="clickable" tabIndex={0} onClick={() => setOpenId(t.id)} onKeyDown={(e) => { if (e.key === "Enter") setOpenId(t.id); }}>
                    <th scope="row">{t.table ?? "No table"}</th>
                    <td><span className={`pill ${t.status === "unpaid" ? "failed" : t.status === "closed" ? "available" : "pending"}`}>{t.status}</span></td>
                    <td>{MODES[t.mode] ?? t.mode}</td><td className="num">{t.members}</td><td className="num">{money(t.items)}</td><td className="when">{when(t.opened_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
      </div>
      {openId && <TabWindow api={api} id={openId} onClose={() => { setOpenId(null); retry(); }} onError={onError} />}
    </section>
  );
}

function TabWindow({ api, id, onClose, onError }: { api: Api; id: string; onClose: () => void; onError: (e: unknown) => void }) {
  const [tab, setTab] = useState<TabDetail | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<"clear" | "cancel" | "pay" | null>(null);
  const [add, setAdd] = useState<{ for: string; product: string; qty: number }>({ for: "table", product: "", qty: 1 });
  const load = useCallback(() => api.tab(id).then(setTab).catch(onError), [api, id, onError]);
  useEffect(() => { void load(); void api.products({}).then((r) => setProducts(r.products)).catch(() => undefined); }, [load, api]);

  async function act(fn: () => Promise<{ tab?: TabDetail } | TabDetail | unknown>, okNote?: string) {
    setBusy(true); setNote(null);
    try { const r = (await fn()) as { tab?: TabDetail } | TabDetail | undefined; const t = r && "tab" in r ? r.tab : (r as TabDetail | undefined); if (t && "members" in t) setTab(t); else await load(); if (okNote) setNote(okNote); }
    catch (e) {
      if (e instanceof ApiError && e.code === "shortfall") { const s = (e.extra?.short as { name: string | null; amount: number }[] | undefined) ?? []; setNote(`${REFUSED.shortfall} ${s.map((x) => `${x.name ?? "The table"} ${money(x.amount)}`).join(", ")}`); await load(); }
      else { onError(e); setNote(explain(e)); }
    } finally { setBusy(false); setConfirm(null); }
  }
  if (!tab) return <Modal title="Tab" onClose={onClose}><p className="muted" role="status">Loading…</p></Modal>;

  const name = (w: string | null) => (w === null ? "Table" : tab.members.find((m) => m.wallet_id === w)?.name ?? "?");
  const live = tab.status === "open" || tab.status === "paying" || tab.status === "unpaid";
  const ordered = tab.items.filter((i) => i.status === "ordered");
  return (
    <Modal title={`${tab.table?.name ?? "Tab"} · ${MODES[tab.mode]} · ${tab.status}`} onClose={onClose} locked={busy}>
      <div className="grid">
        {tab.members.map((m) => (
          <article key={m.wallet_id} className="card" aria-label={m.name}>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}><Avatar name={m.name} photo={m.photo} small /><strong>{m.name}</strong></div>
            <p className="sub">{money(m.subtotal)}{m.host ? " · host" : ""}{m.position_closed ? " · tab closed" : ""}{m.away ? " · left" : ""}</p>
            {m.covered_by && <p className="sub">{m.covered_by.carried ? "On" : "Covered by"} {m.covered_by.name}</p>}
            {live && !m.host && m.subtotal === 0 && <button type="button" className="link" disabled={busy} onClick={() => void act(() => api.tabRemoveMember(id, m.wallet_id))}>Remove</button>}
          </article>
        ))}
      </div>
      <h3>Items</h3>
      {ordered.length === 0 ? <p className="muted">Nothing ordered yet.</p> : (
        <table>
          <thead><tr><th scope="col">Item</th><th scope="col">For</th><th scope="col" className="num">Price</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
          <tbody>{ordered.map((i) => (
            <tr key={i.id}><th scope="row">{i.quantity} × {i.name}{i.by_staff ? " (staff)" : ""}</th><td>{name(i.wallet_id)}</td><td className="num">{money((i.unit_price - i.discount) * i.quantity)}</td>
              <td className="actions">{live && <button type="button" className="link" disabled={busy} onClick={() => void act(() => api.tabVoidItem(id, i.id))}>Void</button>}</td></tr>
          ))}</tbody>
        </table>
      )}
      {tab.status === "open" && (
        <form className="row" onSubmit={(e) => { e.preventDefault(); if (add.product) void act(() => api.tabAddItem(id, { product_id: add.product, quantity: add.qty, ...(add.for === "table" ? { table: true } : { wallet_id: add.for }) })); }}>
          <label>For<select value={add.for} onChange={(e) => setAdd({ ...add, for: e.target.value })}><option value="table">The Table</option>{tab.members.map((m) => <option key={m.wallet_id} value={m.wallet_id}>{m.name}</option>)}</select></label>
          <label>Item<select value={add.product} onChange={(e) => setAdd({ ...add, product: e.target.value })}><option value="">Choose…</option>{products.filter((p) => p.active).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
          <label>Quantity<input inputMode="numeric" value={add.qty} onChange={(e) => setAdd({ ...add, qty: Math.max(1, Number(e.target.value.replace(/\D/g, "")) || 1) })} /></label>
          <button type="submit" disabled={busy || !add.product}>Add Order</button>
        </form>
      )}
      <h3>Who Pays</h3>
      {tab.pays.length === 0 ? <p className="muted">Nobody yet.</p> : (
        <ul>{tab.pays.map((p) => <li key={p.wallet_id}>{p.name}: {money(p.amount)}{p.tip > 0 ? ` (tip ${money(p.tip)}${p.tip_clipped ? ", limited" : ""})` : ""}{p.for.length ? `, covers ${p.for.map(name).join(", ")}` : ""}</li>)}</ul>
      )}
      <p><strong>Bill {money(tab.bill.total)}</strong> · items {money(tab.bill.items)} · tax {money(tab.bill.tax)} · tip {money(tab.bill.tip)}</p>
      {tab.short_total > 0 && <p className="error" role="alert">Short {money(tab.short_total)}{tab.short.some((s) => s.name) ? `: ${tab.short.filter((s) => s.name).map((s) => `${s.name} ${money(s.amount)}`).join(", ")}` : ""}</p>}
      {note && <p className="error" role="alert">{note}</p>}
      {live && (
        <div className="modal-actions">
          <button type="button" className="ghost" disabled={busy} onClick={() => void act(() => api.tabLock(id, !tab.locked))}>{tab.locked ? "Unlock" : "Lock Joins"}</button>
          <button type="button" className="ghost" disabled={busy} onClick={() => setConfirm("cancel")}>Cancel Tab</button>
          {tab.status !== "unpaid" && <button type="button" className="ghost" disabled={busy} onClick={() => setConfirm("clear")}>Clear Table</button>}
          {tab.status !== "open" && <button type="button" disabled={busy || tab.short_total > 0} onClick={() => setConfirm("pay")}>Pay</button>}
        </div>
      )}
      {confirm && (
        <Modal title={confirm === "pay" ? "Pay The Tab" : confirm === "clear" ? "Clear Table" : "Cancel Tab"} onClose={() => setConfirm(null)} locked={busy}>
          {confirm === "pay" && <p>Charge everyone on this tab now? Each person is charged only what they agreed to; if anyone can't pay, nothing is charged.</p>}
          {confirm === "clear" && <p>The party has gone. Try to charge the tab now from what people set aside; either way the table is free for a new party. If someone can't pay, the tab stays unpaid until it is resolved.</p>}
          {confirm === "cancel" && <p>Cancel this tab? Every hold is released and nobody is charged.</p>}
          <div className="modal-actions">
            <button type="button" className="ghost" onClick={() => setConfirm(null)} disabled={busy}>Back</button>
            <button type="button" className={confirm === "cancel" ? "danger" : undefined} disabled={busy} onClick={() => void act(
              confirm === "pay" ? () => api.tabPay(id, tab.version) : confirm === "clear" ? () => api.tabClear(id) : () => api.tabCancel(id))}>
              {confirm === "pay" ? "Pay" : confirm === "clear" ? "Clear Table" : "Cancel Tab"}</button>
          </div>
        </Modal>
      )}
    </Modal>
  );
}
