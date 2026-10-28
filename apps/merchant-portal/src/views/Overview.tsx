import { useCallback, useRef, useState } from "react";
import { Modal } from "./Modal";
import { RefreshButton } from "./RefreshButton";
import { ApiError, type Account, type Api, type CloseOutResult, type Overview as OverviewData } from "../api";
import { int, money } from "../format";
import { usePageTitle } from "../title";
import { useList } from "../useList";
import { Avatar } from "./Avatar";
import { PhotoCrop } from "./PhotoCrop";

/** The business at a glance: three large cards (profile, today, catalog), then terminals, approvals, staff and orders. */
export function Overview({ api, account, onChanged, onError, go }: { api: Api; account: Account; onChanged: () => void; onError: (e: unknown) => void; go: (page: string) => void }) {
  usePageTitle("Overview");
  // One request for the whole page (it used to be ten, each repeating the sign-in checks).
  const { data, failed, retry } = useList<OverviewData>(useCallback(() => api.overview(), [api]), onError, "overview");
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [closing, setClosing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [closeError, setCloseError] = useState<string | null>(null);
  const [closed, setClosed] = useState<CloseOutResult["settlement"] | null>(null);

  async function closeOut() {
    setBusy(true); setCloseError(null);
    try { const r = await api.closeOut(); setClosing(false); setClosed(r); onChanged(); retry(); }
    catch (err) {
      onError(err);
      const code = err instanceof ApiError ? err.code : "";
      setCloseError(code === "already_closed_out" ? "You've already closed out today. Anything sold since is paid out with tomorrow's close-out."
        : code === "nothing_to_close_out" ? "There's nothing to pay out right now."
        : code === "owes" ? "Your balance is below zero after refunds, so there's nothing to pay out. It will be settled with your next sales."
        : code === "no_bank" ? "Add a payout bank first."
        : code === "payouts_unavailable" ? "Payouts aren't available right now. Try again later."
        : code === "rate_limited" ? "Too many tries. Wait a little and try again."
        : "Couldn't close out. Try again.");
    } finally { setBusy(false); }
  }

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
      <div className="head"><h1>Overview</h1><div className="head-actions"><RefreshButton onClick={retry} /></div></div>
      {refundCount > 0 && (
        <div className="banner bad" role="status">
          {int(refundCount)} refund{refundCount === 1 ? "" : "s"} ({money(pendingTotal)}) waiting for your approval. <button type="button" className="link" onClick={() => go("refunds")}>Review Refunds</button>
        </div>
      )}

      <div className="grid three">
        <article className="card linkcard profile-tile" aria-label="Profile">
          <button type="button" className="photo-btn" aria-label="Replace profile picture" onClick={() => input.current?.click()}>
            <Avatar name={account.name} photo={account.photo} />
            <span className="photo-hint" aria-hidden>{account.photo ? "Replace" : "Add Picture"}</span>
          </button>
          <input ref={input} type="file" className="sr-only" aria-label="Profile picture" accept="image/png,image/jpeg,image/webp" onChange={(e) => { pick(e.target.files?.[0]); e.target.value = ""; }} />
          <div className="tile-text">
            <a href="/profile" className="stretched tile-name" onClick={nav("profile")}>{account.name}</a>
            <p className="tile-line">{account.handle ? `@${account.handle}` : <span className="dim">No handle yet</span>}</p>
            <p className="tile-line muted">{place || "Add your address"}</p>
            {fileError && <p className="error" role="alert">{fileError}</p>}
          </div>
        </article>

        <article className="card linkcard" aria-label="Today">
          <h2><a href="/transactions" className="stretched" onClick={nav("transactions")}>Today</a></h2>
          <p className="big xl">{money(data.balance)}</p>
          <p className="sub">{int(data.today.transactions)} transaction{data.today.transactions === 1 ? "" : "s"}{data.today.closed_out_at ? ` since you closed out at ${new Date(data.today.closed_out_at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : ""}</p>
          <hr className="tile-rule" />
          <h3 className="tile-label">Yesterday</h3>
          <p className="big md">{money(data.yesterday.net)}</p>
          {data.payout_bank && (
            <div className="tile-actions">
              {data.today.closed_out_at
                ? <p className="sub">Closed out today. Sales since then are paid out tomorrow.</p>
                : <button type="button" className="ghost" disabled={data.balance <= 0} onClick={() => { setCloseError(null); setClosing(true); }}>Close Out</button>}
            </div>
          )}
        </article>

        <article className="card linkcard" aria-label="Catalog">
          <h2><a href="/catalog" className="stretched" onClick={nav("catalog")}>Catalog</a></h2>
          <p className="big xl">{int(data.products)}</p>
          <p className="sub">{int(data.categories)} categor{data.categories === 1 ? "y" : "ies"}</p>
          <hr className="tile-rule" />
          <h3 className="tile-label">Today's Best Seller</h3>
          <p className="big md">{data.best_seller ? data.best_seller.name : <span className="dim">No sales yet</span>}</p>
        </article>
      </div>

      <div className="grid">
        <article className="card linkcard" aria-label="Terminals"><h2><a href="/terminals" className="stretched" onClick={nav("terminals")}>Terminals</a></h2><p className="big">{int(data.terminals.count)}</p><p className="sub">{int(data.terminals.paired)} with an Orb paired</p></article>
        <article className="card linkcard" aria-label="Awaiting approval"><h2><a href="/refunds" className="stretched" onClick={nav("refunds")}>Awaiting Approval</a></h2><p className="big">{int(refundCount)}</p><p className="sub">{money(pendingTotal)} in pending refunds</p></article>
        <article className="card linkcard" aria-label="Staff"><h2><a href="/staff" className="stretched" onClick={nav("staff")}>Staff</a></h2><p className="big">{int(data.staff.count)}</p><p className="sub">{int(data.staff.writers)} can approve refunds</p></article>
        <article className="card linkcard" aria-label="Orders"><h2><a href="/orders" className="stretched" onClick={nav("orders")}>Orders</a></h2><p className="big">{int(data.open_orders)}</p><p className="sub">waiting to be paid</p></article>
      </div>

      {closing && data.payout_bank && (
        <Modal title="Close Out" onClose={() => setClosing(false)} locked={busy}>
          <p>Send <strong>{money(data.balance)}</strong> to {data.payout_bank.institution?.name ?? "your bank"} •••• {data.payout_bank.last4} now.</p>
          <p className="muted">{data.payout_bank.institution?.instant === true ? "Your bank takes instant payouts, so it should arrive within seconds." : "It goes by same-day ACH: before 4 PM Eastern on a business day it arrives today, otherwise the next business day."} You can close out once a day; anything you sell afterwards is paid out with tomorrow's close-out.</p>
          {closeError && <p className="error" role="alert">{closeError}</p>}
          <div className="modal-actions">
            <button type="button" disabled={busy} onClick={() => void closeOut()}>{busy ? "Closing out…" : "Confirm Close Out"}</button>
            <button type="button" className="ghost" disabled={busy} onClick={() => setClosing(false)}>Cancel</button>
          </div>
        </Modal>
      )}
      {closed && (
        <Modal title="Day Closed" onClose={() => setClosed(null)}>
          <p><strong>{money(closed.amount)}</strong> {closed.status === "completed" ? "has been sent" : "is on its way"} to your bank.</p>
          <p className="muted">{closed.arrival === "instant" ? "Instant payouts arrive within seconds." : closed.arrival === "today" ? "It should arrive today." : "It should arrive the next business day."}</p>
          <div className="modal-actions"><button type="button" onClick={() => setClosed(null)}>Done</button></div>
        </Modal>
      )}
      {file && (
        <PhotoCrop file={file} onClose={() => setFile(null)}
          onSave={async (jpeg) => { await api.uploadPhoto(jpeg); setFile(null); onChanged(); retry(); }} />
      )}
    </section>
  );
}
