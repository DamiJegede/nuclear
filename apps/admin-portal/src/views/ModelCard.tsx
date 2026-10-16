import type { TagModel } from "../api";
import { int } from "../format";

/** A tag (model) card. With `href` it is a link to the tag's page; without, it is a static display. */
export function ModelCard({ m, href, onOpen }: { m: TagModel; href?: string; onOpen?: () => void }) {
  const body = (
    <>
      {m.photo
        ? <img src={m.photo} alt="" width={256} height={256} loading="lazy" draggable={false} />
        : <div className="model-photo-empty" aria-hidden>{m.type === "card" ? "▭" : "◯"}</div>}
      <h3>{m.name}</h3>
      <p className="model-count"><strong>{int(m.sold)}</strong> / {int(m.quantity)} <span className="model-count-label">sold</span></p>
      <span className="model-type">{m.type.toUpperCase()}</span>
    </>
  );
  return href
    ? <li className="model-card"><a className="model-link" href={href} onClick={(e) => { e.preventDefault(); onOpen?.(); }}>{body}</a></li>
    : <div className="model-card static" aria-label={m.name}>{body}</div>;
}
