"""Board layout: where every part goes on the 69 mm board, and the keep-outs it must respect.

Geometry follows the owner's mechanical constraints, with the October 29 LED revision:
 - 23 LEDs, with the uppermost pair moved to R27.5 for the SMT antenna; others R31.5: five on each upper side and thirteen around the bottom. A 50-degree top gap clears the USB through-board mounts.
 - M2 screws at (+-32, 0): drill 2.2 mm, keep-out R2.5. Two milled slots 1.5 x 9.5 mm at (+-27.4, 0).
 - Pedestal feet occupy annulus R22.0 to R27.75 around the side axes; reserve both faces for parts and copper.
 - Hirose FPC connector centred at (0, -20.5), top face, tail entering from +y. Branding remains below y=-22.5 inside the LED ring.
 - Battery underneath: R24.9, flat at y=15.5. USB-C stays underneath at 12 o'clock, with its front aligned to y=34.5; all LED capacitors are underneath in the outer ring.
Everything else is on the top side.
"""
import math
import design as D

R_OUT = 34.5
R_LED = 31.5
LED_INNER_REFS = {1,23}  # uppermost pair moves inward to open the antenna edge area
def led_radius(i): return 27.5 if i in LED_INNER_REFS else R_LED
ANT_XY = (8.3,31.3)
# Clip the clearance outline to the circular PCB; no drawing extends past it.
_ant_a0=math.acos(14.3/R_OUT); _ant_a1=math.acos(6.3/R_OUT)
ANT_CLEAR = [(6.3,28.85),(14.3,28.85)] + [(R_OUT*math.cos(_ant_a0+(_ant_a1-_ant_a0)*i/12),R_OUT*math.sin(_ant_a0+(_ant_a1-_ant_a0)*i/12)) for i in range(13)]
ANT_ZONE_ALLOWED = {"ANT1","C45","R23"}
LED_ANGLES = [65,52,39,26,13] + [-12-13*k for k in range(13)] + [167,154,141,128,115]  # clockwise, 23 LEDs; clear top USB-C mounts
assert len(LED_ANGLES) == D.N_LED and len(set(LED_ANGLES)) == D.N_LED
SCREWS = [(-32.0, 0.0), (32.0, 0.0)]
SCREW_DRILL, SCREW_KEEPOUT = 2.2, 2.5
RED_R0, RED_R1, RED_HALF_ANGLE = 22.0, 27.75, 46.0           # a degree more than the 45 measured, for the drawing's slightly off-radial cuts
FPC_XY, FPC_BAR = (0.0, -20.5), (11.6, 1.9)
ESP_XY = (8.0, 18.5)                                       # bare chip centre; separate SMT antenna at ANT_XY
USB_OVERHANG = 0.0                                          # mm of connector beyond the outline at x = 0
USB_BODY_W, USB_PAD_DEPTH = 8.94, 7.9                       # TE 2345986: 8.94 wide, 7.90 deep, front face aligned to the board apex; verify enclosure fit
TOP_LED_COUNT = 0
SLOTS = [(-27.4, 0.0), (27.4, 0.0)]; SLOT_W, SLOT_H = 1.5, 9.5
BATTERY_R, BATTERY_FLAT_Y = 24.9, 15.5
BRAND_Y = -22.5                                             # top side below this line (inside the ring) is kept clear for branding
EDGE_CLEAR = 1.2                                            # parts stay this far inside the outline
INNER_RING_LIMIT = 28.0                                     # parts stay inside this radius (the LEDs' inner edge is at about 28.5); the LED capacitors sit between the LEDs

# courtyard (w, h) in mm, centred on the part origin, at rotation 0
SIZE = {"R0402": (1.7, 1.1), "C0402": (1.7, 1.1), "L0402": (1.7, 1.1), "C0603": (2.3, 1.5), "CPOL7343": (8.0, 4.8), "L2016": (2.8, 2.3), "TP1MM": (1.4, 1.4),
        "XTAL2016": (2.5, 2.1), "ESP32C3_QFN32": (5.6,5.6), "ABM8_3225":(3.8,3.2), "JOHANSON_2450AT18D":(4.4,2.0), "HVQFN40_6X6": (7.3, 7.3), "TDFN8_2X2": (2.5, 2.5), "VQFN16_3X3": (3.6, 3.6),
        "VSON10_2X3": (2.6, 3.6), "TQFN16_3X3": (3.6, 3.6), "SOT23_6": (3.2, 3.4), "SOT23_5": (3.2, 3.4), "WS2812B_5050": (5.0, 5.0),
        "JST_S2B_PH_SM4_TB": (9.2, 10.2), "SPK_PADS": (19.5, 12.0), "FPC4_PLACEHOLDER": (4.5, 3.8),
        "USBC24_TE2345986": (USB_BODY_W, USB_PAD_DEPTH + USB_OVERHANG)}

def rect(x, y, rot, w, h):
    a = math.radians(rot); c, s = math.cos(a), math.sin(a)
    return [(x + (px * c - py * s), y + (px * s + py * c)) for px, py in ((-w / 2, -h / 2), (w / 2, -h / 2), (w / 2, h / 2), (-w / 2, h / 2))]

def overlap(a, b, gap=0.0):
    """Separating-axis test for two convex polygons, with a clearance."""
    for poly in (a, b):
        for i in range(len(poly)):
            x1, y1 = poly[i]; x2, y2 = poly[(i + 1) % len(poly)]
            nx, ny = y1 - y2, x2 - x1; n = math.hypot(nx, ny); nx, ny = nx / n, ny / n
            pa = [px * nx + py * ny for px, py in a]; pb = [px * nx + py * ny for px, py in b]
            if max(pa) + gap < min(pb) or max(pb) + gap < min(pa): return False
    return True

def samples(poly, n=8):
    pts = []
    for i in range(len(poly)):
        (x1, y1), (x2, y2) = poly[i], poly[(i + 1) % len(poly)]
        pts += [(x1 + (x2 - x1) * k / n, y1 + (y2 - y1) * k / n) for k in range(n)]
    cx = sum(p[0] for p in poly) / len(poly); cy = sum(p[1] for p in poly) / len(poly)
    return pts + [(cx + (px - cx) * f, cy + (py - cy) * f) for px, py in poly for f in (0.33, 0.66)] + [(cx, cy)]

def in_red(px, py, margin=0.3):
    r = math.hypot(px, py)
    if not (RED_R0 - margin <= r <= RED_R1 + margin): return False
    ang = abs(math.degrees(math.atan2(py, px)))
    return ang <= RED_HALF_ANGLE or ang >= 180 - RED_HALF_ANGLE

def red_polygons(step=3.0):
    """The two pedestal keep-outs as polygons (annular sectors) for the board file."""
    out = []
    for centre in (0.0, 180.0):
        a0, a1 = centre - RED_HALF_ANGLE, centre + RED_HALF_ANGLE
        n = int((a1 - a0) / step)
        outer = [(RED_R1 * math.cos(math.radians(a0 + (a1 - a0) * k / n)), RED_R1 * math.sin(math.radians(a0 + (a1 - a0) * k / n))) for k in range(n + 1)]
        inner = [(RED_R0 * math.cos(math.radians(a1 - (a1 - a0) * k / n)), RED_R0 * math.sin(math.radians(a1 - (a1 - a0) * k / n))) for k in range(n + 1)]
        out.append(outer + inner)
    return out

def violations(poly, kind, module=False):
    """Reasons a bottom-side part polygon is not allowed where it is ('ring' = LED capacitors, 'usb' = the connector, 'part' = anything else)."""
    why = []
    pts = samples(poly)
    if any(math.hypot(px - sx, py - sy) < SCREW_KEEPOUT + 0.3 for px, py in pts for sx, sy in SCREWS): why.append("screw")
    if any(in_red(px, py) for px, py in pts): why.append("pedestal keep-out")
    for sx, sy in SLOTS:
        if any(abs(px - sx) < SLOT_W / 2 + 0.4 and abs(py - sy) < SLOT_H / 2 + 0.4 for px, py in pts): why.append("slot"); break
    if kind == "part" and min(py for px, py in poly) < BRAND_Y: why.append("branding area")
    if kind == "part":
        if max(math.hypot(px, py) for px, py in poly) > INNER_RING_LIMIT and not module: why.append("outside R%.1f" % INNER_RING_LIMIT)
    return why

RING_CAP = (1.6, 0.8)                                       # 0402 courtyard for a capacitor squeezed between two LEDs

def positions():
    """ref -> dict(x, y, rot, mirror, kind). Deterministic: the same design gives the same layout."""
    pos, polys = {}, {}

    def put(ref, x, y, rot, mirror, kind="part", size=None):
        pkg = D.TYPES[D.INST[ref]["type"]]["pkg"]; w, h = size or SIZE[pkg]
        poly = rect(x, y, rot, w, h)
        pos[ref] = dict(x=x, y=y, rot=rot % 360, mirror=mirror, kind=kind)
        polys[ref] = (poly, mirror)
        return poly

    def free(poly, kind="part", gap=0.25, module=False, ref=None):
        if max(math.hypot(x,y) for x,y in poly)>R_OUT-(.3 if ref=="ANT1" else EDGE_CLEAR):return False
        module = module or ref in ANT_ZONE_ALLOWED
        if ref not in ANT_ZONE_ALLOWED and overlap(poly, ANT_CLEAR, gap):return False
        if violations(poly, kind, module): return False
        # Bottom-side USB-C mount slots are THROUGH the PCB; keep the top face clear too.
        for x in (-4.32,4.32):
            for y,w,h in ((R_OUT-7.25,2.7,2.7),(R_OUT-2.7,1.075,2.15)):
                if overlap(poly,rect(x,y,0,w,h),gap):return False
        return not any(not m and overlap(poly, p, gap) for r, (p, m) in polys.items())

    def search(ref, tx, ty, rots=(0.0, 90.0), kind="part", size=None, gap=0.25, maxr=32.0):
        pkg = D.TYPES[D.INST[ref]["type"]]["pkg"]; w, h = size or SIZE[pkg]
        for k in range(int(maxr / 0.4)):
            rad = k * 0.4
            n = 1 if k == 0 else max(8, int(rad * 6))
            for j in range(n):
                t = 2 * math.pi * j / n
                x, y = tx + rad * math.cos(t), ty + rad * math.sin(t)
                for rot in rots:
                    poly = rect(x, y, rot, w, h)
                    if free(poly, kind, gap,ref=ref):
                        put(ref, round(x, 2), round(y, 2), rot, False, kind, size); return True
        return False

    # --- fixed LEDs, FPC, and bottom USB-C
    for i, th in enumerate(LED_ANGLES, 1):
        a = math.radians(th)
        put(f"LED{i}", led_radius(i) * math.cos(a), led_radius(i) * math.sin(a), th + 90.0, False, "led")
    pos["J3"] = dict(x=FPC_XY[0], y=FPC_XY[1], rot=0.0, mirror=False, kind="fpc")
    polys["J3"] = (rect(FPC_XY[0], FPC_XY[1], 0, *SIZE["FPC4_PLACEHOLDER"]), False)
    pos["J1"] = dict(x=0.0, y=R_OUT, rot=0.0, mirror=True, kind="usb")
    polys["J1"] = (rect(0.0, R_OUT + (USB_OVERHANG - USB_PAD_DEPTH) / 2, 0, USB_BODY_W, USB_PAD_DEPTH + USB_OVERHANG), True)
    # Bare-chip placement is anchored again below with its clock and supply network.
    put("U1", ESP_XY[0], ESP_XY[1], 270.0, False)

    # --- all LED capacitors underneath their corresponding LEDs, outside the battery
    top4 = set(sorted(range(1, D.N_LED + 1), key=lambda i: abs(LED_ANGLES[i - 1] - 90))[:TOP_LED_COUNT])
    failed = []
    for i, th in enumerate(LED_ANGLES, 1):
        ref = f"C{100 + i}"; a = math.radians(th)
        if i not in top4:
            put(ref, led_radius(i) * math.cos(a), led_radius(i) * math.sin(a), th + 90.0, True, "ring", RING_CAP); continue
        placed = False
        for dth in (-6.0, 6.0, -3.2, 3.2):
            b = math.radians(th + dth); x, y = R_LED * math.cos(b), R_LED * math.sin(b)
            poly = rect(x, y, th + dth, *RING_CAP)
            if free(poly, "ring", 0.12): put(ref, round(x, 2), round(y, 2), th + dth, False, "ring", RING_CAP); placed = True; break
        if not placed: failed.append(ref)

    # --- everything else on the top side, in aligned rows grouped by function. row(y, refs, x0, dx): centres at x0, x0 + dx, ... all unrotated
    def row(y, refs, x0, dx):
        for k, ref in enumerate(refs): put(ref, round(x0 + dx * k, 2), y, 0.0, False)
    def at(ref, x, y, rot=0.0): put(ref, x, y, rot, False)
    def pack(y, refs, edge, direction=1, gap=0.4):
        """Parts of different widths side by side with an even gap, from `edge` going right (1) or left (-1)."""
        x = edge
        for ref in refs:
            w = SIZE[D.TYPES[D.INST[ref]["type"]]["pkg"]][0]
            put(ref, round(x + direction * w / 2, 2), y, 0.0, False); x += direction * (w + gap)
    # USB support above the connector's pads, and the LED rail, along the top
    pack(25.2, ["R4", "D1", "R5"], -4.7, 1, 1.0)
    pack(22.9, ["R6", "R7"], -1.9)
    pack(20.0, ["R21", "U8", "R20", "R19", "U7", "C31"], -1.9)
    at("J2", -9.5, 20.6)
    # the speaker pads between the two tall polymer capacitors, top edges level (owner's placement)
    at("C32", -10.4, 14.7); at("SPK1", 0.0, 13.85); at("C33", 10.5, 14.7)
    # audio: the amplifier under the left capacitor, its parts beside it
    at("U6", -11.2, 9.9); pack(9.5, ["R17", "R18", "C30", "C29"], -8.6)
    # gauge and I2C pull-ups
    at("U3", 0.0, -1.0); pack(2.2, ["R13", "R14", "C7"], -1.4)
    # power, right side: buck-boost and inductor, its capacitors and dividers, charger, charger parts
    at("U5", 11.0, 3.4); at("L1", 16.2, 3.4)
    pack(-0.2, ["C8", "C9", "C10", "R11", "R12"], 8.2)
    at("U4", 11.0, -4.0); pack(-4.0, ["R8", "R9", "R10"], 13.8)
    pack(-7.4, ["C5", "C6", "C4"], 8.2)
    # NFC: controller, crystal, its load capacitors, decoupling on the left, the antenna network in one row above the FPC connector
    at("U2", 2.0, -11.5); at("Y1", 9.0, -10.8); pack(-10.8, ["C20", "C21"], 10.7)
    pack(-8.8, ["C11", "C12", "C13", "C14", "C15"], -2.4, -1)
    pack(-11.1, ["C16", "C17", "C18", "C19", "R1"], -2.4, -1)
    pack(-13.4, ["TP1", "TP2", "TP3", "TP4", "TP5", "TP6"], -2.4, -1)
    pack(-15.7, ["C1", "C2", "R3", "C3"], -2.4, -1)
    pack(-17.4, ["L2", "C22", "C24", "C26", "C27", "R15", "R16", "C28", "C25", "C23", "L3"], -10.6)
    # Repack using actual large-body envelopes, preserving the mechanical constraints.
    # The speaker is mounted ON the PCB with adhesive and hand-soldered short leads.
    # This part is not specified as a reflow SMT speaker.
    old = {r:dict(p) for r,p in pos.items()}
    fixed = {r for r,p in pos.items() if p["kind"] in ("led","ring","usb","fpc")}
    for r in list(pos):
        if r not in fixed: del pos[r]; del polys[r]
    anchors = [("ANT1",*ANT_XY,0.0),("U1",*ESP_XY,270.0),("Y2",14.5,19.8,0.0),
               ("SPK1",0.0,0.0,0.0),("J2",-3.0,19.5,0.0),("C32",-10.0,10.0,0.0),("C33",10.0,10.0,0.0)]
    for ref,x,y,rot in anchors:
        w,h=SIZE[D.TYPES[D.INST[ref]["type"]]["pkg"]]
        poly=rect(x,y,rot,w,h)
        if not free(poly,"part",.25,module=(ref in ("U1","ANT1")),ref=ref):
            if ref=="Y2" and search(ref,x,y,rots=(rot,90),maxr=3):continue
            raise ValueError("large-part anchor conflicts: "+ref)
        put(ref,x,y,rot,False)
    # Lock short clock/RF/power component groups before packing the remaining functions.
    close = {"L5":(11.5,15.8,0),"C40":(14.5,15.8,0),"C41":(17.0,19.3,90),
             "L6":(9.75,23.0,90),"C42":(11.8,21.6,0),"C43":(7.5,23.5,0),
             "R22":(6.5,27.3,90),"C44":(8.3,27.0,0),"C45":(6.5,29.25,90),"R23":(12.6,31.95,0),
             "L4":(5.0,20.25,90),"C34":(4.0,18.5,90),"C35":(6.0,15.1,0),"C36":(10.0,15.1,0),
             "C37":(9.0,14.8,0),"C38":(11.7,19.8,90),"C39":(11.7,17.8,90)}
    for ref,(x,y,rot) in close.items():
        w,h=SIZE[D.TYPES[D.INST[ref]["type"]]["pkg"]]; poly=rect(x,y,rot,w,h)
        if free(poly,"part",.25,ref=ref):put(ref,x,y,rot,False)
        elif not search(ref,x,y,rots=(rot,(rot+90)%360),maxr=5):failed.append(ref)
    pending = [r for r in old if r not in pos]
    pending.sort(key=lambda r: -math.prod(SIZE[D.TYPES[D.INST[r]["type"]]["pkg"]]))
    for ref in pending:
        p=old[ref];w,h=SIZE[D.TYPES[D.INST[ref]["type"]]["pkg"]]
        poly=rect(p["x"],p["y"],p["rot"],w,h)
        if free(poly,"part",.25,ref=ref):put(ref,p["x"],p["y"],p["rot"],False)
        elif not search(ref,p["x"],p["y"],rots=(p["rot"],(p["rot"]+90)%360),maxr=40):
            failed.append(ref)

    rest = [r for r in D.INST if r not in pos]
    return pos, polys, dict(failed=failed, unplaced=rest, top4=sorted(top4))

def check():
    pos, polys, info = positions()
    errs = []
    if info["failed"]: errs.append(f"could not place {info['failed']}")
    if info["unplaced"]: errs.append(f"not placed {info['unplaced']}")
    for r, p in pos.items():
        poly, mirror = polys[r]
        kind = p["kind"]
        if kind in ("part", "ring"):
            why = violations(poly, "part" if kind == "part" else "ring", module=(r in ({"U1"}|ANT_ZONE_ALLOWED)))
            if why: errs.append(f"{r}: {', '.join(why)}")
            if max(math.hypot(x, y) for x, y in poly) > R_OUT - (0.3 if r=="ANT1" else EDGE_CLEAR) + 0.01: errs.append(f"{r}: too close to the outline")
    for r,(poly,mir) in polys.items():
        if r not in ANT_ZONE_ALLOWED and overlap(poly,ANT_CLEAR,0):errs.append(f"{r} enters antenna clearance")
    if min(y for x,y in ANT_CLEAR) <= BATTERY_FLAT_Y:errs.append("antenna clearance reaches battery")
    refs = list(polys)
    for i, a in enumerate(refs):
        for b in refs[i + 1:]:
            if polys[a][1] == polys[b][1] and overlap(polys[a][0], polys[b][0], 0.0): errs.append(f"{a} overlaps {b}")
    for r, (poly, mirror) in polys.items():
        if mirror and r != "J1":
            if not (pos[r]["kind"] == "ring" and r.startswith("C1")): errs.append(f"{r} is on the bottom, where the battery is")
            elif min(math.hypot(x, y) for x, y in poly) < BATTERY_R + 1.0: errs.append(f"{r} is under the battery")
    for i in info["top4"]:
        if any(mirror and r != "J1" and overlap(polys[f"LED{i}"][0], poly, 0.0) for r, (poly, mirror) in polys.items()): errs.append(f"something is under top LED{i}")
    return errs, pos, polys, info

if __name__ == "__main__":
    errs, pos, polys, info = check()
    for e in errs: print("ERROR", e)
    print("layout OK" if not errs else f"{len(errs)} problems")
