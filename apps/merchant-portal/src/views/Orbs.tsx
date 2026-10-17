import { useCallback, useState } from "react";
import { RefreshButton } from "./RefreshButton";
import type { Api, OwnedOrb, Terminal } from "../api";
import { usePageTitle } from "../title";
import { useList } from "../useList";
import { Modal } from "./Modal";

/** Every Orb that belongs to this business, which terminal it is on, and Release for one you no longer use. */
export function Orbs({ api, onError }: { api: Api; onError: (e: unknown) => void }) {
  usePageTitle("Orbs");
  const load = useCallback(async () => {
    const [orbs, terminals] = await Promise.all([api.orbs(), api.terminals()]);
    return { orbs, terminals };
  }, [api]);
  const { data, failed, retry } = useList<{ orbs: OwnedOrb[]; terminals: Terminal[] }>(load, onError, "orbs");
  const [target, setTarget] = useState<OwnedOrb | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function release() {
    if (!target) return;
    setBusy(true); setError(null);
    try { await api.releaseOrb(target.id); setTarget(null); retry(); }
    catch (e) { onError(e); setError("Couldn't release the Orb. Try again."); }
    finally { setBusy(false); }
  }

  return (
    <section>
      <div className="head"><h1>Orbs</h1><div className="head-actions"><RefreshButton onClick={retry} /></div></div>
      <div className="card flush">
        {failed && !data ? <p className="error pad" role="alert">Couldn't load Orbs. <button className="link" onClick={retry}>Try Again</button></p>
          : !data ? <p className="muted pad" role="status">Loading…</p>
          : data.orbs.length === 0 ? <p className="muted pad">No Orbs yet. An Orb appears here the first time it is paired to one of your terminals.</p>
          : (
            <table>
              <thead><tr><th scope="col">Orb</th><th scope="col">Model</th><th scope="col">Software</th><th scope="col">Terminal</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
              <tbody>
                {data.orbs.map((o) => (
                  <tr key={o.id}>
                    <th scope="row"><code>{o.uid}</code></th>
                    <td>{o.model}</td>
                    <td>v{o.software}</td>
                    <td>{o.terminal_id ? data.terminals.find((t) => t.id === o.terminal_id)?.name ?? "—" : <span className="muted">Not paired</span>}</td>
                    <td className="actions"><button type="button" className="ghost" onClick={() => { setError(null); setTarget(o); }}>Release</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
      </div>
      {target && (
        <Modal title="Release Orb" onClose={() => setTarget(null)} locked={busy}>
          <p>Release the Orb <code>{target.uid}</code>? It leaves your account and its terminal, and whoever pairs it next can claim it. Use this when you sell, return or replace an Orb.</p>
          {error && <p className="error" role="alert">{error}</p>}
          <div className="modal-actions">
            <button type="button" disabled={busy} onClick={() => void release()}>{busy ? "Releasing…" : "Confirm Release"}</button>
            <button type="button" className="ghost" disabled={busy} onClick={() => setTarget(null)}>Cancel</button>
          </div>
        </Modal>
      )}
    </section>
  );
}
