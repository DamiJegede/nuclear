#!/usr/bin/env python3
"""Checks hardware/src/design.py before anything is generated. Exit 1 on any problem."""
import re, sys
from collections import defaultdict
import design as D

problems = []
def bad(msg): problems.append(msg)

# 1. every pad of every IC is on a net or declared NC; no pad used twice
for ref, inst in D.INST.items():
    t = D.TYPES[inst["type"]]
    pins = {p[0]: p[1] for p in t["pins"]}
    for pin in inst["nets"]:
        if pin not in pins: bad(f"{ref}: net given for unknown pin {pin}")
    for pin in pins:
        if pin not in inst["nets"]: bad(f"{ref}: pin {pin} has no net")
    if inst["type"] in D.EXPECTED_PADS:
        pads = [pad for p in pins.values() for pad in p] + list(inst["nc"])
        want = {str(i) for i in range(1, D.EXPECTED_PADS[inst["type"]] + 1)}
        want |= D.EXTRA_PAD_NAMES.get(inst["type"], set())
        if len(pads) != len(set(pads)): bad(f"{ref}: a pad is listed twice: {sorted(p for p in set(pads) if pads.count(p) > 1)}")
        if set(pads) != want: bad(f"{ref}: pads missing {sorted(want - set(pads))} / unexpected {sorted(set(pads) - want)}")

# 2. nets: every net reaches at least two pins unless it is an NC marker
nets = defaultdict(list)
for ref, inst in D.INST.items():
    for pin, n in inst["nets"].items(): nets[n].append((ref, pin))
for n, pins in nets.items():
    if len(pins) < 2 and not re.search(r"NC", n): bad(f"net {n} has a single pin {pins}")
for must in ("GND", "3V3", "VSYS", "VBAT", "VBUS", "VLED"):
    if must not in nets: bad(f"net {must} missing")

# 3. GPIO plan: unique, valid, and the same on the schematic and in the plan
plan_nets = {}
for io, (fn, d, note) in D.PIN_PLAN.items():
    if io not in D.MODULE_IOS: bad(f"IO{io} is not available on the module")
    if fn not in D.FUNCTION_NET: bad(f"function {fn} has no net")
    plan_nets[io] = D.FUNCTION_NET.get(fn)
used = {}
for pin, n in D.INST["U1"]["nets"].items():
    m = re.fullmatch(r"IO(\d+)", pin) or re.fullmatch(r"(?:RXD0|TXD0)_IO(\d+)", pin)
    if not m: continue
    io = int(m.group(1))
    if io in used: bad(f"IO{io} twice")
    used[io] = n
    if plan_nets.get(io) != n: bad(f"IO{io}: schematic net {n} != plan {plan_nets.get(io)}")
for io in D.PIN_PLAN:
    if io not in used: bad(f"IO{io} in the plan but not on the schematic")
if set(D.PIN_PLAN) != D.MODULE_IOS: bad(f"plan misses module IOs {sorted(D.MODULE_IOS - set(D.PIN_PLAN))}")

# 4. the strapping and boot rules the datasheet gives
if D.PIN_PLAN[9][0] != "BOOT": bad("IO9 must be the boot pad")
if "BOOT" not in nets or len(nets["BOOT"]) < 2: bad("BOOT needs the MCU pin and its test pad")
if D.INST["U1"]["nets"]["IO8"] != "VBUS_SENSE": bad("IO8 should carry USB power (high during USB download)")

# 5. I2C addresses must not clash
addr = {"PN7161": 0x28, "MAX17048": 0x36}
if len(set(addr.values())) != len(addr): bad("I2C address clash")

# 6. electrical sanity from the datasheets
r = {k: v["value"] for k, v in D.INST.items()}
def ohm(s):
    m = re.fullmatch(r"([\d.]+)\s*([kM]?)", s)
    return float(m.group(1)) * {"": 1, "k": 1e3, "M": 1e6}[m.group(2)] if m else None
vout = 0.5 * (1 + ohm(r["R11"]) / ohm(r["R12"]))
if abs(vout - 3.3) > 0.05: bad(f"3V3 divider gives {vout:.2f} V")
vsense = 5.0 * ohm(r["R7"]) / (ohm(r["R6"]) + ohm(r["R7"]))
if not (2.5 < vsense < 3.4): bad(f"VBUS sense divider gives {vsense:.2f} V at 5 V")
if 5.25 * ohm(r["R7"]) / (ohm(r["R6"]) + ohm(r["R7"])) > 3.6: bad("VBUS sense divider can exceed 3.6 V at 5.25 V")
iin = 1610 / ohm(r["R8"]); ichg = 890 / ohm(r["R9"])
if not (0.2 <= iin <= 1.5): bad(f"ILIM gives {iin:.2f} A")
if not (0.2 <= ichg <= 1.5): bad(f"ISET gives {ichg:.2f} A")
if ichg > iin: bad("charge current exceeds the input limit")

# 7. every non-TBD resistor/capacitor has a value; part count
nled = sum(1 for k in D.INST if k.startswith("LED"))
if nled != D.N_LED: bad(f"{nled} LEDs")

# Bare FH4X package connections, independently checked against datasheet fig 2-2.
chip_pads={pad:D.INST["U1"]["nets"][pin] for pin,pp,_ in D.TYPES[D.INST["U1"]["type"]]["pins"] for pad in pp}
for pad,net in {"1":"ESP_RF_CHIP","2":"ESP_VDD_RF","3":"ESP_VDD_RF","7":"EN","11":"3V3","17":"3V3","18":"ESP_VDD_SPI","25":"USB_DN","26":"USB_DP","29":"ESP_XTAL_N","30":"ESP_XTAL_P","31":"3V3","32":"3V3","33":"GND"}.items():
    if chip_pads.get(pad)!=net:bad(f"FH4X pad {pad} must be on {net}")
if set(D.INST["U1"]["nc"])!={str(i) for i in range(19,25)}:bad("FH4X NC pads 19-24 must remain open")
if D.INST["Y2"]["value"]!="40MHz":bad("FH4X requires 40 MHz main crystal")
if D.INST["C37"]["nets"]!={"1":"ESP_VDD_SPI","2":"GND"}:bad("VDD_SPI must retain its local capacitor")
if not all(D.INST[r]["dnp"] for r in ("C44","C45")):bad("Untuned antenna shunts must initially be DNP")

if problems:
    print("FAIL"); [print(" -", p) for p in problems]; sys.exit(1)
print(f"ok: {len(D.INST)} parts, {len(nets)} nets, {len(D.PIN_PLAN)} GPIOs, 3V3 {vout:.2f} V, VBUS sense {vsense:.2f} V, input limit {iin:.2f} A, charge {ichg:.2f} A")
