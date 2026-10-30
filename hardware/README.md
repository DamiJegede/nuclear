## Current routed engineering draft — Rev D (2026-10-29)

Four-layer routing and antenna clearance clipped to the circular edge. **Fusion confirms zero airwires, zero copper-clearance errors and zero overlap errors.** Saved as **Orb Mainboard Rev D - Routed**. Two matched-length errors and forty wire-stub warnings remain; this is not a fabrication release. See [routing-rev-d.md](design/routing-rev-d.md) for current checks, required filled-and-capped vias and fabrication holds. Routing is reproducible through `src/routing.json`; do not regenerate from older Rev C sources. Earlier sections below record the previous revision.

# Current board revision: C

U1 is now ESP32-C3FH4X with a separate 40 MHz crystal and Johanson 2450AT18D0100001E SMT antenna. GPIO assignments and 23-LED count are preserved. See [RF redesign notes](design/rf-redesign.md). Generated files are the revised schematic and placement draft; the Rev B Fusion archive remains an earlier routing checkpoint.

# Orb hardware

The Orb main board: a 69 mm round board with an ESP32-C3-MINI-1-N4X, a PN7161 NFC controller, 23 WS2812B LEDs on a ring (R31.5), a MAX98357A amplifier, USB-C, and a 1-cell Li-ion charger, gauge and 3.3 V supply. Product decisions are in `docs/ORB.md`; this folder turns them into files you can open in Fusion.

## Import into Fusion

Written for Autodesk Fusion (Electronics). The files are in the Eagle XML format, which Fusion imports. The initial files were imported and linked in Fusion on 2026-10-29. The source revision below corrects problems found by the initial Fusion DRC; confirm the revised import and its DRC before release.

1. Fusion's Data Panel, **Upload**, and choose all three files from `hardware/fusion/`: `orb.lbr`, `orb.sch`, `orb.brd`. (Or File, Open, Open from my computer.)
2. Open `orb.sch`: 122 parts in functional blocks (MCU, USB, power, I2C, NFC, audio, LED rail, LED ring), every connection a named net.
3. Open `orb.brd`: the R34.5 mm outline and the layout below, all connections unrouted (ratsnest). `design/layout.png` is a picture of it.
4. Run ERC on the schematic and DRC on the board. Expect warnings: the footprint list in `design/open-items.md` is the reason for most.

## Layout revision 2026-10-29

- **LEDs:** 23 on R31.5, clockwise: upper right 65/52/39/26/13 degrees; lower arc -12 to -168 degrees in 13-degree steps (13 LEDs); upper left 167/154/141/128/115 degrees. Five on each upper side, with a 50-degree opening around USB-C at 12 o'clock. Measured minimum LED copper-pad gap: 0.309 mm (the former 12-degree arrangement overlapped).
- **USB-C:** remains underneath at 12 o'clock. Manufacturer drawing-based pad rows and slotted mounts replace the former SMD-only approximation. The manufacturer's front-face/PCB-edge reference is aligned at y=34.5; the former guessed 2.7 mm overhang is removed. Mount holes and their copper annuli reserve clearance on both faces. Slot plating/geometry and the enclosure opening still need fabrication/mechanical review.
- **Speaker:** mounted directly on the PCB as requested; a 15 x 11 mm body, with 19.5 x 12 mm total assembly allowance, is reserved at (0,9). This part uses solder pads and adhesive retention with short hand-soldered leads; a reflow mounting specification is not available. Polymer capacitors move to (-10,21.6)/(10,21.6), battery header to (0,20.5), MCU to (-9.4,-5.2). Smaller parts are repacked around these bodies.
- **FPC:** Hirose FH19C-4S-0.5SH(10), 0.5 mm pitch, bottom contacts, 0.2 mm tail. Mouth +y, origin (0,-20.5); positions 2/3 carry RF, 1/4 remain open. Confirm tail fabrication stack-up.
- **Preserved constraints:** 69 mm circular board, M2 holes at (+-32,0), pedestal slots at (+-27.4,0), pedestal keep-outs on both sides, clear branding area below y=-22.5. Battery stays underneath; the LED decouplers are underneath their LEDs. The top USB gap now leaves their through mounts clear.
- `src/layout.py` checks courtyards and mechanical restrictions. `design/geometry-audit.json` records the separate source-file copper audit. Fusion DRC/ERC and actual routing are still required; this is an engineering draft.

## What is solid and what is not

- **Solid:** pin and pad numbers of every IC, taken from the manufacturers' datasheets (ESP32-C3-MINI-1 v2.2, PN7160/PN7161 rev 4.2, BQ2407x, TPS63802, TPS22918, SN74LV1T34, MAX98357A, MAX17048); all connections; the GPIO plan; the resistor arithmetic (3.3 V divider, charge and input limits, VBUS sense). `src/check.py` and `src/verify_eagle.py` prove those.
- **Still preliminary:** USB-C plated-slot fabrication, speaker assembly/retention, generic NFC/amplifier/gauge footprints, LED revision and passive MPN/height selection require review. Manufacturer-derived overrides replace U1/J1/J2/J3/U4/U5 geometry; the NFC matching network and crystal remain TBD. See `design/open-items.md`.
- **Still requires engineering validation:** antenna tuning and certification.

## Files

| Path | What |
| --- | --- |
| `fusion/orb.lbr`, `orb.sch`, `orb.brd` | Generated. Do not edit by hand; edit `src/design.py` and rebuild |
| `components/` | 19 downloaded standalone STEP models, source manifest and licenses; see `components/README.md` for generic/provisional models and unresolved parts |
| `bom/bom.csv` | Bill of materials: part, quantity, references, value, package, manufacturer, MPN, status (specified / generic / TBD) |
| `design/pin-plan.md` | GPIO assignments with the datasheet reasons |
| `design/power.md` | Power tree, part choices and the current budget |
| `design/open-items.md` | What must still happen before fabrication |
| `src/design.py` | The single source of truth: part types (pins by datasheet), instances, nets, GPIO plan |
| `src/check.py` | Checks the design (pads, nets, GPIOs, strapping rules, arithmetic) |
| `src/layout.py`, `src/preview.py` | Place the parts, check the board rules, draw `design/layout.png` |
| `src/eagle.py`, `build.py` | Write the Fusion files, BOM and pin plan |
| `src/verify_eagle.py` | Re-reads the Fusion files and compares them with the design |

Rebuild: `npm run hardware:build` (runs the check, writes everything, then verifies the written files).

## Decisions made while building this (change them in `design.py`)

- **PN7161 on I2C** (order code PN7161A1HN/C101E), sharing the bus with the fuel gauge, because the module exposes only 15 GPIOs and the board needs 14 signals; SPI would not fit. The firmware's four SPI pin constants are gone.
- **BQ24074** charger with power path (VSYS follows the battery, 4.4 V on USB), **TPS63802** buck-boost for 3.3 V, **TPS22918** switch on the LED rail so 28 idle LEDs do not drain the battery, and an **SN74LV1T34** level translator so the 3.3 V data reaches the LEDs' input threshold at VLED.
- No battery NTC: the charger's TS pin is held with a fixed 10 k resistor, as docs/ORB.md says the pack has none.
- Gauge charge detection and the charger's /CHG line both exist; the firmware can use either.
