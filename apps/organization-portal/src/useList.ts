import { useCallback, useEffect, useState } from "react";
import { peek, put } from "./cache";

/**
 * Loads a list (or any value). With a `key` the result is cached in memory: coming back to the page shows it at once and asks the
 * API only when there is nothing cached (or it is over five minutes old). `retry()` always asks again. `failed` is true when the
 * first load failed.
 */
export function useList<T>(load: () => Promise<T>, onError: (e: unknown) => void, key?: string) {
  const [data, setData] = useState<T | null>(() => (key ? peek<T>(key) ?? null : null));
  const [failed, setFailed] = useState(false);
  const run = useCallback(async () => {
    try { const d = await load(); setData(d); if (key) put(key, d); setFailed(false); } catch (e) { setFailed(true); onError(e); }
  }, [load, onError, key]);
  useEffect(() => {
    const cached = key ? peek<T>(key) : undefined;
    if (cached !== undefined) { setData(cached); setFailed(false); return; }
    void run();
  }, [run, key]);
  return { data, failed, retry: () => void run(), setData };
}

export const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : "Never");
export const day = (iso: string) => new Date(iso).toLocaleDateString();
