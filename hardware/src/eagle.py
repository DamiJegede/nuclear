"""Generate Eagle/Fusion source from design.py and layout.py. Explicit supplier-derived and prototype land patterns are in landpatterns.json. Review fabrication limits in design/rf-redesign.md."""
import math
import routing
from xml.sax.saxutils import escape, quoteattr
import design as D
import layout as L

LAYERS = [(2,"Route2",1,1,"yes","yes"),(15,"Route15",3,1,"yes","yes"),(1, "Top", 4, 1, "yes", "yes"), (16, "Bottom", 1, 1, "yes", "yes"), (17, "Pads", 2, 1, "yes", "yes"), (18, "Vias", 2, 1, "yes", "yes"), (19, "Unrouted", 6, 1, "yes", "yes"),
          (20, "Dimension", 15, 1, "yes", "yes"), (21, "tPlace", 7, 1, "yes", "yes"), (22, "bPlace", 7, 1, "yes", "yes"), (25, "tNames", 7, 1, "yes", "yes"), (26, "bNames", 7, 1, "yes", "yes"),
          (27, "tValues", 7, 1, "yes", "yes"), (28, "bValues", 7, 1, "yes", "yes"), (29, "tStop", 7, 3, "no", "yes"), (30, "bStop", 7, 6, "no", "yes"), (31, "tCream", 7, 4, "no", "yes"),
          (32, "bCream", 7, 5, "no", "yes"), (39, "tKeepout", 4, 11, "yes", "yes"), (40, "bKeepout", 1, 11, "yes", "yes"), (41, "tRestrict", 4, 10, "yes", "yes"), (42, "bRestrict", 1, 10, "yes", "yes"),
          (43, "vRestrict", 2, 10, "yes", "yes"), (44, "Drills", 7, 1, "no", "yes"), (45, "Holes", 7, 1, "no", "yes"), (46, "Milling", 3, 1, "yes", "yes"), (51, "tDocu", 7, 1, "yes", "yes"), (52, "bDocu", 7, 1, "yes", "yes"),
          (91, "Nets", 2, 1, "yes", "yes"), (92, "Busses", 1, 1, "yes", "yes"), (93, "Pins", 2, 1, "no", "yes"), (94, "Symbols", 4, 1, "yes", "yes"), (95, "Names", 7, 1, "yes", "yes"),
          (96, "Values", 7, 1, "yes", "yes"), (97, "Info", 7, 1, "yes", "yes"), (98, "Guide", 6, 1, "yes", "yes")]

NET_CLASSES_XML = '<classes><class number="0" name="signal" width="0.15" drill="0.2"/><class number="1" name="power" width="0.15" drill="0.2"/><class number="2" name="LED-power" width="0.15" drill="0.2"/><class number="3" name="3V3" width="0.15" drill="0.2"/><class number="4" name="RF" width="0.15" drill="0.2"/><class number="5" name="USB" width="0.15" drill="0.2"/></classes>'
def net_class(n):
    if n in {"VSYS","VBAT","VBUS"}:return 1
    if n=="VLED":return 2
    if n in {"3V3","ESP_VDD_RF"}:return 3
    if n in {"ESP_RF_CHIP","RF_50OHM","ANT_FEED","ANT_GND_TUNE"}:return 4
    if n.startswith("USB_D"):return 5
    return 0

def f(v): return f"{v:.4f}".rstrip("0").rstrip(".") if abs(v) > 1e-9 else "0"
def wire(x1, y1, x2, y2, w, layer): return f'<wire x1="{f(x1)}" y1="{f(y1)}" x2="{f(x2)}" y2="{f(y2)}" width="{f(w)}" layer="{layer}"/>'
def rect_wires(x1, y1, x2, y2, w, layer): return [wire(x1, y1, x2, y1, w, layer), wire(x2, y1, x2, y2, w, layer), wire(x2, y2, x1, y2, w, layer), wire(x1, y2, x1, y1, w, layer)]
def smd(name, x, y, dx, dy, rot=None, cream=True):
    return f'<smd name={quoteattr(str(name))} x="{f(x)}" y="{f(y)}" dx="{f(dx)}" dy="{f(dy)}" layer="1"' + (f' rot="R{rot}"' if rot else "") + ("" if cream else ' cream="no"') + "/>"
def label_texts(h): return [f'<text x="{f(-h)}" y="{f(h + 0.8)}" size="0.8" layer="25">&gt;NAME</text>', f'<text x="{f(-h)}" y="{f(-h - 1.6)}" size="0.8" layer="27">&gt;VALUE</text>']

# ---- packages: name -> (description, [elements]) -------------------------------------------------------------------------------
PK = {}
def two_pad(name, desc, cx, pw, ph, bw, bh, dock=True):
    el = [smd(1, -cx, 0, pw, ph), smd(2, cx, 0, pw, ph)] + rect_wires(-bw / 2, -bh / 2, bw / 2, bh / 2, 0.1, 51) + label_texts(max(bw, bh) / 2 + 0.3)
    PK[name] = (desc, el)

two_pad("R0402", "0402 chip, IPC nominal", 0.5, 0.6, 0.6, 1.0, 0.5)
two_pad("C0402", "0402 chip, IPC nominal", 0.5, 0.6, 0.6, 1.0, 0.5)
two_pad("L0402", "0402 chip, IPC nominal", 0.5, 0.6, 0.6, 1.0, 0.5)
two_pad("C0603", "0603 chip, IPC nominal", 0.8, 0.9, 0.95, 1.6, 0.8)
two_pad("L2016", "2.0 x 1.6 mm power inductor, generic land pattern (replace with the chosen part's)", 0.95, 1.0, 1.6, 2.0, 1.6)
two_pad("CPOL7343", "7343 (D case) polymer/tantalum, generic land pattern", 3.0, 2.4, 2.4, 7.3, 4.3)
two_pad("SPK_PADS", "CMS-151103-088SP board-mounted 15 x 11 mm body; adhesive mounting and short hand-soldered leads to accessible pads, not reflow SMT", 8.5, 1.5, 2.0, 15.0, 11.0)
PK["TP1MM"] = ("1 mm test pad", [smd(1, 0, 0, 1.0, 1.0, cream=False)] + label_texts(1.0))
PK["XTAL2016"] = ("2.0 x 1.6 mm 4-pad crystal, generic land pattern (replace with the chosen crystal's)",
    [smd(1, -0.7, -0.55, 0.9, 0.7), smd(2, 0.7, -0.55, 0.9, 0.7), smd(3, 0.7, 0.55, 0.9, 0.7), smd(4, -0.7, 0.55, 0.9, 0.7)] + rect_wires(-1, -0.8, 1, 0.8, 0.1, 51) + label_texts(1.2))
PK["WS2812B_5050"] = ("WS2812B 5050 4-pad PLCC (KiCad-style pad order: 1 VDD top-left, 2 DOUT bottom-left, 3 GND bottom-right, 4 DIN top-right). VERIFY against the datasheet and revision",
    [smd(1, -2.45, 1.6, 1.5, 0.9), smd(2, -2.45, -1.6, 1.5, 0.9), smd(3, 2.45, -1.6, 1.5, 0.9), smd(4, 2.45, 1.6, 1.5, 0.9)] + rect_wires(-2.5, -2.5, 2.5, 2.5, 0.1, 51) + [wire(-2.5, 2.5, 2.5, 2.5, 0.12, 21), wire(-2.5, -2.5, 2.5, -2.5, 0.12, 21)]
    + [wire(-2.5, 2.5, -1.5, 2.5, 0.3, 21)] + label_texts(3.2))

def qfn(name, desc, body, pitch, per_side, pw, pl, ep=None, sides=4):
    """Pads counter-clockwise from the top of the left side. `per_side` pads on each used side."""
    el, n, h = [], 1, body / 2
    off = h + 0.1            # pad centre
    span = (per_side - 1) * pitch / 2
    for side in range(sides):
        for i in range(per_side):
            p = -span + i * pitch
            # side 0 left (top to bottom), 1 bottom (left to right), 2 right (bottom to top), 3 top (right to left)
            if side == 0: x, y, dx, dy = -off, span - i * pitch, pl, pw
            elif side == 1: x, y, dx, dy = p, -off, pw, pl
            elif side == 2: x, y, dx, dy = off, -span + i * pitch, pl, pw
            else: x, y, dx, dy = span - i * pitch, off, pw, pl
            el.append(smd(n, x, y, dx, dy)); n += 1
    if ep: el.append(smd(n, 0, 0, ep[0], ep[1], cream=False))
    el += rect_wires(-h, -h, h, h, 0.1, 51) + [wire(-h, h - 0.6, -h + 0.6, h, 0.1, 21)] + label_texts(h + 0.5)
    PK[name] = (desc, el)

qfn("HVQFN40_6X6", "HVQFN40 6 x 6 mm, 0.5 mm pitch, exposed pad 4.5 x 4.5 (SOT618-1). IPC-style pads: verify against the NXP land pattern", 6.0, 0.5, 10, 0.25, 0.85, (4.5, 4.5))
qfn("VQFN16_3X3", "VQFN-16 (RGT) 3 x 3 mm, 0.5 mm pitch, exposed pad 1.7 x 1.7. IPC-style pads: verify against the TI land pattern", 3.0, 0.5, 4, 0.28, 0.6, (1.7, 1.7))
qfn("TQFN16_3X3", "TQFN-16 3 x 3 mm, 0.5 mm pitch, exposed pad 1.7 x 1.7. IPC-style pads: verify against the Analog Devices land pattern", 3.0, 0.5, 4, 0.28, 0.6, (1.7, 1.7))

def dual(name, desc, bx, by, pitch, per_side, pw, pl, ep=None):
    """Two-sided leadless: pads 1.. down the left side, then up the right side."""
    el, n = [], 1
    span = (per_side - 1) * pitch / 2
    for i in range(per_side): el.append(smd(n, -bx / 2 + 0.05, span - i * pitch, pl, pw)); n += 1
    for i in range(per_side): el.append(smd(n, bx / 2 - 0.05, -span + i * pitch, pl, pw)); n += 1
    if ep: el.append(smd(n, 0, 0, ep[0], ep[1], cream=False))
    el += rect_wires(-bx / 2, -by / 2, bx / 2, by / 2, 0.1, 51) + [wire(-bx / 2, by / 2 - 0.4, -bx / 2 + 0.4, by / 2, 0.1, 21)] + label_texts(max(bx, by) / 2 + 0.5)
    PK[name] = (desc, el)

dual("TDFN8_2X2", "TDFN-8 2 x 2 mm, 0.5 mm pitch, exposed pad. IPC-style pads: verify against the Analog Devices land pattern (pad 9 = EP)", 2.0, 2.0, 0.5, 4, 0.28, 0.55, (0.9, 1.5))
dual("VSON10_2X3", "VSON-10 (DLA) 2.5 x 3.0 mm, 0.5 mm pitch, exposed pad (pad 11 = EP). IPC-style pads: verify against the TI land pattern", 2.5, 3.0, 0.5, 5, 0.28, 0.6, (1.2, 2.0))

def sot(name, desc, n):
    el = []
    xs = [-0.95, 0, 0.95]
    for i in range(3): el.append(smd(i + 1, xs[i], -1.25, 0.6, 1.1))              # bottom row, left to right
    top = [0.95, 0, -0.95] if n == 6 else [0.95, -0.95]
    for i, x in enumerate(top): el.append(smd(4 + i, x, 1.25, 0.6, 1.1))           # top row, right to left
    el += rect_wires(-1.5, -0.8, 1.5, 0.8, 0.1, 51) + label_texts(2.2)
    PK[name] = (desc, el)
sot("SOT23_6", "SOT-23-6, 0.95 mm pitch (JEDEC MO-178), generic land pattern", 6)
sot("SOT23_5", "SOT-23-5, 0.95 mm pitch (JEDEC MO-178), generic land pattern", 5)

# placeholders: pad NAMES are right, geometry is not
def ph(name, desc, w, h, pads, cols=None):
    el = [smd(p, x, y, 0.6, 0.6) for p, x, y in pads] + rect_wires(-w / 2, -h / 2, w / 2, h / 2, 0.15, 51)
    el += [f'<text x="{f(-w / 2)}" y="{f(h / 2 + 0.5)}" size="0.8" layer="51">PLACEHOLDER</text>'] + label_texts(max(w, h) / 2 + 2)
    PK[name] = (desc, el)

def ring_pads(names, w, h):
    n, out = len(names), []
    per = math.ceil(n / 3)
    for k, nm in enumerate(names):
        side, i = divmod(k, per)
        if side == 0: out.append((nm, -w / 2, h / 2 - 1.0 - i * 0.9))
        elif side == 1: out.append((nm, -w / 2 + 1.0 + i * 0.9, -h / 2))
        else: out.append((nm, w / 2, -h / 2 + 1.0 + i * 0.9))
    return out
esp = [str(i) for i in range(1, 36)]
ph("ESP32C3MINI1_PLACEHOLDER", "ESP32-C3-MINI-1: 13.2 x 16.6 mm module, 53 pads. PLACEHOLDER pad geometry: replace with the Espressif land pattern (datasheet figure 11-1). Keep the antenna keep-out clear", 13.2, 16.6,
   ring_pads(esp, 13.2, 16.6) + [(str(36 + k), -3.0 + (k % 6) * 1.2, -2.0 + (k // 6) * 1.2) for k in range(18)])
def usb_overhang():
    """TE 2345986-1: origin on the board edge line, +y = out of the board (the front). Pad NAMES follow the TE drawing's pin table; the geometry is read from the drawing
    (0.5 mm pitch rows 0.25 mm apart across 5.5 mm, shell tabs at the corners) and must be replaced with TE's footprint before fabrication."""
    d = L.USB_PAD_DEPTH; w = L.USB_BODY_W; o = L.USB_OVERHANG
    a_pads = ["A12", "A11", "A10", "A9", "A8", "A7", "A6", "A5", "A4", "A3", "A2", "A1"]    # left to right as drawn from the component side
    b_pads = ["B1", "B2", "B3", "B4", "B5", "B6", "B7", "B8", "B9", "B10", "B11", "B12"]
    y_rear = -d + 0.7
    pads = [(n, -2.75 + 0.5 * i, y_rear) for i, n in enumerate(a_pads)] + [(n, -2.5 + 0.5 * i, y_rear + 0.8) for i, n in enumerate(b_pads)]
    pads += [("S1", -4.0, y_rear + 0.2), ("S2", 4.0, y_rear + 0.2), ("S3", -3.4, y_rear + 3.2), ("S4", 3.4, y_rear + 3.2)]
    el = [smd(p, x, y, 0.3, 0.7) for p, x, y in pads] + rect_wires(-w / 2, -d, w / 2, o, 0.15, 51)
    el += [wire(-w / 2, 0, w / 2, 0, 0.15, 51), f'<text x="{f(-w / 2)}" y="{f(o + 0.6)}" size="0.8" layer="51">FRONT +{o:g} mm beyond the board edge. PAD GEOMETRY APPROXIMATE</text>'] + label_texts(7.0)
    PK["USBC24_TE2345986"] = (f"TE 2345986-1 USB-C 24-pad receptacle, front {o:g} mm beyond the board edge (origin on the edge line, +y out). Pad names from the TE drawing, geometry approximate: replace with TE's footprint", el)
usb_overhang()
ph("JST_S2B_PH_SM4_TB", "JST S2B-PH-SM4-TB 2.0 mm pitch battery header. PLACEHOLDER pad geometry: replace with the JST drawing", 7.0, 5.0, [("1", -1.0, 0), ("2", 1.0, 0), ("S1", -3.4, 1.5), ("S2", 3.4, 1.5)])
ph("FPC4_PLACEHOLDER", "4-position 0.5 mm SMT FPC connector, tail enters from +y (the mouth faces +y). The 11.6 x 1.9 mm bar on tDocu is the owner's tail zone. PLACEHOLDER pad geometry: replace once the connector is chosen", 6.0, 3.0, [("1", -0.75, 0), ("2", -0.25, 0), ("3", 0.25, 0), ("4", 0.75, 0), ("M1", -2.5, 0.5), ("M2", 2.5, 0.5)])

import landpatterns
landpatterns.apply(PK, smd, rect_wires, label_texts)

# ---- symbols ---------------------------------------------------------------------------------------------------------------------
def sym_geom(t):
    L = [p for p in t["pins"] if p[2] == "L"]; R = [p for p in t["pins"] if p[2] == "R"]
    big = len(t["pins"]) > 2
    hw = 7.62 if big else 2.54
    k = max(1, math.ceil((max(len(L), len(R)) + 1) / 2))
    return L, R, hw, 2.54 * k

def pin_xy(t, pinname):
    L, R, hw, hh = sym_geom(t)
    for lst, side in ((L, "L"), (R, "R")):
        for i, p in enumerate(lst):
            if p[0] == pinname:
                y = hh - 2.54 * (i + 1)
                return (-(hw + 5.08) if side == "L" else hw + 5.08), y, side
    raise KeyError(pinname)

def symbol_xml(key, t):
    L, R, hw, hh = sym_geom(t)
    out = [f'<symbol name={quoteattr(key)}>'] + rect_wires(-hw, -hh, hw, hh, 0.254, 94)
    for lst, side in ((L, "L"), (R, "R")):
        for i, p in enumerate(lst):
            x, y, _ = pin_xy(t, p[0])
            out.append(f'<pin name={quoteattr(p[0])} x="{f(x)}" y="{f(y)}" visible="pin" length="middle" direction="pas"' + (' rot="R180"' if side == "R" else "") + "/>")
    out.append(f'<text x="{f(-hw)}" y="{f(hh + 1.27)}" size="1.778" layer="95">&gt;NAME</text>')
    out.append(f'<text x="{f(-hw)}" y="{f(-hh - 3.81)}" size="1.778" layer="96">&gt;VALUE</text>')
    out.append("</symbol>")
    return out

def library_xml(packages_only=False):
    out = ['<library name="orb">', "<description>Orb main board parts: symbols from the datasheets, packages generic or PLACEHOLDER (see hardware/README.md)</description>", "<packages>"]
    used = {t["pkg"] for t in D.TYPES.values()}
    for name in sorted(used):
        desc, el = PK[name]
        out += [f'<package name={quoteattr(name)}>', f"<description>{escape(desc)}</description>"] + el + ["</package>"]
    out.append("</packages>")
    if not packages_only:
        out.append("<symbols>")
        for key, t in D.TYPES.items(): out += symbol_xml(key, t)
        out.append("</symbols><devicesets>")
        for key, t in D.TYPES.items():
            out.append(f'<deviceset name={quoteattr(key)} prefix={quoteattr(t["prefix"])}><description>{escape(t["desc"])}</description><gates><gate name="G$1" symbol={quoteattr(key)} x="0" y="0"/></gates><devices>')
            out.append(f'<device name="" package={quoteattr(t["pkg"])}><connects>')
            for p in t["pins"]: out.append(f'<connect gate="G$1" pin={quoteattr(p[0])} pad={quoteattr(" ".join(p[1]))}/>')
            out.append('</connects><technologies><technology name=""/></technologies></device></devices></deviceset>')
        out.append("</devicesets>")
    out.append("</library>")
    return out

HEADER = ['<?xml version="1.0" encoding="utf-8"?>', '<!DOCTYPE eagle SYSTEM "eagle.dtd">', '<eagle version="9.6.2">', "<drawing>",
          '<settings><setting alwaysvectorfont="no"/><setting verticaltext="up"/></settings>',
          '<grid distance="0.1" unitdist="inch" unit="inch" style="lines" multiple="1" display="no" altdistance="0.01" altunitdist="inch" altunit="inch"/>', "<layers>"] + \
         [f'<layer number="{n}" name="{nm}" color="{c}" fill="{fl}" visible="{v}" active="{a}"/>' for n, nm, c, fl, v, a in LAYERS] + ["</layers>"]

def write_lbr(path):
    lib = library_xml()
    lib[0] = "<library>"          # a .lbr drawing holds an unnamed library
    open(path, "w").write("\n".join(HEADER + lib + ["</drawing>", "</eagle>"]) + "\n")

# ---- schematic --------------------------------------------------------------------------------------------------------------------
GROUPS = ["mcu", "rf", "usb", "power", "i2c", "nfc", "audio", "led", "ring"]

def schematic_layout():
    """ref -> (x, y): blocks by function, left to right within a row of groups, each part in a grid cell."""
    pos, y = {}, 0.0
    for g in GROUPS:
        refs = [r for r, i in D.INST.items() if i["group"] == g]
        if not refs: continue
        cols = 14 if g == "ring" else 6
        x, rowh, col = 0.0, 0.0, 0
        for r in refs:
            t = D.TYPES[D.INST[r]["type"]]
            L, Rr, hw, hh = sym_geom(t)
            wcell = 2 * (hw + 5.08 + 5.08) + 7.62
            if col == cols: x, y, rowh, col = 0.0, y - rowh - 15.24, 0.0, 0
            pos[r] = (x + wcell / 2, y - hh - 5.08)
            x += wcell; rowh = max(rowh, 2 * hh + 10.16); col += 1
        y -= rowh + 30.48
    return pos

def write_sch(path):
    pos = schematic_layout()
    out = HEADER + ['<schematic xreflabel="%F%N/%S.%C%R" xrefpart="/%S.%C%R">', "<libraries>"] + library_xml() + ["</libraries>", "<attributes/>", "<variantdefs/>",
         NET_CLASSES_XML, "<parts>"]
    for r, i in D.INST.items():
        t = D.TYPES[i["type"]]
        out.append(f'<part name={quoteattr(r)} library="orb" deviceset={quoteattr(i["type"])} device="" value={quoteattr(i["value"])}/>')
    out += ["</parts>", "<sheets><sheet>", "<plain>", '<text x="0" y="20" size="3" layer="97">Orb main board: generated from hardware/src/design.py, do not edit by hand</text>', "</plain>", "<instances>"]
    for r in D.INST:
        x, y = pos[r]
        out.append(f'<instance part={quoteattr(r)} gate="G$1" x="{f(x)}" y="{f(y)}"/>')
    out += ["</instances>", "<busses/>", "<nets>"]
    segs = {}
    for r, i in D.INST.items():
        t = D.TYPES[i["type"]]
        for pin, net in i["nets"].items():
            px, py, side = pin_xy(t, pin)
            x0, y0 = pos[r][0] + px, pos[r][1] + py
            x1 = x0 + (-5.08 if side == "L" else 5.08)
            segs.setdefault(net, []).append(
                f'<segment><pinref part={quoteattr(r)} gate="G$1" pin={quoteattr(pin)}/>{wire(x0, y0, x1, y0, 0.1524, 91)}'
                f'<label x="{f(x1)}" y="{f(y0)}" size="1.27" layer="95" rot="R0" xref="no"/></segment>')
    for net, s in segs.items():
        if len(s) < 2 and "NC" in net: continue          # a single-pin "no connect" marker is not a net
        out.append(f"<net name={quoteattr(net)} class=\"{net_class(net)}\">" + "".join(s) + "</net>")
    out += ["</nets>", "</sheet></sheets>", "</schematic>", "</drawing>", "</eagle>"]
    open(path, "w").write("\n".join(out) + "\n")

# ---- board ------------------------------------------------------------------------------------------------------------------------
R_OUT = L.R_OUT

def board_positions():
    """ref -> (x, y, rot, mirrored), from layout.py (which also checks keep-outs and overlaps)."""
    errs, pos, polys, info = L.check()
    if errs: raise SystemExit("layout problems:\n" + "\n".join(errs))
    return {r: (p["x"], p["y"], p["rot"], p["mirror"]) for r, p in pos.items()}

def write_brd(path):
    pos = board_positions()
    plain = [f'<circle x="0" y="0" radius="{R_OUT}" width="0.254" layer="20"/>']
    for sx, sy in L.SCREWS:
        plain += [f'<hole x="{f(sx)}" y="{f(sy)}" drill="{L.SCREW_DRILL}"/>', f'<circle x="{f(sx)}" y="{f(sy)}" radius="{L.SCREW_KEEPOUT}" width="0.1" layer="51"/>']
        for lay in (41, 42): plain.append(f'<polygon width="0.1" layer="{lay}">' + "".join(f'<vertex x="{f(sx + L.SCREW_KEEPOUT * math.cos(math.radians(a)))}" y="{f(sy + L.SCREW_KEEPOUT * math.sin(math.radians(a)))}"/>' for a in range(0, 360, 20)) + "</polygon>")
    for poly in L.red_polygons():                       # the pedestal's feet: no parts or copper on either side
        for lay in (41, 42, 43): plain.append(f'<polygon width="0.1" layer="{lay}">' + "".join(f'<vertex x="{f(x)}" y="{f(y)}"/>' for x, y in poly) + "</polygon>")
        plain += [wire(*poly[i], *poly[(i + 1) % len(poly)], 0.1, 51) for i in range(len(poly))]
    for sx, sy in L.SLOTS:                               # milled slots for the pedestal tabs (board outline layer)
        hw, hh = L.SLOT_W / 2, L.SLOT_H / 2 - L.SLOT_W / 2
        plain += [wire(sx + hw, sy - hh, sx + hw, sy + hh, 0.254, 20), wire(sx - hw, sy - hh, sx - hw, sy + hh, 0.254, 20),
                  f'<wire x1="{f(sx + hw)}" y1="{f(sy + hh)}" x2="{f(sx - hw)}" y2="{f(sy + hh)}" width="0.254" layer="20" curve="180"/>',
                  f'<wire x1="{f(sx - hw)}" y1="{f(sy - hh)}" x2="{f(sx + hw)}" y2="{f(sy - hh)}" width="0.254" layer="20" curve="180"/>']
    plain += [wire(*L.ANT_CLEAR[i],*L.ANT_CLEAR[(i+1)%len(L.ANT_CLEAR)],0.1,51) for i in range(len(L.ANT_CLEAR))]
    plain.append(f'<circle x="0" y="0" radius="{L.BATTERY_R}" width="0.1" layer="52"/>')       # battery outline (glued under the board), documentation
    plain.append(wire(-math.sqrt(L.BATTERY_R ** 2 - L.BATTERY_FLAT_Y ** 2), L.BATTERY_FLAT_Y, math.sqrt(L.BATTERY_R ** 2 - L.BATTERY_FLAT_Y ** 2), L.BATTERY_FLAT_Y, 0.1, 52))
    plain.append(wire(-14, L.BRAND_Y, 14, L.BRAND_Y, 0.1, 51)); plain.append(f'<text x="-9" y="{f(L.BRAND_Y - 3)}" size="1.5" layer="51">BRANDING AREA (keep clear)</text>')
    bw, bh = L.FPC_BAR
    plain += rect_wires(L.FPC_XY[0] - bw / 2, L.FPC_XY[1] - bh / 2, L.FPC_XY[0] + bw / 2, L.FPC_XY[1] + bh / 2, 0.1, 51)
    plain += [f'<circle x="0" y="0" radius="{L.R_LED}" width="0.1" layer="51"/>',
              '<text x="-20" y="-39" size="1.0" layer="51">ORB 69 mm - ENGINEERING DRAFT</text>']
    out = HEADER + ["<board>", "<plain>"] + plain + ["</plain>", "<libraries>"] + library_xml(packages_only=True) + ["</libraries>", "<attributes/>", "<variantdefs/>", NET_CLASSES_XML, '<designrules name="Orb Rev D - four layers"><description language="en">Preliminary: 0.127 mm copper clearance, 0.25 mm edge clearance. Confirm with fabricator before release.</description><param name="layerSetup" value="(1+2*15+16)"/><param name="mtCopper" value="0.035mm 0.0152mm 0.035mm 0.035mm 0.035mm 0.035mm 0.035mm 0.035mm 0.035mm 0.035mm 0.035mm 0.035mm 0.035mm 0.035mm 0.0152mm 0.035mm"/><param name="mtIsolate" value="0.2104mm 1.065mm 0.2104mm 0.15mm 0.2mm 0.15mm 0.2mm 0.15mm 0.2mm 0.15mm 0.2mm 0.15mm 0.2mm 0.15mm 0.2mm"/><param name="mdWireWire" value="5mil"/><param name="mdWirePad" value="5mil"/><param name="mdWireVia" value="5mil"/><param name="mdPadPad" value="5mil"/><param name="mdPadVia" value="5mil"/><param name="mdViaVia" value="5mil"/><param name="mdSmdPad" value="5mil"/><param name="mdSmdVia" value="5mil"/><param name="mdSmdSmd" value="5mil"/><param name="mdCopperDimension" value="0.25mm"/><param name="msWidth" value="0.15mm"/><param name="msDrill" value="0.3mm"/><param name="rlMinViaOuter" value="0.2mm"/><param name="rlMinViaInner" value="0.2mm"/><param name="mlMinStopFrame" value="0.04mm"/><param name="mlMaxStopFrame" value="0.04mm"/></designrules>', "<elements>"]
    for r, i in D.INST.items():
        x, y, rot, mir = pos[r]
        rr = f'{"M" if mir else ""}R{f(rot)}'
        out.append(f'<element name={quoteattr(r)} library="orb" package={quoteattr(D.TYPES[i["type"]]["pkg"])} value={quoteattr(i["value"])} x="{f(x)}" y="{f(y)}" rot="{rr}"/>')
    out += ["</elements>", "<signals>"]
    sig = {}
    for r, i in D.INST.items():
        t = D.TYPES[i["type"]]
        pads = {p[0]: p[1] for p in t["pins"]}
        for pin, net in i["nets"].items():
            for pad in pads[pin]: sig.setdefault(net, []).append((r, pad))
    for net, refs in sig.items():
        if len(refs) < 2: continue
        extra = ""
        if net == "GND":
            for layer in (1,2,15,16):
                extra += f'<polygon width="0.1" layer="{layer}" pour="cutout">'+"".join(f'<vertex x="{f(x)}" y="{f(y)}"/>' for x,y in L.ANT_CLEAR)+"</polygon>"
        # Full inner ground plane; upper/lower pours help short local ground returns.
        if net == "GND":
            for layer in (1,2,16):
                verts=[(34.1*math.cos(2*math.pi*k/72),34.1*math.sin(2*math.pi*k/72)) for k in range(72)]
                extra += f'<polygon width="0.2" layer="{layer}" isolate="0.127" thermals="yes" orphans="no" rank="6">'+"".join(f'<vertex x="{f(x)}" y="{f(y)}"/>' for x,y in verts)+"</polygon>"
        out.append(f'<signal name={quoteattr(net)} class="{net_class(net)}">' + "".join(f'<contactref element={quoteattr(r)} pad={quoteattr(p)}/>' for r, p in refs) + extra + "</signal>")
    out += ["</signals>", "</board>", "</drawing>", "</eagle>"]
    open(path, "w").write("\n".join(out) + "\n")
    routing.apply(path)
