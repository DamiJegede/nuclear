import { useCallback, useEffect, useRef, useState } from "react";

export type Page<T> = { items: T[]; next: string | null; total: number };

/**
 * A list that is loaded a page at a time (20 by default on the server). `load(cursor)` returns one page. When `load` changes (a new search or
 * filter) the list starts over. `loadMore()` appends the next page; `retry()` reloads the first one.
 */
export function usePaged<T>(load: (cursor?: string) => Promise<Page<T>>, onError: (e: unknown) => void) {
  const [rows, setRows] = useState<T[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [total, setTotal] = useState(0);
  const [failed, setFailed] = useState(false);
  const [more, setMore] = useState(false);
  const seq = useRef(0);

  const first = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const p = await load();
      if (mine !== seq.current) return;
      setRows(p.items); setNext(p.next); setTotal(p.total); setFailed(false);
    } catch (e) {
      if (mine === seq.current) { setFailed(true); onError(e); }
    }
  }, [load, onError]);
  useEffect(() => { setRows(null); void first(); }, [first]);

  const loadMore = useCallback(async () => {
    if (!next || more) return;
    const mine = seq.current;
    setMore(true);
    try {
      const p = await load(next);
      if (mine !== seq.current) return;
      setRows((r) => [...(r ?? []), ...p.items]); setNext(p.next); setTotal(p.total);
    } catch (e) { onError(e); }
    finally { setMore(false); }
  }, [load, next, more, onError]);

  return { rows, total, hasMore: next !== null, more, failed, retry: () => void first(), loadMore };
}
