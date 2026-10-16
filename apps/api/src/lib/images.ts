import type { Env } from "../env";

/**
 * Uploaded images live in the R2 bucket `nuclear-images` (binding IMAGES). The database keeps only the file name
 * (`<id>-<epoch ms>.png`); the folder (`tags/`, `shop/`) and the public URL are rendered from fixed prefixes here.
 * A new upload gets a new file name, so URLs can be cached forever and the old object is deleted.
 */
export const MAX_IMAGE_BYTES = 262_144;
export const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
export const isPng = (b: Uint8Array) => b.length >= 8 && PNG_SIGNATURE.every((x, i) => b[i] === x);

export const tagImageKey = (file: string) => `tags/${file}`;
export const shopImageKey = (file: string) => `shop/${file}`;
export const newImageFile = (id: string) => `${id}-${Date.now()}.png`;
const FILE = /^[0-9a-f-]{36}-\d+\.png$/;

/** The public URL of a stored file name (null stays null). */
export const modelPhotoUrl = (id: string, file: string | null) => (file ? `/v1/shop/models/${id}/photo?v=${file.replace(/\.png$/, "").slice(37)}` : null);
export const itemPhotoUrl = (id: string, file: string | null) => (file ? `/v1/shop/items/${id}/photo?v=${file.replace(/\.png$/, "").slice(37)}` : null);
export const isImageFile = (f: string | null): f is string => !!f && FILE.test(f);

export async function deleteImage(env: Env, key: string): Promise<void> {
  try { await env.IMAGES?.delete(key); } catch { /* an orphaned object is harmless */ }
}

export async function putPng(env: Env, key: string, bytes: Uint8Array): Promise<boolean> {
  if (!env.IMAGES) return false;
  await env.IMAGES.put(key, bytes, { httpMetadata: { contentType: "image/png" } });
  return true;
}

/** A public image response with a long cache (the URL carries a ?v= version), or null when there is none. */
export async function imageResponse(env: Env, key: string): Promise<Response | null> {
  if (!env.IMAGES) return null;
  const obj = await env.IMAGES.get(key);
  if (!obj) return null;
  return new Response(await obj.arrayBuffer(), {
    headers: { "content-type": obj.httpMetadata?.contentType ?? "image/png", "cache-control": "public, max-age=31536000, immutable", "x-content-type-options": "nosniff" },
  });
}
