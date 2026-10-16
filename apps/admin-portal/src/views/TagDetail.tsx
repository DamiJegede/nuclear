import { useCallback, useEffect, useState } from "react";
import type { Api, TagDetail as Detail } from "../api";
import { int } from "../format";
import { ModelCard } from "./ModelCard";
import { ProvisionModal } from "./Provision";
import { TagFormModal } from "./TagForm";

/** One tag: a static card, its sales rank and activation numbers, provisioning and editing. */
export function TagDetail({ api, id, onBack, onError }: { api: Api; id: string; onBack: () => void; onError: (e: unknown) => void }) {
  const [m, setM] = useState<Detail | null>(null);
  const [failed, setFailed] = useState(false);
  const [editing, setEditing] = useState(false);
  const [provisioning, setProvisioning] = useState(false);

  const load = useCallback(async () => {
    try {
      setM(await api.model(id));
      setFailed(false);
    } catch (e) {
      setFailed(true);
      onError(e);
    }
  }, [api, id, onError]);

  useEffect(() => { void load(); }, [load]);

  return (
    <section>
      <div className="head">
        <h1><a href="/tags" className="crumb" onClick={(e) => { e.preventDefault(); onBack(); }}>Tags</a> <span className="muted">/</span> {m?.name ?? ""}</h1>
      </div>

      {failed && !m ? (
        <p className="error pad" role="alert">Couldn't load this tag. <button className="link" onClick={() => void load()}>Try Again</button></p>
      ) : !m ? (
        <p className="muted pad" role="status">Loading…</p>
      ) : (
        <div className="tag-detail">
          <ModelCard m={m} />
          <div className="tag-stats">
            <div className="model-card static stat" role="group" aria-label="Sales Ranking">
              <span className="stat-label">Sales Ranking</span>
              <strong className="stat-value">#{int(m.rank)}</strong>
              <span className="stat-sub">of {int(m.models_total)} {m.models_total === 1 ? "tag" : "tags"}</span>
            </div>
            <div className="model-card static stat" role="group" aria-label="Activated">
              <span className="stat-label">Activated</span>
              <strong className="stat-value">{int(m.activated)}</strong>
              <span className="stat-sub">of {int(m.tags)} provisioned</span>
            </div>
            <button type="button" className="model-card stat action" onClick={() => setProvisioning(true)} aria-label="Provision Tags">
              <span className="stat-label">Provision Tags</span>
              <strong className="stat-value">{int(m.pending)}</strong>
              <span className="stat-sub">PENDING · {int(m.tags)} of {int(m.quantity)} loaded</span>
            </button>
            <button type="button" className="model-card stat action" onClick={() => setEditing(true)} aria-label="Edit">
              <PencilIcon />
              <span className="stat-label">Edit</span>
            </button>
          </div>
        </div>
      )}

      {editing && m && <TagFormModal api={api} model={m} onClose={() => setEditing(false)} onError={onError} onSaved={async () => { setEditing(false); await load(); }} />}
      {provisioning && m && <ProvisionModal api={api} model={m} onClose={() => setProvisioning(false)} onError={onError} onDone={load} />}
    </section>
  );
}

const PencilIcon = () => (
  <svg viewBox="0 0 24 24" width="40" height="40" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16v4z" />
    <path d="M13.5 6.5l4 4" />
  </svg>
);
