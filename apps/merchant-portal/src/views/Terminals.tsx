import { useCallback, useState } from "react";
import { RefreshButton } from "./RefreshButton";
import { ApiError, type Api, type Terminal } from "../api";
import { usePageTitle } from "../title";
import { useList, when } from "../useList";
import { Modal } from "./Modal";
import { SecretPanel } from "./Secret";

type Issued = { terminal: string; token: string; expires: string };
const tokenFile = (t: Issued) => `Nuclear Business terminal session\nTerminal: ${t.terminal}\nSession token: ${t.token}\nExpires: ${t.expires}\n\nKeep this file private. The token cannot be shown again; issuing a new one signs this terminal out.\n`;

/** Terminals: create, rename, refund permission, sign a terminal in (new session token) or out, and pair or unpair its Orb. */
export function Terminals({ api, onError }: { api: Api; onError: (e: unknown) => void }) {
  usePageTitle("Terminals");
  const { data, failed, retry } = useList<Terminal[]>(useCallback(() => api.terminals(), [api]), onError, "terminals");
  const [form, setForm] = useState<Terminal | "new" | null>(null);
  const [action, setAction] = useState<{ t: Terminal; kind: "session" | "revoke" | "unpair" } | null>(null);
  const [orbFor, setOrbFor] = useState<Terminal | null>(null);
  const [issued, setIssued] = useState<Issued | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirm() {
    if (!action) return;
    setBusy(true); setError(null);
    try {
      if (action.kind === "session") {
        const s = await api.terminalSession(action.t.id);
        setIssued({ terminal: action.t.name, token: s.session_token, expires: s.session_expires_at });
      } else if (action.kind === "revoke") await api.revokeTerminal(action.t.id);
      else await api.unpairOrb(action.t.id);
      setAction(null); retry();
    } catch (e) { onError(e); setError("Couldn't do that. Try again."); }
    finally { setBusy(false); }
  }

  return (
    <section>
      <div className="head"><h1>Terminals</h1><div className="head-actions"><button type="button" onClick={() => setForm("new")}>Add Terminal</button><RefreshButton onClick={retry} /></div></div>
      <div className="card flush">
        {failed && !data ? <p className="error pad" role="alert">Couldn't load terminals. <button className="link" onClick={retry}>Try Again</button></p>
          : !data ? <p className="muted pad" role="status">Loading…</p>
          : data.length === 0 ? <p className="muted pad">No terminals yet. Add one, then sign it in on the device.</p>
          : (
            <table>
              <thead><tr><th scope="col">Terminal</th><th scope="col">Refunds</th><th scope="col">Orb</th><th scope="col">Added</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
              <tbody>
                {data.map((t) => (
                  <tr key={t.id}>
                    <th scope="row">{t.name}</th>
                    <td><span className={`pill ${t.allow_refunds ? "available" : "pending"}`}>{t.allow_refunds ? "allowed" : "needs approval"}</span></td>
                    <td>{t.orb ? <>{t.orb.model} <span className="muted note">{t.orb.uid} · v{t.orb.software}</span></> : <span className="muted">None paired</span>}</td>
                    <td className="when">{when(t.created_at)}</td>
                    <td className="actions row-actions">
                      <button type="button" className="ghost" onClick={() => setForm(t)}>Edit</button>
                      <button type="button" className="ghost" onClick={() => (t.orb ? (setError(null), setAction({ t, kind: "unpair" })) : setOrbFor(t))}>{t.orb ? "Unpair Orb" : "Pair Orb"}</button>
                      <button type="button" className="ghost" onClick={() => { setError(null); setAction({ t, kind: "session" }); }}>New Session</button>
                      <button type="button" className="ghost" onClick={() => { setError(null); setAction({ t, kind: "revoke" }); }}>Sign Out</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
      </div>

      {form && <TerminalForm api={api} terminal={form === "new" ? undefined : form} onClose={() => setForm(null)} onError={onError}
        onSaved={(token) => { setForm(null); retry(); if (token) setIssued(token); }} />}
      {orbFor && <PairOrb api={api} terminal={orbFor} onClose={() => setOrbFor(null)} onError={onError} onDone={() => { setOrbFor(null); retry(); }} />}

      {action && !issued && (
        <Modal title={action.kind === "session" ? "New Terminal Session" : action.kind === "revoke" ? "Sign Terminal Out" : "Unpair Orb"} onClose={() => setAction(null)} locked={busy}>
          {action.kind === "session" && <p>Create a new session for <strong>{action.t.name}</strong>? The current session stops working straight away and you get a new token to enter on the device.</p>}
          {action.kind === "revoke" && <p>Sign <strong>{action.t.name}</strong> out? It can't take payments until you create a new session for it.</p>}
          {action.kind === "unpair" && <p>Unpair the Orb from <strong>{action.t.name}</strong>? The Orb stays yours; you can pair it again or release it.</p>}
          {error && <p className="error" role="alert">{error}</p>}
          <div className="modal-actions">
            <button type="button" disabled={busy} onClick={() => void confirm()}>{busy ? "Working…" : "Confirm"}</button>
            <button type="button" className="ghost" disabled={busy} onClick={() => setAction(null)}>Cancel</button>
          </div>
        </Modal>
      )}

      {issued && (
        <Modal title="Terminal Session Token" onClose={() => undefined} locked>
          <p>Enter this token on <strong>{issued.terminal}</strong>. It expires {when(issued.expires)}.</p>
          <SecretPanel title="Session Token" value={issued.token} filename={`nuclear-terminal-${issued.terminal.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.txt`} text={tokenFile(issued)} onDone={() => { setIssued(null); setAction(null); }} />
        </Modal>
      )}
    </section>
  );
}

function TerminalForm({ api, terminal, onSaved, onClose, onError }: { api: Api; terminal?: Terminal; onSaved: (token?: Issued) => void; onClose: () => void; onError: (e: unknown) => void }) {
  const editing = !!terminal;
  const [name, setName] = useState(terminal?.name ?? "");
  const [allow, setAllow] = useState(terminal?.allow_refunds ?? true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return setError("Give the terminal a name.");
    setBusy(true); setError(null);
    try {
      if (terminal) { await api.updateTerminal(terminal.id, { name: name.trim(), allow_refunds: allow }); onSaved(); }
      else {
        const r = await api.createTerminal({ name: name.trim(), allow_refunds: allow });
        onSaved({ terminal: r.terminal.name, token: r.session_token, expires: r.session_expires_at });
      }
    } catch (err) { onError(err); setError(err instanceof ApiError && err.status === 400 ? "That name isn't allowed." : "Couldn't save the terminal. Try again."); }
    finally { setBusy(false); }
  }
  return (
    <Modal title={editing ? "Edit Terminal" : "Add a Terminal"} onClose={onClose} locked={busy}>
      <form onSubmit={submit} className="modal-form">
        <div className="fields">
          <label className="wide">Name<input value={name} maxLength={80} onChange={(e) => setName(e.target.value)} /></label>
          <label className="toggle-card wide">
            <span className="toggle-text"><strong>Allow refunds without approval</strong></span>
            <input type="checkbox" role="switch" checked={allow} onChange={(e) => setAllow(e.target.checked)} aria-label="Allow refunds without approval" />
            <span className="switch" aria-hidden />
          </label>
        </div>
        <p className="hint">With this off, refunds started on the terminal wait here until you approve them.</p>
        {error && <p className="error" role="alert">{error}</p>}
        <div className="modal-actions">
          <button type="submit" disabled={busy}>{busy ? "Saving…" : editing ? "Save Changes" : "Add Terminal"}</button>
          <button type="button" className="ghost" onClick={onClose} disabled={busy}>Cancel</button>
        </div>
      </form>
    </Modal>
  );
}

/** Pair an Orb by hand: its MAC address (any separators), model and firmware. Terminals normally do this themselves over Bluetooth. */
function PairOrb({ api, terminal, onDone, onClose, onError }: { api: Api; terminal: Terminal; onDone: () => void; onClose: () => void; onError: (e: unknown) => void }) {
  const [uid, setUid] = useState("");
  const [model, setModel] = useState("");
  const [software, setSoftware] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (uid.replace(/[^0-9a-f]/gi, "").length !== 12) return setError("The Orb ID is 12 letters and numbers (its MAC address).");
    if (!model.trim() || !software.trim()) return setError("Enter the Orb model and its software version.");
    setBusy(true); setError(null);
    try { await api.pairOrb(terminal.id, { uid, model: model.trim(), software: software.trim() }); onDone(); }
    catch (err) { onError(err); setError(err instanceof ApiError && err.code === "orb_assigned_to_another_account" ? "That Orb belongs to another business." : "Couldn't pair the Orb. Try again."); }
    finally { setBusy(false); }
  }
  return (
    <Modal title={`Pair an Orb to ${terminal.name}`} onClose={onClose} locked={busy}>
      <form onSubmit={submit} className="modal-form">
        <div className="fields">
          <label className="wide">Orb ID (MAC address)<input value={uid} maxLength={20} placeholder="AA:BB:CC:00:11:22" onChange={(e) => setUid(e.target.value)} /></label>
          <label>Model<input value={model} maxLength={60} onChange={(e) => setModel(e.target.value)} /></label>
          <label>Software version<input value={software} maxLength={30} placeholder="1.4.2" onChange={(e) => setSoftware(e.target.value)} /></label>
        </div>
        {error && <p className="error" role="alert">{error}</p>}
        <div className="modal-actions">
          <button type="submit" disabled={busy}>{busy ? "Pairing…" : "Pair Orb"}</button>
          <button type="button" className="ghost" onClick={onClose} disabled={busy}>Cancel</button>
        </div>
      </form>
    </Modal>
  );
}
