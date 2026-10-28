import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, type Api, type InstitutionRow, type RoutingNumberRow } from "../api";
import { digitsOnly } from "../inputs";
import { int } from "../format";
import { containPhoto } from "../image";
import { usePageTitle } from "../title";
import { usePaged } from "../usePaged";
import { ExpandRow } from "./ExpandRow";
import { Modal } from "./Modal";

const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString() : "Not yet");

function useDebounced(q: string) {
  const [term, setTerm] = useState("");
  useEffect(() => { const t = setTimeout(() => setTerm(q.trim()), q ? 250 : 0); return () => clearTimeout(t); }, [q]);
  return term;
}

function Logo({ icon }: { icon: string | null }) {
  return icon ? <img className="bank-icon" src={icon} alt="" /> : <span className="bank-glyph" aria-hidden="true">🏦</span>;
}

function More({ shown, total, hasMore, more, loadMore }: { shown: number; total: number; hasMore: boolean; more: boolean; loadMore: () => Promise<void> }) {
  return (
    <p className="more">
      <span className="muted">Showing {int(shown)} of {int(total)}</span>
      {hasMore && <button type="button" className="ghost" disabled={more} onClick={() => void loadMore()}>{more ? "Loading…" : "Load More"}</button>}
    </p>
  );
}

/**
 * Banks: the institutions people know (Chase, Wells Fargo: one name and one logo, uploaded once) and the routing numbers we have seen, each linked to
 * an institution by name or by hand. The bank directory gives the number's name and instant-payment support but no pictures.
 */
export function Banks({ api, canWrite, onError, onCount }: { api: Api; canWrite: boolean; onError: (e: unknown) => void; onCount?: (attention: number) => void }) {
  usePageTitle("Banks");
  const [tab, setTab] = useState<"institutions" | "routing">("institutions");
  const [attn, setAttn] = useState({ needs_logo: 0, unlinked: 0 });
  const report = useCallback((a: { needs_logo: number; unlinked: number }) => { setAttn({ needs_logo: a.needs_logo, unlinked: a.unlinked }); onCount?.(a.needs_logo + a.unlinked); }, [onCount]);
  return (
    <section>
      <div className="head"><h1>Banks</h1></div>
      <div className="tabs" role="tablist" aria-label="Banks">
        <button type="button" role="tab" aria-selected={tab === "institutions"} className={tab === "institutions" ? "tab active" : "tab"} onClick={() => setTab("institutions")}>Institutions{attn.needs_logo > 0 ? <span className="badge">{attn.needs_logo}</span> : null}</button>
        <button type="button" role="tab" aria-selected={tab === "routing"} className={tab === "routing" ? "tab active" : "tab"} onClick={() => setTab("routing")}>Routing Numbers{attn.unlinked > 0 ? <span className="badge">{attn.unlinked}</span> : null}</button>
      </div>
      {tab === "institutions" ? <Institutions api={api} canWrite={canWrite} onError={onError} onAttention={report} /> : <RoutingNumbers api={api} canWrite={canWrite} onError={onError} onAttention={report} />}
    </section>
  );
}

function Institutions({ api, canWrite, onError, onAttention }: { api: Api; canWrite: boolean; onError: (e: unknown) => void; onAttention: (a: { needs_logo: number; unlinked: number }) => void }) {
  const [q, setQ] = useState("");
  const term = useDebounced(q);
  const [needsLogo, setNeedsLogo] = useState(false);
  const [count, setCount] = useState<number | null>(null);
  const load = useCallback(async (cursor?: string) => {
    const r = await api.institutions({ q: term || undefined, needsLogo, cursor });
    setCount(r.needs_logo); onAttention(r);
    return { items: r.institutions, next: r.next_cursor, total: r.total };
  }, [api, term, needsLogo, onAttention]);
  const { rows, total, hasMore, more, failed, retry, loadMore } = usePaged<InstitutionRow>(load, onError);

  const [edit, setEdit] = useState<InstitutionRow | "new" | null>(null);
  const [name, setName] = useState("");
  const [domain, setDomain] = useState("");
  const [aliases, setAliases] = useState("");
  const [hosts, setHosts] = useState<{ id: string; name: string }[]>([]);
  const [hostQ, setHostQ] = useState("");
  const [hostHits, setHostHits] = useState<{ id: string; name: string }[]>([]);
  const hostTerm = useDebounced(hostQ);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const picking = useRef<InstitutionRow | null>(null);
  const input = useRef<HTMLInputElement>(null);

  function open(i: InstitutionRow | "new") {
    setEdit(i); setError(null); setHostQ(""); setHostHits([]);
    setName(i === "new" ? "" : i.name); setDomain(i === "new" ? "" : i.domain ?? ""); setAliases(i === "new" ? "" : i.aliases.join(", ")); setHosts(i === "new" ? [] : i.hosts);
  }
  // Search for a partner bank to add to "Runs on": other institutions that are not themselves brands, not already chosen.
  useEffect(() => {
    if (!edit || !hostTerm) { setHostHits([]); return; }
    let live = true;
    api.institutions({ q: hostTerm, limit: 6 }).then((r) => { if (live) setHostHits(r.institutions.filter((x) => x.hosts.length === 0 && (edit === "new" || x.id !== edit.id) && !hosts.some((h) => h.id === x.id)).map((x) => ({ id: x.id, name: x.name }))); }).catch(() => { if (live) setHostHits([]); });
    return () => { live = false; };
  }, [api, edit, hostTerm, hosts]);
  async function save() {
    if (!edit) return;
    setBusy(true); setError(null);
    const body = { name: name.trim(), domain: domain.trim() || null, aliases: aliases.split(",").map((a) => a.trim()).filter(Boolean), hosts: hosts.map((h) => h.id) };
    try {
      const r = edit === "new" ? await api.createInstitution(body) : await api.updateInstitution(edit.id, body);
      setEdit(null); retry();
      if (r.linked > 0) setNotice(`${r.linked} routing number${r.linked === 1 ? " was" : "s were"} linked by name.`);
    } catch (e) {
      onError(e);
      setError(e instanceof ApiError && e.code === "alias_taken" ? "That name or alias already belongs to another institution." : e instanceof ApiError && e.code === "host_is_brand" ? "A partner bank can't itself be a brand." : e instanceof ApiError && e.code === "has_brands" ? "Other brands run on this institution, so it can't be a brand." : e instanceof ApiError && e.code === "institution_exists" ? "An institution with that name already exists." : e instanceof ApiError && e.code === "invalid_request" ? "Check the name, the website (like chase.com) and the aliases." : "Couldn't save. Try again.");
    } finally { setBusy(false); }
  }
  async function chosen(file: File | undefined) {
    const inst = picking.current;
    if (!file || !inst) return;
    setNotice(null);
    if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) return setNotice("Choose a PNG, JPEG or WebP image.");
    try {
      const png = await containPhoto(file);
      if (png.size > 262_144) return setNotice("That logo is too detailed once resized (over 256 KB). Use a simpler image.");
      await api.uploadInstitutionIcon(inst.id, png);
      setNotice(`Logo saved for ${inst.name}.`);
      retry();
    } catch (e) { onError(e); setNotice("Couldn't upload that logo. Try again."); }
  }

  return (
    <>
      <p className="muted">One name and one logo per institution, shown for all its routing numbers. "Aliases" are the names the bank directory uses for it, so new routing numbers link themselves.</p>
      <div className="filter-box">
        <input type="search" aria-label="Filter institutions" placeholder="Filter by name or website" value={q} onChange={(e) => setQ(e.target.value)} autoComplete="off" spellCheck={false} />
        <div className="chips" role="group" aria-label="Show">
          <button type="button" className={needsLogo ? "ghost" : "chip on"} aria-pressed={!needsLogo} onClick={() => setNeedsLogo(false)}>All</button>
          <button type="button" className={needsLogo ? "chip on" : "ghost"} aria-pressed={needsLogo} onClick={() => setNeedsLogo(true)}>Needs Logo{count !== null ? ` (${int(count)})` : ""}</button>
        </div>
        {canWrite && <button type="button" onClick={() => open("new")}>Add Institution</button>}
      </div>
      {notice && <p role="status" className="hint">{notice}</p>}
      <input ref={input} type="file" accept="image/png,image/jpeg,image/webp" className="sr-only" aria-label="Choose a logo" onChange={(e) => { void chosen(e.target.files?.[0]); e.target.value = ""; }} />
      <div className="card flush">
        {failed && !rows ? <p className="error pad" role="alert">Couldn't load institutions. <button className="link" onClick={retry}>Try Again</button></p>
          : !rows ? <p className="muted pad" role="status">Loading…</p>
          : rows.length === 0 ? <p className="muted pad">{needsLogo ? "Every institution in use has a logo." : term ? "No institutions match that." : "No institutions yet."}</p>
          : (
            <table>
              <thead><tr><th scope="col">Institution</th><th scope="col">Website</th><th scope="col" className="num">Routing numbers</th><th scope="col" className="num">Accounts</th></tr></thead>
              <tbody>
                {rows.map((i) => (
                  <ExpandRow key={i.id} cols={4} cells={<>
                    <th scope="row"><span className="bank-cell"><Logo icon={i.icon} />{i.name}{!i.icon && i.accounts > 0 && <span className="pill pending">needs logo</span>}</span></th>
                    <td>{i.domain ?? <span className="muted">—</span>}</td>
                    <td className="num">{int(i.routing_numbers)}</td>
                    <td className="num">{int(i.accounts)}</td>
                  </>}>
                    <p className="tx-line">Institution ID: <span className="tx-id">{i.id}</span> • Aliases: {i.aliases.length ? i.aliases.join(", ") : "none"}{i.hosts.length ? <> • Runs on: {i.hosts.map((h) => h.name).join(", ")}</> : null}{i.brands ? <> • Brands: {int(i.brands)}</> : null}</p>
                    <p className="row-actions">
                      {canWrite
                        ? <>
                            <button type="button" className="ghost" aria-label={`${i.icon ? "Replace" : "Upload"} logo for ${i.name}`} onClick={() => { picking.current = i; input.current?.click(); }}>{i.icon ? "Replace Logo" : "Upload Logo"}</button>
                            <button type="button" className="ghost" aria-label={`Edit ${i.name}`} onClick={() => open(i)}>Edit</button>
                          </>
                        : <span className="muted">You can look but not change institutions.</span>}
                    </p>
                  </ExpandRow>
                ))}
              </tbody>
            </table>
          )}
      </div>
      {rows && rows.length > 0 && <More shown={rows.length} total={total} hasMore={hasMore} more={more} loadMore={loadMore} />}
      {edit && (
        <Modal title={edit === "new" ? "Add Institution" : "Edit Institution"} onClose={() => setEdit(null)} locked={busy}>
          <form className="modal-form" onSubmit={(e) => { e.preventDefault(); void save(); }}>
            <div className="fields">
              <label className="wide">Name<input value={name} maxLength={120} onChange={(e) => setName(e.target.value)} autoFocus /></label>
              <label className="wide">Website<input value={domain} placeholder="chase.com" onChange={(e) => setDomain(e.target.value)} autoComplete="off" /></label>
              <label className="wide">Aliases<input value={aliases} placeholder="jpmorgan chase, chase bank" onChange={(e) => setAliases(e.target.value)} autoComplete="off" /></label>
            </div>
            <p className="hint">Aliases are matched as whole words inside the name the bank directory gives a routing number. Separate them with commas. A name or alias belongs to one institution only.</p>
            <label className="wide">Runs on (for a brand such as Mercury)
              <input value={hostQ} placeholder="Search a partner bank, like Column" onChange={(e) => setHostQ(e.target.value)} autoComplete="off" />
            </label>
            {hostHits.length > 0 && <p className="chips">{hostHits.map((h) => <button key={h.id} type="button" className="ghost" onClick={() => { setHosts((x) => [...x, h]); setHostQ(""); }}>Add {h.name}</button>)}</p>}
            {hosts.length > 0 && <p className="chips">{hosts.map((h) => <button key={h.id} type="button" className="chip on" aria-label={`Remove ${h.name}`} onClick={() => setHosts((x) => x.filter((y) => y.id !== h.id))}>{h.name} ×</button>)}</p>}
            <p className="hint">A brand that runs on partner banks is never matched from a directory name: the merchant picks it when their routing number belongs to one of these banks, so it also isn't matched by its own aliases.</p>
            {error && <p className="error" role="alert">{error}</p>}
            <div className="modal-actions">
              <button type="submit" disabled={busy || !name.trim()}>{busy ? "Saving…" : "Save Institution"}</button>
              <button type="button" className="ghost" disabled={busy} onClick={() => setEdit(null)}>Cancel</button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}

function RoutingNumbers({ api, canWrite, onError, onAttention }: { api: Api; canWrite: boolean; onError: (e: unknown) => void; onAttention: (a: { needs_logo: number; unlinked: number }) => void }) {
  const [q, setQ] = useState("");
  const term = useDebounced(q);
  const [unlinked, setUnlinked] = useState(false);
  const [count, setCount] = useState<number | null>(null);
  const load = useCallback(async (cursor?: string) => {
    const r = await api.routingNumbers({ q: term || undefined, unlinked, cursor });
    setCount(r.unlinked); onAttention(r);
    return { items: r.routing_numbers, next: r.next_cursor, total: r.total };
  }, [api, term, unlinked, onAttention]);
  const { rows, total, hasMore, more, failed, retry, loadMore } = usePaged<RoutingNumberRow>(load, onError);

  const [linking, setLinking] = useState<RoutingNumberRow | null>(null);
  const [adding, setAdding] = useState(false);
  const [options, setOptions] = useState<InstitutionRow[]>([]);
  const [filter, setFilter] = useState("");
  const [choice, setChoice] = useState("");
  const [number, setNumber] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!linking && !adding) return;
    let alive = true;
    api.institutions({ q: filter || undefined, limit: 100 }).then((r) => { if (alive) setOptions(r.institutions); }).catch(onError);
    return () => { alive = false; };
  }, [api, linking, adding, filter, onError]);

  async function link(id: string | null, row: RoutingNumberRow) {
    setBusy(true); setError(null);
    try { await api.linkRoutingNumber(row.id, id); setLinking(null); retry(); }
    catch (e) { onError(e); setError("Couldn't change the link. Try again."); }
    finally { setBusy(false); }
  }
  async function add() {
    setBusy(true); setError(null);
    try { await api.addRoutingNumber({ routing_number: number, institution_id: choice || null }); setAdding(false); setNumber(""); setChoice(""); retry(); }
    catch (e) {
      onError(e);
      setError(e instanceof ApiError && e.code === "invalid_routing_number" ? "That routing number isn't valid." : e instanceof ApiError && e.code === "routing_number_exists" ? "That routing number is already here." : "Couldn't add it. Try again.");
    } finally { setBusy(false); }
  }

  return (
    <>
      <p className="muted">Every routing number our merchants have used. The bank directory names it and says whether it takes instant payments; link it to its institution so it shows that institution's name and logo.</p>
      <div className="filter-box">
        <input type="search" aria-label="Filter routing numbers" placeholder="Filter by routing number or name" value={q} onChange={(e) => setQ(e.target.value)} autoComplete="off" spellCheck={false} />
        <div className="chips" role="group" aria-label="Show">
          <button type="button" className={unlinked ? "ghost" : "chip on"} aria-pressed={!unlinked} onClick={() => setUnlinked(false)}>All</button>
          <button type="button" className={unlinked ? "chip on" : "ghost"} aria-pressed={unlinked} onClick={() => setUnlinked(true)}>Not Linked{count !== null ? ` (${int(count)})` : ""}</button>
        </div>
        {canWrite && <button type="button" onClick={() => { setAdding(true); setError(null); setFilter(""); }}>Add Routing Number</button>}
      </div>
      <div className="card flush">
        {failed && !rows ? <p className="error pad" role="alert">Couldn't load routing numbers. <button className="link" onClick={retry}>Try Again</button></p>
          : !rows ? <p className="muted pad" role="status">Loading…</p>
          : rows.length === 0 ? <p className="muted pad">{unlinked ? "Every routing number in use belongs to an institution." : term ? "No routing numbers match that." : "No routing numbers yet. They appear when a merchant adds a payout bank."}</p>
          : (
            <table>
              <thead><tr><th scope="col">Routing</th><th scope="col">Institution</th><th scope="col">Directory name</th><th scope="col">Instant</th><th scope="col" className="num">Accounts</th><th scope="col">Checked</th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <ExpandRow key={r.id} cols={6} cells={<>
                    <th scope="row"><code>{r.routing_number}</code></th>
                    <td>{r.institution ? <span className="bank-cell"><Logo icon={r.icon} />{r.institution}</span> : <span className="pill pending">not linked</span>}</td>
                    <td>{r.directory_name ?? <span className="muted">—</span>}</td>
                    <td>{r.instant === null ? <span className="muted">Unknown</span> : r.instant ? `Yes${r.networks.length ? ` · ${r.networks.join(", ")}` : ""}` : "No"}</td>
                    <td className="num">{int(r.accounts)}</td>
                    <td className="when">{day(r.refreshed_at)}</td>
                  </>}>
                    <p className="tx-line">Routing number ID: <span className="tx-id">{r.id}</span> • First seen {day(r.created_at)}</p>
                    <p className="row-actions">
                      {canWrite
                        ? <>
                            <button type="button" className="ghost" aria-label={`Link ${r.routing_number} to an institution`} onClick={() => { setLinking(r); setChoice(r.institution_id ?? ""); setFilter(""); setError(null); }}>{r.institution ? "Change Institution" : "Link to Institution"}</button>
                            {r.institution_id && <button type="button" className="ghost" aria-label={`Unlink ${r.routing_number}`} disabled={busy} onClick={() => void link(null, r)}>Unlink</button>}
                          </>
                        : <span className="muted">You can look but not change routing numbers.</span>}
                    </p>
                  </ExpandRow>
                ))}
              </tbody>
            </table>
          )}
      </div>
      {rows && rows.length > 0 && <More shown={rows.length} total={total} hasMore={hasMore} more={more} loadMore={loadMore} />}
      {linking && (
        <Modal title="Link To Institution" onClose={() => setLinking(null)} locked={busy}>
          <p>Routing number <code>{linking.routing_number}</code>{linking.directory_name ? <> (the directory calls it <strong>{linking.directory_name}</strong>)</> : null}.</p>
          <label className="wide">Find an institution<input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Type a name" autoFocus /></label>
          <label className="wide">Institution
            <select value={choice} onChange={(e) => setChoice(e.target.value)}>
              <option value="">Choose…</option>
              {options.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
            </select>
          </label>
          {error && <p className="error" role="alert">{error}</p>}
          <div className="modal-actions">
            <button type="button" disabled={busy || !choice} onClick={() => void link(choice, linking)}>{busy ? "Saving…" : "Save Link"}</button>
            <button type="button" className="ghost" disabled={busy} onClick={() => setLinking(null)}>Cancel</button>
          </div>
        </Modal>
      )}
      {adding && (
        <Modal title="Add Routing Number" onClose={() => setAdding(false)} locked={busy}>
          <form className="modal-form" onSubmit={(e) => { e.preventDefault(); void add(); }}>
            <div className="fields">
              <label className="wide">Routing number<input inputMode="numeric" maxLength={9} autoComplete="off" value={number} onChange={(e) => setNumber(digitsOnly(e.target.value))} autoFocus /></label>
              <label className="wide">Institution (optional)
                <select value={choice} onChange={(e) => setChoice(e.target.value)}>
                  <option value="">None yet</option>
                  {options.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                </select>
              </label>
            </div>
            {error && <p className="error" role="alert">{error}</p>}
            <div className="modal-actions">
              <button type="submit" disabled={busy || number.length !== 9}>{busy ? "Adding…" : "Add Routing Number"}</button>
              <button type="button" className="ghost" disabled={busy} onClick={() => setAdding(false)}>Cancel</button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}
