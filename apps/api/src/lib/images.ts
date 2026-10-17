import type { Env } from "../env";

/**
 * Uploaded images live in the R2 bucket `nuclear-images` (binding IMAGES): tag pictures, store (shop) pictures, account and wallet
 * photos and product images. The database keeps only the **R2 key** (`<folder>/<id>-<epoch ms>.<png|jpg>`); every API output turns it
 * into the full public URL here. A new upload gets a new key, so URLs can be cached forever and the old object is deleted.
 * Every other file (business documents) goes to the private bucket `nuclear-uploads` (see lib/uploads.ts).
 */
export const IMAGE_FOLDERS = ["tags", "shop", "accounts", "wallets", "products"] as const;
export type ImageFolder = (typeof IMAGE_FOLDERS)[number];
export const MAX_IMAGE_BYTES = 262_144;
export const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
export const isPng = (b: Uint8Array) => b.length >= 8 && PNG_SIGNATURE.every((x, i) => b[i] === x);

const IMAGE_KEY = /^(tags|shop|accounts|wallets|products)\/[0-9a-f-]{36}-\d+\.(png|jpg)$/;
export const isImageKey = (k: string | null | undefined): k is string => !!k && IMAGE_KEY.test(k);
export const newImageKey = (folder: ImageFolder, id: string, ext: "png" | "jpg") => `${folder}/${id}-${Date.now()}.${ext}`;

/** The public address the API puts in front of image keys: PUBLIC_URL, else the address the request came in on (set per request in index.ts). */
let publicBase = "";
export const setPublicBase = (url: string) => { publicBase = url.replace(/\/+$/, ""); };
/** The full URL of a stored key; null for no photo (or a value that is not a key). */
export const imageUrl = (key: string | null | undefined): string | null => (isImageKey(key) ? `${publicBase}/v1/photos/${key}` : null);

export async function deleteImage(env: Env, key: string): Promise<void> {
  try { await env.IMAGES?.delete(key); } catch { /* an orphaned object is harmless */ }
}

export async function putPng(env: Env, key: string, bytes: Uint8Array): Promise<boolean> {
  if (!env.IMAGES) return false;
  await env.IMAGES.put(key, bytes, { httpMetadata: { contentType: "image/png" } });
  return true;
}

/** A public image response with a long cache (keys never change), or null when there is none. */
export async function imageResponse(env: Env, key: string): Promise<Response | null> {
  if (!env.IMAGES) return null;
  const obj = await env.IMAGES.get(key);
  if (!obj) return null;
  return new Response(await obj.arrayBuffer(), {
    headers: { "content-type": obj.httpMetadata?.contentType ?? "image/png", "cache-control": "public, max-age=31536000, immutable", "x-content-type-options": "nosniff" },
  });
}

// ---- Account, wallet (and product) photos: any PNG, JPEG or WebP, cropped to 256 x 256 and compressed to JPEG ----
export const MAX_PROFILE_INPUT_BYTES = 8 * 1024 * 1024;
const INPUT_SIGS: [string, number[]][] = [["image/png", [0x89, 0x50, 0x4e, 0x47]], ["image/jpeg", [0xff, 0xd8, 0xff]], ["image/webp", [0x52, 0x49, 0x46, 0x46]]];
export const isImageInput = (mime: string, b: Uint8Array) => INPUT_SIGS.some(([m, sig]) => m === mime && sig.every((x, i) => b[i] === x));

/** Crops to a centred square, scales to 256 x 256 and encodes as JPEG. Returns null when the bytes are not a readable image. */
export async function toProfileJpeg(env: Env, bytes: Uint8Array): Promise<Uint8Array | null> {
  if (!env.IMG) throw new Error("images_unavailable");
  try {
    const out = await env.IMG.input(new Blob([bytes]).stream()).transform({ width: 256, height: 256, fit: "cover" }).output({ format: "image/jpeg", quality: 82 });
    return new Uint8Array(await out.response().arrayBuffer());
  } catch {
    return null;
  }
}
export async function putJpeg(env: Env, key: string, bytes: Uint8Array): Promise<boolean> {
  if (!env.IMAGES) return false;
  await env.IMAGES.put(key, bytes, { httpMetadata: { contentType: "image/jpeg" } });
  return true;
}
