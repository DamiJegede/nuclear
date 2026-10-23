import { useCallback, useEffect, useState } from "react";

/** Loads a list once (and again on retry), keeping the failure so the view can offer Try Again. */
export function useList<T>(load: () => Promise<T>, onError: (e: unknown) => void) {
  const [data, setData] = useState<T | null>(null);
  const [failed, setFailed] = useState(false);
  const run = useCallback(async () => { try { setData(await load()); setFailed(false); } catch (e) { setFailed(true); onError(e); } }, [load, onError]);
  useEffect(() => { void run(); }, [run]);
  return { data, failed, retry: () => void run() };
}
