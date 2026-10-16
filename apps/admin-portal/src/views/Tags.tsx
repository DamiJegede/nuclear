import { useCallback, useEffect, useState } from "react";
import type { Api, TagModel } from "../api";
import { ModelCard } from "./ModelCard";
import { TagFormModal } from "./TagForm";

export function Tags({ api, onError, open }: { api: Api; onError: (e: unknown) => void; open: (id: string) => void }) {
  const [models, setModels] = useState<TagModel[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    try {
      setModels(await api.models());
      setFailed(false);
    } catch (e) {
      setFailed(true);
      onError(e);
    }
  }, [api, onError]);

  useEffect(() => { void load(); }, [load]);

  return (
    <section>
      <div className="head"><h1>Tags</h1></div>

      {failed && !models ? (
        <p className="error pad" role="alert">Couldn't load tags. <button className="link" onClick={() => void load()}>Try Again</button></p>
      ) : !models ? (
        <p className="muted pad" role="status">Loading…</p>
      ) : (
        <ul className="model-grid" aria-label="Tags">
          {models.map((m) => <ModelCard key={m.id} m={m} href={`/tags/${m.id}`} onOpen={() => open(m.id)} />)}
          <li className="model-card model-add">
            <button type="button" onClick={() => setAdding(true)} aria-label="Add Tag">
              <span className="plus" aria-hidden>+</span>
              <span>Add Tag</span>
            </button>
          </li>
        </ul>
      )}

      {adding && <TagFormModal api={api} onClose={() => setAdding(false)} onError={onError} onSaved={async () => { setAdding(false); await load(); }} />}
    </section>
  );
}
