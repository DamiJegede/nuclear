import { z } from "zod";

/**
 * Keyset paging for lists (employees, products). A page is `limit` rows (default 20, at most 100) and, when there are more, `next_cursor`.
 * Timestamps travel as the exact text the database produced (microseconds), never as a JavaScript date, so no row can be skipped or repeated
 * at a page boundary.
 */
export const DEFAULT_PAGE = 20;
export const pageLimit = z.coerce.number().int().min(1).max(100).default(DEFAULT_PAGE);

const b64 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64 = (s: string) => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)));

/** A cursor of two strings, opaque to callers. */
export const encodePair = (a: string, b: string) => b64(JSON.stringify([a, b]));

export function decodePair(cursor: string | undefined): [string, string] | null | "invalid" {
  if (!cursor) return null;
  try {
    const v = JSON.parse(unb64(cursor));
    return Array.isArray(v) && v.length === 2 && typeof v[0] === "string" && typeof v[1] === "string" ? [v[0], v[1]] : "invalid";
  } catch { return "invalid"; }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A cursor over (timestamp, id): validated so it can go into a query. */
export function decodeTimeCursor(cursor: string | undefined): { ts: string; id: string } | null | "invalid" {
  const p = decodePair(cursor);
  if (p === null || p === "invalid") return p;
  return !Number.isNaN(Date.parse(p[0])) && UUID.test(p[1]) ? { ts: p[0], id: p[1] } : "invalid";
}
