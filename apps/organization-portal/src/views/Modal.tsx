import { useEffect, useRef, type ReactNode } from "react";

/** A simple modal dialog. Escape and a click on the backdrop close it unless `locked`. */
export function Modal({
  title, onClose, locked = false, wide = false, children,
}: { title: string; onClose: () => void; locked?: boolean; wide?: boolean; children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    box.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !locked) close.current(); };
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("keydown", onKey); previous?.focus?.(); };
  }, [locked]);

  return (
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget && !locked) onClose(); }}>
      <div className={wide ? "modal wide" : "modal"} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} ref={box}>
        <h2>{title}</h2>
        {children}
      </div>
    </div>
  );
}
