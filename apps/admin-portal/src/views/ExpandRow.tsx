import { useState, type ReactNode } from "react";

/**
 * A table row that opens a detail line across all columns when it is clicked (or Enter / Space), with the same slide effect as a transaction row.
 * `cells` are the row's own cells; `children` is what shows underneath (an id line and the actions that apply to this row). Clicks on a button or
 * link inside the row do not toggle it.
 */
export function ExpandRow({ cols, cells, children }: { cols: number; cells: ReactNode; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const toggle = () => setOpen((o) => !o);
  return (
    <>
      <tr className="tx-row" tabIndex={0} aria-expanded={open}
        onClick={(e) => { if (!(e.target as HTMLElement).closest("button, a")) toggle(); }}
        onKeyDown={(e) => { if ((e.key === "Enter" || e.key === " ") && e.target === e.currentTarget) { e.preventDefault(); toggle(); } }}>
        {cells}
      </tr>
      <tr className={`tx-detail${open ? " open" : ""}`} aria-hidden={!open}>
        <td colSpan={cols}>
          <div className="tx-collapse"><div className="tx-inner">{children}</div></div>
        </td>
      </tr>
    </>
  );
}
