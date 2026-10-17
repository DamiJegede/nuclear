import { useCallback, useEffect, useState } from "react";

/** Loads a list (or any value) once, and again on `retry()`. `failed` is true when the first load failed. */
export function useList<T>(load: () => Promise<T>, onError: (e: unknown) => void) {
  const [data, setData] = useState<T | null>(null);
  const [failed, setFailed] = useState(false);
  const run = useCallback(async () => {
    try { setData(await load()); setFailed(false); } catch (e) { setFailed(true); onError(e); }
  }, [load, onError]);
  useEffect(() => { void run(); }, [run]);
  return { data, failed, retry: () => void run(), setData };
}

export const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : "Never");
export const day = (iso: string) => new Date(iso).toLocaleDateString();
