import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export type MenuItem = { label: string; onSelect: () => void; danger?: boolean };

/**
 * The "⋯" menu on a table row or list item: one quiet button that opens the actions for it. The menu is drawn in the page body (so a table that
 * scrolls sideways cannot clip it), opens under the button aligned to its right edge (above it when there is no room), closes on a choice, a click
 * elsewhere, Escape, scrolling or resizing, and works with the arrow keys.
 */
export function RowMenu({ label, items }: { label: string; items: MenuItem[] }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const id = useId();
  const close = useCallback((refocus = false) => { setOpen(false); if (refocus) btn.current?.focus(); }, []);

  useLayoutEffect(() => {
    if (!open || !btn.current || !menu.current) return;
    const r = btn.current.getBoundingClientRect();
    const w = menu.current.offsetWidth, h = menu.current.offsetHeight;
    const below = r.bottom + 6 + h <= window.innerHeight - 8;
    setPos({ top: below ? r.bottom + 6 : Math.max(8, r.top - 6 - h), left: Math.min(Math.max(8, r.right - w), window.innerWidth - w - 8) });
    menu.current.querySelector<HTMLButtonElement>("button")?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => { const t = e.target as Node; if (!menu.current?.contains(t) && !btn.current?.contains(t)) close(); };
    const leave = () => close();
    document.addEventListener("pointerdown", away);
    window.addEventListener("resize", leave);
    window.addEventListener("scroll", leave, true);
    return () => { document.removeEventListener("pointerdown", away); window.removeEventListener("resize", leave); window.removeEventListener("scroll", leave, true); };
  }, [open, close]);

  function key(e: React.KeyboardEvent) {
    const els = Array.from(menu.current?.querySelectorAll<HTMLButtonElement>("button") ?? []);
    const i = els.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === "Escape") { e.preventDefault(); close(true); }
    else if (e.key === "Tab") close();
    else if (e.key === "ArrowDown") { e.preventDefault(); els[(i + 1) % els.length]?.focus(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); els[(i - 1 + els.length) % els.length]?.focus(); }
    else if (e.key === "Home") { e.preventDefault(); els[0]?.focus(); }
    else if (e.key === "End") { e.preventDefault(); els[els.length - 1]?.focus(); }
  }

  return (
    <>
      <button ref={btn} type="button" className="ghost menu-btn" aria-label={label} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined}
        onClick={() => { setPos(null); setOpen((o) => !o); }}>
        <svg viewBox="0 0 20 20" aria-hidden focusable="false"><circle cx="4" cy="10" r="1.7" /><circle cx="10" cy="10" r="1.7" /><circle cx="16" cy="10" r="1.7" /></svg>
      </button>
      {open && createPortal(
        <div id={id} ref={menu} role="menu" aria-label={label} className="menu" style={pos ? { top: pos.top, left: pos.left } : { top: 0, left: 0, visibility: "hidden" }} onKeyDown={key}>
          {items.map((it) => (
            <button key={it.label} type="button" role="menuitem" className={it.danger ? "danger" : undefined} onClick={() => { close(true); it.onSelect(); }}>{it.label}</button>
          ))}
        </div>,
        document.body,
      )}
    </>
  );
}
