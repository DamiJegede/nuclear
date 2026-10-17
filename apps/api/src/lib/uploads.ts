import type { Env } from "../env";

/** Files a person uploads (business documents). They live in the private R2 bucket `nuclear-uploads` at `path` = <account id>/<upload id>.<ext>. */
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
export const MAX_DOCUMENTS = 10;

const KINDS = [
  { mime: "application/pdf", ext: "pdf", sig: [0x25, 0x50, 0x44, 0x46] },
  { mime: "image/png", ext: "png", sig: [0x89, 0x50, 0x4e, 0x47] },
  { mime: "image/jpeg", ext: "jpg", sig: [0xff, 0xd8, 0xff] },
] as const;

/** The allowed kind for a content type whose first bytes match (a PDF, PNG or JPEG), or null. */
export const uploadKind = (contentType: string, bytes: Uint8Array) => {
  const k = KINDS.find((x) => x.mime === contentType);
  return k && k.sig.every((b, i) => bytes[i] === b) ? k : null;
};
export const mimeOfPath = (path: string) => KINDS.find((k) => path.endsWith("." + k.ext))?.mime ?? "application/octet-stream";

export const putUpload = async (env: Env, path: string, bytes: Uint8Array, mime: string): Promise<boolean> => {
  if (!env.UPLOADS) return false;
  await env.UPLOADS.put(path, bytes, { httpMetadata: { contentType: mime } });
  return true;
};
export const getUpload = async (env: Env, path: string) => (env.UPLOADS ? env.UPLOADS.get(path) : null);
