/**
 * An in-memory cache of what each page loaded, so going back to a page shows it straight away instead of asking the API again.
 * It lives only in this tab (a browser refresh starts empty), is dropped on sign-out, is cleared after any change the person
 * makes (a POST, PUT, PATCH or DELETE that succeeds), and entries older than five minutes are treated as missing.
 */
const TTL_MS = 5 * 60 * 1000;
const store = new Map<string, { data: unknown; at: number }>();

export const peek = <T,>(key: string): T | undefined => {
  const e = store.get(key);
  return e && Date.now() - e.at < TTL_MS ? (e.data as T) : undefined;
};
export const put = (key: string, data: unknown) => { store.set(key, { data, at: Date.now() }); };
/** Forget the given keys (one view's Refresh). */
export const drop = (...keys: string[]) => { for (const k of keys) store.delete(k); };
export const clearCache = () => store.clear();
