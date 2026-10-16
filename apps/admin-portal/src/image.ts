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
