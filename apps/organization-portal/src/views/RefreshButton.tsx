/** A small icon button that reloads one view. Each view has its own, next to its title actions. */
export function RefreshButton({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" className="ghost icon-btn" aria-label="Refresh" title="Refresh" onClick={onClick}>
      <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="23 4 23 10 17 10" />
        <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
      </svg>
    </button>
  );
}
