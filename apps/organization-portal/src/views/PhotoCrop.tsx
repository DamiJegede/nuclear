import { useEffect, useRef, useState } from "react";
import { Modal } from "./Modal";

const SIZE = 256;

/** Reads an image file into something drawable (createImageBitmap where the browser has it, an <img> otherwise). */
async function decode(file: File): Promise<{ w: number; h: number; draw: (ctx: CanvasRenderingContext2D, sx: number, sy: number, sw: number, sh: number) => void; close: () => void }> {
  if (typeof createImageBitmap === "function") {
    const bmp = await createImageBitmap(file);
    return { w: bmp.width, h: bmp.height, draw: (ctx, sx, sy, sw, sh) => ctx.drawImage(bmp, sx, sy, sw, sh, 0, 0, SIZE, SIZE), close: () => bmp.close() };
  }
  const url = URL.createObjectURL(file);
  const img = await new Promise<HTMLImageElement>((ok, fail) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => fail(new Error("decode")); i.src = url; });
  return { w: img.naturalWidth, h: img.naturalHeight, draw: (ctx, sx, sy, sw, sh) => ctx.drawImage(img, sx, sy, sw, sh, 0, 0, SIZE, SIZE), close: () => URL.revokeObjectURL(url) };
}

/**
 * Position and zoom a picture inside a circle, then save it as a 256 x 256 JPEG. Drag to move, the slider to zoom.
 * What is inside the circle is what customers see; the API compresses it again on upload.
 */
export function PhotoCrop({ file, onSave, onClose }: { file: File; onSave: (jpeg: Blob) => Promise<void>; onClose: () => void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const img = useRef<Awaited<ReturnType<typeof decode>> | null>(null);
  const drag = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);
  const [ready, setReady] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });         // 0..1 across the free space, 0.5 = centred
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    decode(file).then((d) => { if (!alive) { d.close(); return; } img.current = d; setReady(true); }).catch(() => alive && setError("Couldn't read that image. Choose a PNG, JPEG or WebP picture."));
    return () => { alive = false; img.current?.close(); };
  }, [file]);

  // The visible square, in picture pixels: the largest centred square, shrunk by the zoom, moved by the offset.
  const region = () => {
    const d = img.current!;
    const side = Math.min(d.w, d.h) / zoom;
    return { sx: (d.w - side) * offset.x, sy: (d.h - side) * offset.y, side };
  };
  useEffect(() => {
    const c = canvas.current, d = img.current;
    if (!ready || !c || !d) return;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, SIZE, SIZE);
    const r = region();
    d.draw(ctx, r.sx, r.sy, r.side, r.side);
  }, [ready, zoom, offset]); // eslint-disable-line react-hooks/exhaustive-deps

  function down(e: React.PointerEvent) { drag.current = { x: e.clientX, y: e.clientY, ox: offset.x, oy: offset.y }; (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId); }
  function move(e: React.PointerEvent) {
    const s = drag.current, d = img.current;
    if (!s || !d) return;
    const side = Math.min(d.w, d.h) / zoom;
    // Dragging right shows more of the left: the offset moves against the drag, scaled from screen pixels to picture pixels.
    const k = side / SIZE;
    const clamp = (v: number) => Math.min(1, Math.max(0, v));
    setOffset({
      x: d.w - side > 0 ? clamp(s.ox - ((e.clientX - s.x) * k) / (d.w - side)) : 0.5,
      y: d.h - side > 0 ? clamp(s.oy - ((e.clientY - s.y) * k) / (d.h - side)) : 0.5,
    });
  }

  async function save() {
    const c = canvas.current;
    if (!c) return;
    setBusy(true); setError(null);
    try {
      const blob = await new Promise<Blob | null>((ok) => c.toBlob(ok, "image/jpeg", 0.9));
      if (!blob) throw new Error("encode");
      await onSave(blob);
    } catch { setError("Couldn't upload the picture. Try again."); setBusy(false); }
  }

  return (
    <Modal title="Profile Picture" onClose={onClose} locked={busy}>
      <div className="crop">
        <div className="crop-frame" aria-label="Picture preview. Drag to move.">
          <canvas ref={canvas} width={SIZE} height={SIZE} className="crop-canvas" onPointerDown={down} onPointerMove={move} onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }} />
        </div>
        <label className="crop-zoom">Zoom
          <input type="range" min={1} max={3} step={0.02} value={zoom} onChange={(e) => setZoom(Number(e.target.value))} aria-label="Zoom" />
        </label>
        <p className="hint">Drag the picture to move it. The circle is what customers see.</p>
        {error && <p className="error" role="alert">{error}</p>}
      </div>
      <div className="modal-actions">
        <button type="button" disabled={busy || !ready} onClick={() => void save()}>{busy ? "Saving…" : "Save Picture"}</button>
        <button type="button" className="ghost" disabled={busy} onClick={onClose}>Cancel</button>
      </div>
    </Modal>
  );
}
