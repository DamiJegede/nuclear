#!/usr/bin/env python3
"""Checks the design, then writes everything under hardware/: the Fusion files, the BOM and the pin plan.   python3 hardware/src/build.py"""
import csv, os, re, subprocess, sys
from collections import OrderedDict, defaultdict
HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)
import design as D, eagle

if subprocess.call([sys.executable, os.path.join(HERE, "check.py")]) != 0: sys.exit(1)
os.makedirs(os.path.join(ROOT, "fusion"), exist_ok=True)
eagle.write_lbr(os.path.join(ROOT, "fusion", "orb.lbr"))
eagle.write_sch(os.path.join(ROOT, "fusion", "orb.sch"))
eagle.write_brd(os.path.join(ROOT, "fusion", "orb.brd"))

# ---- BOM, grouped by (value, package, mpn)
groups = OrderedDict()
for ref, i in D.INST.items():
    t = D.TYPES[i["type"]]
    key = (i["value"], t["pkg"], i["mpn"], i["mfr"], t["desc"], i["dnp"])
    groups.setdefault(key, []).append(ref)
def refkey(r): m = re.match(r"([A-Za-z]+)(\d+)", r); return (m.group(1), int(m.group(2)))
rows = []
for (value, pkg, mpn, mfr, desc, dnp), refs in groups.items():
    refs.sort(key=refkey)
    status = "specified" if mpn else ("TBD" if value == "TBD" or D.INST[refs[0]]["type"] in ("FPC4", "XTAL", "L_PWR") else "generic")
    rows.append([refs[0][0] if refs[0][:3] != "LED" else "LED", len(refs), ", ".join(refs), value, desc, pkg, mfr, mpn, status])
rows.sort(key=lambda r: ({"U": 0, "J": 1, "Y": 2, "D": 3, "SPK": 4, "LED": 5, "L": 6, "C": 7, "R": 8, "T": 9}.get(r[0], 10), r[2]))
with open(os.path.join(ROOT, "bom", "bom.csv"), "w", newline="") as fh:
    w = csv.writer(fh)
    w.writerow(["Type", "Qty", "References", "Value", "Description", "Package", "Manufacturer", "MPN", "Status"])
    for r in rows: w.writerow(r)
print(f"BOM: {sum(r[1] for r in rows)} parts on {len(rows)} lines")

# ---- pin plan
with open(os.path.join(ROOT, "design", "pin-plan.md"), "w") as fh:
    fh.write("# Orb GPIO pin plan (ESP32-C3FH4X)\n\nGenerated from `hardware/src/design.py` by `build.py`; `check.py` fails the build if the schematic and this plan disagree. "
             "The same assignments are in `apps/orb-firmware/src/config.rs`.\n\n")
    fh.write("| IO | Pad | Function | Net | Dir | Notes |\n| --- | --- | --- | --- | --- | --- |\n")
    padof = {0:4,1:5,2:6,3:8,4:9,5:10,6:12,7:13,8:14,9:15,10:16,18:25,19:26,20:27,21:28}
    for io, (fn, d, note) in D.PIN_PLAN.items():
        fh.write(f"| IO{io} | {padof[io]} | {fn} | {D.FUNCTION_NET[fn]} | {d} | {note} |\n")
    fh.write("\n**Chip facts used** (ESP32-C3 datasheet v2.4, FH4X pin layout): GPIO0-10 and 18-21 retain the existing assignments. GPIO11 is reserved as VDD_SPI; package pads 19-24 are NC for the in-package flash variant. The 40 MHz crystal uses dedicated pads 29/30, not GPIO0/1.  "
             "Strapping pins are GPIO2, GPIO8, GPIO9: SPI boot needs GPIO9 = 1 (internal weak pull-up, so a floating pad boots normally); download mode (USB-Serial-JTAG or UART) needs GPIO9 = 0 and GPIO8 = 1 at reset. "
             "GPIO2 and GPIO8 are free to use as normal pins after reset (the latches keep the sampled value). GPIO18/19 are the native USB D-/D+. Deep-sleep wake works on GPIO0-5 only.\n\n")
    fh.write("**Why the NFC controller is on I2C, not SPI.** The firmware constants had four SPI pins for the PN7161. The design uses 12 application GPIOs plus USB D+/D- and BOOT (15 total); "
             "SPI would add four more. The PN7161 host interface is fused at the factory (A = I2C, B = SPI, datasheet table 2), so the order code decides: use **PN7161A1HN/C101E (I2C)**. "
             "It shares the bus with the MAX17048 (0x28 and 0x36, no clash).\n")
print("pin plan written")
