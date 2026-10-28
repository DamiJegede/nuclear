/** Photos are stored at 256 x 256: crop to a centred square, scale, and encode as PNG (transparency kept). */
export const PHOTO_SIZE = 256;

export async function resizePhoto(file: File, size: number = PHOTO_SIZE): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  try {
    const side = Math.min(bitmap.width, bitmap.height);
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no_canvas");
    ctx.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, size, size);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!blob) throw new Error("encode_failed");
    return blob;
  } finally {
    bitmap.close();
  }
}

/** A logo keeps its shape: scaled to fit inside size x size and centred on a transparent square (PNG), never cropped. */
export async function containPhoto(file: File, size: number = PHOTO_SIZE): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  try {
    const scale = Math.min(size / bitmap.width, size / bitmap.height);
    const w = Math.max(1, Math.round(bitmap.width * scale)), h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no_canvas");
    ctx.drawImage(bitmap, 0, 0, bitmap.width, bitmap.height, (size - w) / 2, (size - h) / 2, w, h);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!blob) throw new Error("encode_failed");
    return blob;
  } finally {
    bitmap.close();
  }
}
