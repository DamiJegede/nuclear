import { createResource, For, Show } from 'solid-js';

// The page behind a table's QR code or NFC cube (docs/TABS.md): the merchant's menu, read-only. Ordering happens in the Nuclear app, which opens this same link.
const API = 'https://api.nclr.app';
const money = (cents) => `$${(cents / 100).toFixed(2)}`;
const load = async (code) => {
 const r = await fetch(`${API}/v1/menu/${encodeURIComponent(code)}`);
 if (!r.ok) throw new Error(r.status === 404 ? 'not_found' : 'failed');
 return r.json();
};
export default function Menu(props) {
 const [menu] = createResource(() => props.code, load);
 const groups = () => {
  const m = new Map();
  for (const p of menu()?.products ?? []) { const k = p.category ?? 'Menu'; m.set(k, [...(m.get(k) ?? []), p]); }
  return [...m.entries()];
 };
 return (
  <main style={{ 'max-width': '40rem', margin: '0 auto', padding: '2rem 1.25rem', 'font-family': 'system-ui, sans-serif' }}>
   <Show when={!menu.error} fallback={<><h1>This table isn’t available.</h1><p>The code may have changed. Ask your server for the current one.</p></>}>
    <Show when={menu()} fallback={<p>Loading the menu…</p>}>
     <header>
      <Show when={menu().merchant.photo}><img src={menu().merchant.photo} alt="" width="64" height="64" style={{ 'border-radius': '50%' }} /></Show>
      <h1>{menu().merchant.name}</h1>
      <p>{menu().table.name}</p>
     </header>
     <Show when={(menu().offers ?? []).length > 0}>
      <section aria-label="Offers">
       <h2>Offers</h2>
       <ul style={{ 'list-style': 'none', padding: 0 }}>
        <For each={menu().offers}>{(o) => (
         <li style={{ padding: '0.5rem 0', 'border-bottom': '1px solid #8883' }}><strong>{o.name}</strong>{o.name !== o.description ? <span style={{ opacity: 0.7 }}> · {o.description}</span> : null}
          {o.schedule_text ? <div style={{ opacity: 0.7 }}>{o.schedule_text} · {o.live_now ? 'on now' : 'not on right now'}</div> : null}</li>
        )}</For>
       </ul>
       <p style={{ opacity: 0.7 }}>Offers are applied to your order automatically.</p>
      </section>
     </Show>
     <For each={groups()}>{([category, items]) => (
      <section>
       <h2>{category}</h2>
       <ul style={{ 'list-style': 'none', padding: 0 }}>
        <For each={items}>{(p) => (
         <li style={{ display: 'flex', 'justify-content': 'space-between', gap: '1rem', padding: '0.5rem 0', 'border-bottom': '1px solid #8883' }}>
          <span>{p.name}</span>
          <span>{p.discount > 0 ? <><s>{money(p.price)}</s> {money(p.price - p.discount)}</> : money(p.price)}</span>
         </li>
        )}</For>
       </ul>
      </section>
     )}</For>
     <p style={{ opacity: 0.7 }}>
      {menu().tax.rate > 0 ? (menu().tax.included ? `Prices include ${(menu().tax.rate / 100).toFixed(2)}% sales tax.` : `Sales tax of ${(menu().tax.rate / 100).toFixed(2)}% is added to taxable items.`) : ''}
     </p>
     <p>Open this link on your phone with the Nuclear app to start or join the table’s tab. Everyone at the table can add their own items and pay their share.</p>
    </Show>
   </Show>
  </main>
 );
}
