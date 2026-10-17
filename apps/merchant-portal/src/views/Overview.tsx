import { useCallback, useRef, useState } from "react";
import type { Account, Api, Overview as OverviewData } from "../api";
import { int, money } from "../format";
import { usePageTitle } from "../title";
import { useList } from "../useList";
import { Avatar } from "./Avatar";
import { LogoCrop } from "./LogoCrop";

/** The business at a glance: three large cards (profile, today, catalog), then terminals, approvals, staff and orders. */
export function Overview({ api, account, onChanged, onError, go }: { api: Api; account: Account; onChanged: () => void; onError: (e: unknown) => void; go: (page: string) => void }) {
  usePageTitle("Overview");
  // One request for the whole page (it used to be ten, each repeating the sign-in checks).
  const { data, failed, retry } = useList<OverviewData>(useCallback(() => api.overview(), [api]), onError);
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);

  function pick(f: File | undefined) {
    setFileError(null);
    if (!f) return;
    if (!["image/png", "image/jpeg", "image/webp"].includes(f.type)) return setFileError("Choose a PNG, JPEG or WebP image.");
    if (f.size > 8 * 1024 * 1024) return setFileError("The image is over 8 MB.");
    setFile(f);
  }

  if (!data) return <section><h1>Overview</h1>{failed ? <p className="error" role="alert">Couldn't load the numbers. <button className="link" onClick={retry}>Try Again</button></p> : <p className="muted" role="status">Loading…</p>}</section>;
  const pendingTotal = data.pending_refunds.amount, refundCount = data.pending_refunds.count;
  const place = [data.city, data.state].filter(Boolean).join(" • ");
  const nav = (page: string) => (e: React.MouseEvent) => { e.preventDefault(); go(page); };

  return (
    <section>
      <div className="head"><h1>Overview</h1><button type="button" className="ghost" onClick={retry}>Refresh</button></div>
      {refundCount > 0 && (
        <div className="banner bad" role="status">
          {int(refundCount)} refund{refundCount === 1 ? "" : "s"} ({money(pendingTotal)}) waiting for your approval. <button type="button" className="link" onClick={() => go("refunds")}>Review Refunds</button>
        </div>
      )}

      <div className="grid three">
        <article className="card linkcard profile-tile" aria-label="Profile">
          <button type="button" className="logo-btn" aria-label="Replace logo" onClick={() => input.current?.click()}>
            <Avatar name={account.name} photo={account.photo} />
            <span className="logo-hint" aria-hidden>{account.photo ? "Replace" : "Add Logo"}</span>
          </button>
          <input ref={input} type="file" className="sr-only" aria-label="Logo" accept="image/png,image/jpeg,image/webp" onChange={(e) => { pick(e.target.files?.[0]); e.target.value = ""; }} />
          <div className="tile-text">
            <a href="/profile" className="stretched tile-name" onClick={nav("profile")}>{account.name}</a>
            <p className="tile-line">{account.handle ? `@${account.handle}` : <span className="muted">No handle yet</span>}</p>
            <p className="tile-line muted">{place || "Add your address"}</p>
            {fileError && <p className="error" role="alert">{fileError}</p>}
          </div>
        </article>

        <article className="card linkcard" aria-label="Today">
          <h2><a href="/transactions" className="stretched" onClick={nav("transactions")}>Today</a></h2>
          <p className="big xl">{money(data.balance)}</p>
          <p className="sub">{int(data.today.transactions)} transaction{data.today.transactions === 1 ? "" : "s"}</p>
          <hr className="tile-rule" />
          <h3 className="tile-label">Yesterday</h3>
          <p className="big md">{money(data.yesterday.net)}</p>
        </article>

        <article className="card linkcard" aria-label="Catalog">
          <h2><a href="/catalog" className="stretched" onClick={nav("catalog")}>Catalog</a></h2>
          <p className="big xl">{int(data.products)}</p>
          <p className="sub">{int(data.categories)} categor{data.categories === 1 ? "y" : "ies"}</p>
        </article>
      </div>

      <div className="grid">
        <article className="card linkcard" aria-label="Terminals"><h2><a href="/terminals" className="stretched" onClick={nav("terminals")}>Terminals</a></h2><p className="big">{int(data.terminals.count)}</p><p className="sub">{int(data.terminals.paired)} with an Orb paired</p></article>
        <article className="card linkcard" aria-label="Awaiting approval"><h2><a href="/refunds" className="stretched" onClick={nav("refunds")}>Awaiting Approval</a></h2><p className="big">{int(refundCount)}</p><p className="sub">{money(pendingTotal)} in pending refunds</p></article>
        <article className="card linkcard" aria-label="Staff"><h2><a href="/staff" className="stretched" onClick={nav("staff")}>Staff</a></h2><p className="big">{int(data.staff.count)}</p><p className="sub">{int(data.staff.writers)} can approve refunds</p></article>
        <article className="card linkcard" aria-label="Orders"><h2><a href="/orders" className="stretched" onClick={nav("orders")}>Orders</a></h2><p className="big">{int(data.open_orders)}</p><p className="sub">waiting to be paid</p></article>
      </div>

      {file && (
        <LogoCrop file={file} onClose={() => setFile(null)}
          onSave={async (jpeg) => { await api.uploadPhoto(jpeg); setFile(null); onChanged(); retry(); }} />
      )}
    </section>
  );
}
