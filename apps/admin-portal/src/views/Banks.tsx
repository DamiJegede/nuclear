import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, type Api, type BankRow } from "../api";
import { int } from "../format";
import { containPhoto } from "../image";
import { usePageTitle } from "../title";
import { usePaged } from "../usePaged";
import { ExpandRow } from "./ExpandRow";
import { Modal } from "./Modal";

const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString() : "Not yet");

/**
 * Every bank (routing number) our merchants have used: its name, logo, and whether it takes instant payouts. A new bank appears here as soon as
 * somebody adds it; the directory gives its name but no picture, so a logo is uploaded by hand. "Needs Logo" lists the banks in use without one.
 */
export function Banks({ api, canWrite, onError, onCount }: { api: Api; canWrite: boolean; onError: (e: unknown) => void; onCount?: (needsLogo: number) => void }) {
  usePageTitle("Banks");
  const [q, setQ] = useState("");
  const [term, setTerm] = useState("");
  const [needsLogo, setNeedsLogo] = useState(false);
  useEffect(() => { const t = setTimeout(() => setTerm(q.trim()), q ? 250 : 0); return () => clearTimeout(t); }, [q]);
  const [count, setCount] = useState<number | null>(null);
  const load = useCallback(async (cursor?: string) => {
    const r = await api.banks({ q: term || undefined, needsLogo, cursor });
    setCount(r.needs_logo); onCount?.(r.needs_logo);
    return { items: r.banks, next: r.next_cursor, total: r.total };
  }, [api, term, needsLogo, onCount]);
  const { rows, total, hasMore, more, failed, retry, loadMore } = usePaged<BankRow>(load, onError);

  const [rename, setRename] = useState<BankRow | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const picking = useRef<BankRow | null>(null);
  const input = useRef<HTMLInputElement>(null);

  async function chosen(file: File | undefined) {
    const bank = picking.current;
    if (!file || !bank) return;
    setNotice(null);
    if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) return setNotice("Choose a PNG, JPEG or WebP image.");
    try {
      const png = await containPhoto(file);
      if (png.size > 262_144) return setNotice("That logo is too detailed once resized (over 256 KB). Use a simpler image.");
      await api.uploadBankIcon(bank.id, png);
      setNotice(`Logo saved for ${bank.name ?? bank.routing_number}.`);
      retry();
    } catch (e) { onError(e); setNotice("Couldn't upload that logo. Try again."); }
  }
  async function saveName() {
    if (!rename) return;
    setBusy(true); setError(null);
    try { await api.renameBank(rename.id, name.trim()); setRename(null); retry(); }
    catch (e) { onError(e); setError(e instanceof ApiError && e.code === "invalid_request" ? "Enter a name (up to 120 characters)." : "Couldn't save the name. Try again."); }
    finally { setBusy(false); }
  }

  return (
    <section>
      <div className="head"><h1>Banks</h1></div>
      <p className="muted">Banks our merchants have added. The name and instant-payout check come from the bank directory; logos are uploaded here.</p>
      <div className="filter-box">
        <input type="search" aria-label="Filter banks" placeholder="Filter by name or routing number" value={q} onChange={(e) => setQ(e.target.value)} autoComplete="off" spellCheck={false} />
        <div className="chips" role="group" aria-label="Show">
          <button type="button" className={needsLogo ? "ghost" : "chip on"} aria-pressed={!needsLogo} onClick={() => setNeedsLogo(false)}>All</button>
          <button type="button" className={needsLogo ? "chip on" : "ghost"} aria-pressed={needsLogo} onClick={() => setNeedsLogo(true)}>Needs Logo{count !== null ? ` (${int(count)})` : ""}</button>
        </div>
      </div>
      {notice && <p role="status" className="hint">{notice}</p>}
      <input ref={input} type="file" accept="image/png,image/jpeg,image/webp" className="sr-only" aria-label="Choose a bank logo" onChange={(e) => { void chosen(e.target.files?.[0]); e.target.value = ""; }} />
      <div className="card flush">
        {failed && !rows ? <p className="error pad" role="alert">Couldn't load banks. <button className="link" onClick={retry}>Try Again</button></p>
          : !rows ? <p className="muted pad" role="status">Loading…</p>
          : rows.length === 0 ? <p className="muted pad">{needsLogo ? "Every bank in use has a logo." : term ? "No banks match that." : "No banks yet. They appear when a merchant adds a payout bank."}</p>
          : (
            <table>
              <thead><tr><th scope="col">Bank</th><th scope="col">Routing</th><th scope="col">Instant</th><th scope="col" className="num">Accounts</th><th scope="col">Checked</th></tr></thead>
              <tbody>
                {rows.map((b) => (
                  <ExpandRow key={b.id} cols={5} cells={<>
                    <th scope="row">
                      <span className="bank-cell">
                        {b.icon ? <img className="bank-icon" src={b.icon} alt="" /> : <span className="bank-glyph" aria-hidden="true">🏦</span>}
                        {b.name ?? <span className="muted">Unnamed</span>}
                        {!b.icon && b.accounts > 0 && <span className="pill pending">needs logo</span>}
                      </span>
                    </th>
                    <td><code>{b.routing_number}</code></td>
                    <td>{b.instant === null ? <span className="muted">Unknown</span> : b.instant ? `Yes${b.networks.length ? ` · ${b.networks.join(", ")}` : ""}` : "No"}</td>
                    <td className="num">{int(b.accounts)}</td>
                    <td className="when">{day(b.refreshed_at)}</td>
                  </>}>
                    <p className="tx-line">Bank ID: <span className="tx-id">{b.id}</span> • First seen {day(b.created_at)}</p>
                    <p className="row-actions">
                      {canWrite
                        ? <>
                            <button type="button" className="ghost" aria-label={`${b.icon ? "Replace" : "Upload"} logo for ${b.name ?? b.routing_number}`} onClick={() => { picking.current = b; input.current?.click(); }}>{b.icon ? "Replace Logo" : "Upload Logo"}</button>
                            <button type="button" className="ghost" aria-label={`Rename ${b.name ?? b.routing_number}`} onClick={() => { setRename(b); setName(b.name ?? ""); setError(null); }}>Rename</button>
                          </>
                        : <span className="muted">You can look but not change banks.</span>}
                    </p>
                  </ExpandRow>
                ))}
              </tbody>
            </table>
          )}
      </div>
      {rows && rows.length > 0 && (
        <p className="more">
          <span className="muted">Showing {int(rows.length)} of {int(total)}</span>
          {hasMore && <button type="button" className="ghost" disabled={more} onClick={() => void loadMore()}>{more ? "Loading…" : "Load More"}</button>}
        </p>
      )}
      {rename && (
        <Modal title="Rename Bank" onClose={() => setRename(null)} locked={busy}>
          <form className="modal-form" onSubmit={(e) => { e.preventDefault(); void saveName(); }}>
            <div className="fields"><label className="wide">Name<input value={name} maxLength={120} onChange={(e) => setName(e.target.value)} autoFocus /></label></div>
            {error && <p className="error" role="alert">{error}</p>}
            <div className="modal-actions">
              <button type="submit" disabled={busy || !name.trim()}>{busy ? "Saving…" : "Save Name"}</button>
              <button type="button" className="ghost" disabled={busy} onClick={() => setRename(null)}>Cancel</button>
            </div>
          </form>
        </Modal>
      )}
    </section>
  );
}
