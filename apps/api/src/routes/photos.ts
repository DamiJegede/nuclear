import { Hono } from "hono";
import type { AppContext } from "../env";
import { imageResponse, isImageKey } from "../lib/images";

/** Every image in the `nuclear-images` bucket (tags, shop, accounts, wallets, products), public, cached for good (a new upload gets a new key). */
export const photos = new Hono<AppContext>();

photos.get("/:folder/:file", async (c) => {
  const key = `${c.req.param("folder")}/${c.req.param("file")}`;
  if (!isImageKey(key)) return c.json({ error: "not_found" }, 404);
  return (await imageResponse(c.env, key)) ?? c.json({ error: "not_found" }, 404);
});
