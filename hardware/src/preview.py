#!/usr/bin/env python3
"""Draws design/layout.png: the board as the layout places it (top side parts blue outline, bottom side parts orange), to compare with the owner's drawing."""
import math, os, sys
from PIL import Image, ImageDraw
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import design as D, layout as L
S = 20                                   # px per mm
W = int(86 * S); C = W // 2
def P(x, y): return (C + x * S, C - y * S)
errs, pos, polys, info = L.check()
im = Image.new("RGB", (W, W), "white"); d = ImageDraw.Draw(im)
d.ellipse([P(-L.R_OUT, L.R_OUT), P(L.R_OUT, -L.R_OUT)], outline="black", width=3, fill=(247, 247, 247))
d.ellipse([P(-L.BATTERY_R, L.BATTERY_R), P(L.BATTERY_R, -L.BATTERY_R)], outline=(190, 160, 40), width=2)
d.line([P(-14.3, L.BRAND_Y), P(14.3, L.BRAND_Y)], fill=(120, 120, 255), width=2); d.text(P(-6, L.BRAND_Y - 1.5), "BRANDING", fill=(120, 120, 255))
for sx, sy in L.SLOTS: d.rounded_rectangle([P(sx - L.SLOT_W / 2, sy + L.SLOT_H / 2), P(sx + L.SLOT_W / 2, sy - L.SLOT_H / 2)], radius=10, fill=(60, 60, 70))
for poly in L.red_polygons(): d.polygon([P(*p) for p in poly], fill=(255, 190, 190), outline="red")
for sx, sy in L.SCREWS:
    d.ellipse([P(sx - L.SCREW_KEEPOUT, sy + L.SCREW_KEEPOUT), P(sx + L.SCREW_KEEPOUT, sy - L.SCREW_KEEPOUT)], outline="gray", width=2)
    d.ellipse([P(sx - 1.1, sy + 1.1), P(sx + 1.1, sy - 1.1)], fill="gray")
bw, bh = L.FPC_BAR; d.rectangle([P(L.FPC_XY[0] - bw / 2, L.FPC_XY[1] + bh / 2), P(L.FPC_XY[0] + bw / 2, L.FPC_XY[1] - bh / 2)], fill=(80, 170, 255))
for r, (poly, mirror) in polys.items():
    pts = [P(*p) for p in poly]
    if r.startswith("LED"): d.polygon(pts, fill=(205, 205, 205), outline=(120, 120, 120))
    elif r == "J3": d.polygon(pts, outline=(0, 90, 200), width=2)
    elif r == "J1": d.polygon(pts, outline=(200, 90, 0), width=3, fill=(255, 235, 210))
    else: d.polygon(pts, outline=(200, 100, 0) if mirror else (0, 0, 200), fill=(255, 245, 225) if r.startswith("C1") and len(r) == 4 else None)
d.polygon([P(*p) for p in L.ANT_CLEAR],outline=(0,140,60),width=3)
d.text(P(15,34),"ANTENNA CLEAR AREA",fill=(0,120,50))
for r in ("ANT1", "Y2", "U1", "U2", "U3", "U4", "U5", "U6", "U7", "U8", "J1", "J2", "J3", "SPK1", "D1", "L1", "Y1", "C32", "C33"):
    x, y = P(pos[r]["x"], pos[r]["y"] + (2.4 if r == "J1" else 0)); d.text((x - 8, y - 5), r, fill="black")
im.save(os.path.join(os.path.dirname(HERE), "design", "layout.png")); print("wrote design/layout.png;", "layout OK" if not errs else errs)
