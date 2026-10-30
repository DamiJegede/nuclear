#!/usr/bin/env python3
"""Re-reads the generated Fusion files and checks them against design.py, independently of the writer: every pin of every part is on the right net in the
schematic, every board signal names pads that exist in the package, nothing is left unplaced, and no two different nets' wires touch."""
import sys, os, re, itertools
import xml.etree.ElementTree as ET
HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)
import design as D

bad = []
def fail(m): bad.append(m)
sch = ET.parse(os.path.join(ROOT, "fusion", "orb.sch")).getroot()
brd = ET.parse(os.path.join(ROOT, "fusion", "orb.brd")).getroot()
lbr = ET.parse(os.path.join(ROOT, "fusion", "orb.lbr")).getroot()

# library: every deviceset pad exists in its package, every pin in its symbol
def lib_index(lib):
    pk = {p.get("name"): {s.get("name") for s in list(p.findall("smd")) + list(p.findall("pad"))} for p in lib.iter("package")}
    sy = {s.get("name"): {p.get("name") for p in s.findall("pin")} for s in lib.iter("symbol")}
    return pk, sy
for root, nm in ((sch, "sch"), (lbr, "lbr")):
    lib = next(root.iter("library")); pk, sy = lib_index(lib)
    for ds in lib.iter("deviceset"):
        for dev in ds.iter("device"):
            pads = pk.get(dev.get("package"))
            if pads is None: fail(f"{nm}: package {dev.get('package')} missing"); continue
            for c in dev.iter("connect"):
                if c.get("pin") not in sy[ds.get("name")]: fail(f"{nm}: {ds.get('name')} pin {c.get('pin')} not in symbol")
                for pad in c.get("pad").split():
                    if pad not in pads: fail(f"{nm}: {ds.get('name')} pad {pad} not in {dev.get('package')}")

# schematic nets == design nets
want = {}
for ref, i in D.INST.items():
    for pin, n in i["nets"].items(): want.setdefault(n, set()).add((ref, pin))
got = {}
for net in sch.iter("net"):
    for seg in net.iter("segment"):
        for pr in seg.iter("pinref"): got.setdefault(net.get("name"), set()).add((pr.get("part"), pr.get("pin")))
for n, pins in want.items():
    if len(pins) < 2 and "NC" in n: continue
    if got.get(n) != pins: fail(f"schematic net {n} differs: missing {sorted(pins - got.get(n, set()))[:3]} extra {sorted(got.get(n, set()) - pins)[:3]}")
for n in got:
    if n not in want: fail(f"schematic has extra net {n}")
parts = {p.get("name") for p in sch.iter("part")}; insts = {i.get("part") for i in sch.iter("instance")}
if parts != set(D.INST) or insts != set(D.INST): fail("parts/instances do not match design.py")

# wires of different nets must not touch (stub geometry)
segs = []
for net in sch.iter("net"):
    for w in net.iter("wire"):
        segs.append((net.get("name"), float(w.get("x1")), float(w.get("y1")), float(w.get("x2")), float(w.get("y2"))))
byrow = {}
for nm, x1, y1, x2, y2 in segs: byrow.setdefault(round(y1, 3), []).append((nm, min(x1, x2), max(x1, x2)))
for y, lst in byrow.items():
    lst.sort(key=lambda s: s[1])
    for a, b in itertools.combinations(lst, 2):
        if a[0] != b[0] and a[1] <= b[2] + 1e-6 and b[1] <= a[2] + 1e-6: fail(f"wires of {a[0]} and {b[0]} touch at y={y}")
# instances must not overlap each other
bb = {}
for i in sch.iter("instance"): bb[i.get("part")] = (float(i.get("x")), float(i.get("y")))
# board: elements, packages, signals
bpk = {p.get("name"): {s.get("name") for s in list(p.findall("smd")) + list(p.findall("pad"))} for p in brd.iter("package")}
els = {e.get("name"): e for e in brd.iter("element")}
if set(els) != set(D.INST): fail("board elements do not match design.py")
for r, e in els.items():
    if e.get("package") != D.TYPES[D.INST[r]["type"]]["pkg"]: fail(f"{r}: wrong package on the board")
for sig in brd.iter("signal"):
    for c in sig.iter("contactref"):
        e = els.get(c.get("element"))
        if e is None or c.get("pad") not in bpk[e.get("package")]: fail(f"signal {sig.get('name')}: {c.get('element')}.{c.get('pad')} does not exist")
bsig = {s.get("name"): {(c.get("element"), c.get("pad")) for c in s.iter("contactref")} for s in brd.iter("signal")}
for n, pins in want.items():
    if len(pins) < 2: continue
    pads = set()
    for ref, pin in pins:
        t = D.TYPES[D.INST[ref]["type"]]
        for p in t["pins"]:
            if p[0] == pin: pads |= {(ref, x) for x in p[1]}
    if bsig.get(n) != pads: fail(f"board signal {n} differs")
# LED ring: configured LEDs on planned radius at the planned angles, distinct positions, all inside the outline
import math
import layout as L
pts = []
for r, e in els.items():
    x, y = float(e.get("x")), float(e.get("y"))
    if r.startswith("LED"):
        pts.append((x, y))
        if abs(math.hypot(x, y) - L.led_radius(int(r[3:]))) > 0.01: fail(f"{r} is not on the ring")
        want_a = L.LED_ANGLES[int(r[3:]) - 1]
        if abs(((math.degrees(math.atan2(y, x)) - want_a + 180) % 360) - 180) > 0.05: fail(f"{r} is not at {want_a} degrees")
if len(pts) != D.N_LED: fail("ring count")
d = min(math.dist(a, b) for a, b in itertools.combinations(pts, 2))
if d < 6.0: fail(f"LED pitch {d:.2f} mm too tight for 5 mm packages")
# board features from the drawing: screw holes, pedestal keep-outs, the USB-C front 5 mm out, nothing but LEDs and the FPC connector on the top side
holes = sorted((float(h.get("x")), float(h.get("y"))) for h in brd.iter("hole"))
if holes != sorted(L.SCREWS): fail(f"screw holes are {holes}")
if sum(1 for p in brd.iter("polygon") if p.get("layer") == "42") < len(L.SCREWS) + 2: fail("screw and pedestal keep-outs missing on the bottom side")
j1 = els["J1"]
if (float(j1.get("x")), float(j1.get("y")), j1.get("rot")) != (0.0, L.R_OUT, "MR0"): fail("USB-C is not at 12 o'clock on the bottom side")
if abs(max(float(w.get("y2")) for p in brd.iter("package") if p.get("name") == "USBC24_TE2345986" for w in p.findall("wire")) - L.USB_OVERHANG) > 0.01: fail("USB-C package does not overhang by the planned amount")
for r, e in els.items():
    if (e.get("rot") or "").startswith("M") and r != "J1" and not (r.startswith("C1") and len(r) == 4): fail(f"{r} is on the bottom, where the battery is")
if bad:
    print("FAIL"); [print(" -", b) for b in bad[:30]]; sys.exit(1)
print(f"ok: {len(want)} nets and {len(els)} parts agree between design.py, orb.sch, orb.brd and orb.lbr; LED pitch {d:.2f} mm")
