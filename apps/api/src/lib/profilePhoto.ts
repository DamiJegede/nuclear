import type { Context } from "hono";
import type { AppContext } from "../env";
import { MAX_PROFILE_INPUT_BYTES, isImageInput, isImageKey, newImageKey, putJpeg, toProfileJpeg } from "./images";

/**
 * The shared upload step for account and wallet photos: validates the file, crops/compresses it to a 256 x 256 JPEG, writes it to R2
 * under a new key and deletes the previous object. Returns the new key, or a ready error response.
 */
export async function saveProfilePhoto(c: Context<AppContext>, folder: "accounts" | "wallets", id: string, previous: string | null): Promise<{ key: string } | Response> {
  const mime = (c.req.header("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  const bytes = new Uint8Array(await c.req.arrayBuffer());
  if (bytes.length === 0) return c.json({ error: "invalid_request" }, 400);
  if (bytes.length > MAX_PROFILE_INPUT_BYTES) return c.json({ error: "image_too_large" }, 413);
  if (!["image/png", "image/jpeg", "image/webp"].includes(mime)) return c.json({ error: "unsupported_image_type" }, 415);
  if (!isImageInput(mime, bytes)) return c.json({ error: "invalid_image" }, 400);
  if (!c.env.IMG || !c.env.IMAGES) return c.json({ error: "storage_unavailable" }, 503);
  const jpeg = await toProfileJpeg(c.env, bytes);
  if (!jpeg || jpeg.length === 0) return c.json({ error: "invalid_image" }, 400);
  const key = newImageKey(folder, id, "jpg");
  await putJpeg(c.env, key, jpeg);
  if (isImageKey(previous)) { try { await c.env.IMAGES.delete(previous); } catch { /* an orphan is harmless */ } }
  return { key };
}
