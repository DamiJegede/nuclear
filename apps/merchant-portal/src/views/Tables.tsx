import { useCallback, useEffect, useState } from "react";
import QRCode from "qrcode";
import { RefreshButton } from "./RefreshButton";
import { RowMenu } from "./RowMenu";
import { CopyButton } from "./CopyButton";
import { Modal } from "./Modal";
import { type Api, type VenueTable } from "../api";
import { usePageTitle } from "../title";
import { useList } from "../useList";

/** Tables: each has a code printed as a QR code and written to an NFC cube; scanning opens the menu and the table's tab (docs/TABS.md). */
export function Tables({ api, onError }: { api: Api; onError: (e: unknown) => void }) {
  usePageTitle("Tables");
  const { data, failed, retry } = useList<VenueTable[]>(useCallback(() => api.tables(), [api]), onError, "tables");
  const [form, setForm] = useState<VenueTable | "new" | null>(null);
  const [code, setCode] = useState<VenueTable | null>(null);
  const [action, setAction] = useState<{ t: VenueTable; kind: "rotate" | "delete" } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirm() {
    if (!action) return;
    setBusy(true); setError(null);
    try {
      if (action.kind === "rotate") setCode(await api.rotateTableCode(action.t.id)); else await api.deleteTable(action.t.id);
      setAction(null); retry();
    } catch (e) { onError(e); setError((e as { code?: string }).code === "table_in_use" ? "This table has history, so it can't be deleted. Deactivate it instead." : "Couldn't do that. Try again."); }
    finally { setBusy(false); }
  }

  return (
    <section>
      <div className="head"><h1>Tables</h1><div className="head-actions"><button type="button" onClick={() => setForm("new")}>Add Table</button><RefreshButton onClick={retry} /></div></div>
      <div className="card flush">
        {failed && !data ? <p className="error pad" role="alert">Couldn't load tables. <button className="link" onClick={retry}>Try Again</button></p>
          : !data ? <p className="muted pad" role="status">Loading…</p>
          : data.length === 0 ? <p className="muted pad">No tables yet. Add one, then print its QR code or write its link to an NFC cube.</p>
          : (
            <table>
              <thead><tr><th scope="col">Table</th><th scope="col">Status</th><th scope="col">Tab</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
              <tbody>
                {data.map((t) => (
                  <tr key={t.id}>
                    <th scope="row">{t.name}</th>
                    <td><span className={`pill ${t.active ? "available" : "pending"}`}>{t.active ? "active" : "inactive"}</span></td>
                    <td>{t.open_tab_id ? <span className="pill pending">open</span> : <span className="muted">None</span>}</td>
                    <td className="actions">
                      <RowMenu label={`Actions for ${t.name}`} items={[
                        { label: "QR Code and Link", onSelect: () => setCode(t) },
                        { label: "Edit", onSelect: () => setForm(t) },
                        { label: t.active ? "Deactivate" : "Activate", onSelect: () => void api.updateTable(t.id, { active: !t.active }).then(retry).catch(onError) },
                        { label: "New Code", onSelect: () => { setError(null); setAction({ t, kind: "rotate" }); } },
                        { label: "Delete", danger: true, onSelect: () => { setError(null); setAction({ t, kind: "delete" }); } },
                      ]} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
      </div>
      {form && <TableForm api={api} table={form === "new" ? undefined : form} onClose={() => setForm(null)} onError={onError} onSaved={() => { setForm(null); retry(); }} />}
      {code && <CodeWindow table={code} onClose={() => setCode(null)} />}
      {action && (
        <Modal title={action.kind === "rotate" ? "New Code" : "Delete Table"} onClose={() => setAction(null)} locked={busy}>
          {action.kind === "rotate" && <p>Give <strong>{action.t.name}</strong> a new code? The printed QR code and the NFC cube stop working until you replace them.</p>}
          {action.kind === "delete" && <p>Delete <strong>{action.t.name}</strong>? A table that has had a tab can't be deleted; deactivate it instead.</p>}
          {error && <p className="error" role="alert">{error}</p>}
          <div className="modal-actions">
            <button type="button" className="ghost" onClick={() => setAction(null)} disabled={busy}>Cancel</button>
            <button type="button" className={action.kind === "delete" ? "danger" : undefined} onClick={() => void confirm()} disabled={busy}>{action.kind === "rotate" ? "New Code" : "Delete Table"}</button>
          </div>
        </Modal>
      )}
    </section>
  );
}

function TableForm({ api, table, onClose, onSaved, onError }: { api: Api; table?: VenueTable; onClose: () => void; onSaved: () => void; onError: (e: unknown) => void }) {
  const [name, setName] = useState(table?.name ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function save() {
    setBusy(true); setError(null);
    try { if (table) await api.updateTable(table.id, { name: name.trim() }); else await api.createTable({ name: name.trim() }); onSaved(); }
    catch (e) { onError(e); setError("Couldn't save the table. Try again."); }
    finally { setBusy(false); }
  }
  return (
    <Modal title={table ? "Edit Table" : "Add Table"} onClose={onClose} locked={busy}>
      <form onSubmit={(e) => { e.preventDefault(); if (name.trim()) void save(); }}>
        <label>Name<input value={name} maxLength={60} onChange={(e) => setName(e.target.value)} placeholder="Table 4" autoFocus /></label>
        {error && <p className="error" role="alert">{error}</p>}
        <div className="modal-actions"><button type="button" className="ghost" onClick={onClose} disabled={busy}>Cancel</button><button type="submit" disabled={busy || !name.trim()}>Save</button></div>
      </form>
    </Modal>
  );
}

/** The table's link as a QR code to print (and the same link to write to an NFC cube: a plain link, never a payment credential). */
function CodeWindow({ table, onClose }: { table: VenueTable; onClose: () => void }) {
  const [png, setPng] = useState<string | null>(null);
  useEffect(() => { void QRCode.toDataURL(table.link, { width: 512, margin: 2 }).then(setPng).catch(() => setPng(null)); }, [table.link]);
  return (
    <Modal title={`${table.name}: QR Code and Link`} onClose={onClose}>
      {png ? <img src={png} alt={`QR code for ${table.name}`} width={256} height={256} style={{ display: "block", margin: "0 auto" }} /> : <p className="muted" role="status">Drawing the code…</p>}
      <p className="note muted">Scanning opens the menu and the table's tab. Write the same link to an NFC cube (a plain link tag, never a band).</p>
      <p><code>{table.link}</code></p>
      <div className="modal-actions">
        <CopyButton value={table.link} label="Copy Link" />
        {png && <a className="button ghost" href={png} download={`${table.name.replace(/\W+/g, "-")}-qr.png`}>Download QR Code</a>}
        <button type="button" onClick={onClose}>Done</button>
      </div>
    </Modal>
  );
}
