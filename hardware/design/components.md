# Components and where to get their 3D models

Generated from `bom/bom.csv` and `src/design.py` (2026-10-29). The board files carry 2D footprints only, so Fusion shows no bodies until a 3D model is attached to each package (library editor, package, 3D tab, then align it to the footprint origin).

**Where to look for any part:** search the manufacturer part number (MPN) on the manufacturer's product page (a "3D model" or "CAD" download, STEP), then on the distributor page (DigiKey and Mouser have a Models or CAD link per part), then on SnapMagic (SnapEDA), Ultra Librarian or Component Search Engine. Prefer the manufacturer's STEP file. Downloaded 19 standalone STEP models into `../components/` on 2026-10-29. See `../components/README.md` for the reference-to-file map, manufacturer sources, generic/provisional substitutions and unresolved parts; `../components/manifest.json` records source URLs and checksums. The files are not yet attached to the Fusion library.

## 1. Parts that need a real model

| Ref | Part | MPN | Manufacturer | Package on the board | Notes for the 3D model |
| --- | --- | --- | --- | --- | --- |
| U1 | ESP32-C3-MINI-1-N4X module | ESP32-C3-MINI-1-N4X | Espressif | `ESP32C3MINI1_PLACEHOLDER` (13.2 x 16.6 mm) | Espressif's datasheet figure 11-1 also gives the land pattern: replace the placeholder footprint at the same time. The antenna end is local +y |
| U2 | NFC controller, I2C | PN7161A1HN/C101E | NXP | `HVQFN40_6X6` | Package SOT618-1 (HVQFN40, 6 x 6 mm). Order the A1HN (I2C) variant |
| U3 | Fuel gauge | MAX17048G+T10 | Analog Devices (Maxim) | `TDFN8_2X2` | TDFN-8, 2 x 2 mm |
| U4 | Charger and power path | BQ24074RGTR | Texas Instruments | `VQFN16_3X3` | VQFN-16 (RGT), 3 x 3 mm |
| U5 | 3.3 V buck-boost | TPS63802DLAR | Texas Instruments | `VSON10_2X3` | VSON-10 (DLA), 2.5 x 3.0 mm |
| U6 | I2S amplifier | MAX98357AETE+T | Analog Devices (Maxim) | `TQFN16_3X3` | TQFN-16, 3 x 3 mm |
| U7 | LED rail load switch | TPS22918DBVR | Texas Instruments | `SOT23_6` | SOT-23-6 (DBV) |
| U8 | Level-shifting buffer | SN74LV1T34DBVR | Texas Instruments | `SOT23_5` | SOT-23-5 (DBV) |
| D1 | USB ESD protection | USBLC6-2SC6 | STMicroelectronics | `SOT23_6` | SOT-23-6 |
| J1 | USB-C receptacle | 2345986-1 | TE Connectivity | `USBC24_TE2345986` | Product page https://www.te.com/en/product-2345986-1.html (documents and 3D PDF); DigiKey https://www.digikey.in/en/products/detail/te-connectivity-amp-connectors/2345986-1/22741080 (Models link). **Use the model to read the real overhang beyond the board edge** (design/open-items.md) |
| J2 | Battery header | S2B-PH-SM4-TB | JST | `JST_S2B_PH_SM4_TB` | 2-pin PH, 2.0 mm pitch, side entry, SMT. Mates with a PHR-2 housing |
| LED1-LED23 | Addressable LED | WS2812B | Worldsemi | `WS2812B_5050` | 5.0 x 5.0 mm PLCC4. **The exact LED revision is still undecided** (5050 against 2020 or V5): get the model for the one chosen |
| SPK1 | Speaker | CMS-151103-088SP | CUI Devices | `SPK_PADS` | A candidate from docs/ORB.md. Needs the acoustic chamber and its mounting in the enclosure |

## 2. Parts not chosen yet (get a model once the part is picked)

| Ref | What | Needed for the part choice |
| --- | --- | --- |
| J3 | 4-position 0.5 mm FPC connector for the NFC antenna tail | Candidate: Hirose **FH19C-4S-0.5SH(10)**, official STEP in `../components/J3_Hirose_FH19C-4S-0.5SH-10_CANDIDATE.step`. Bottom-contact ZIF, horizontal entry, **0.2 mm FPC**, nominal 4 x 3 x 0.9 mm body. Confirm tail thickness/contact side and physical fit before selecting; 3 mm body depth exceeds the drawing's 1.9 mm bar zone. Mouth must face +y at (0, -20.95), positions 2/3 RF and 1/4 open. Footprint/BOM remain TBD. |
| Y1 | 27.12 MHz crystal, 2.0 x 1.6 mm class | PN7160 clock requirements, load capacitance and ESR |
| L1 | 0.47 uH power inductor, 2.0 x 1.6 mm class, saturation current 4 A or more | TPS63802 datasheet table 10-2 |
| L2, L3 | NFC EMC filter inductors (0402) | NXP reference design values |
| C22-C28, R15, R16 | NFC matching and receive network (0402) | Tuned with a VNA on the real tail |

## 3. Generic parts (standard 3D bodies, no vendor model needed)

Fusion's standard library has 3D bodies for these package sizes. Use them unless a specific part is chosen.

| Package | Qty | References | Values |
| --- | --- | --- | --- |
| C0402 | 43 | C2, C3, C7, C11, C14-C21, C101-C123 and others | 100 nF (32), 12 pF (2), 1 uF (2), TBD matching (7) |
| C0603 | 11 | C1, C4-C6, C8-C10, C12, C13, C29, C31 | 10 uF (8), 4.7 uF (3) |
| CPOL7343 | 2 | C32, C33 | 100 uF polymer, 7.3 x 4.3 mm: pick a real part (it is the tallest top-side part, check its height under the shelf) |
| R0402 | 20 | R1, R3-R21 (there is no R2) | 10 k, 560 k, 2.2 k, 2 k, 33, 100 k, 5.1 k, 120 k, 220 k, 1.8 k, 1.13 k, TBD |
| TP1MM | 6 | TP1-TP6 | Test pads, no body |

## 4. Not on the board but in the 3D assembly

| Item | Source |
| --- | --- |
| Battery, custom Grepow pack based on GRP7550040 | Not a catalogue part: about 50 x 40.5 mm, 12 mm finished thickness, glued under the board. Model it as a box from the supplier's drawing (your section shows it) |
| NFC antenna FPC and its tail | Your own CAD |
| Pedestal, shelf, enclosure, M2 screws | Your own CAD |

## 5. Order of work

1. Attach J1 first: it settles the USB-C overhang (the open item that can move the connector).
2. Then U1, U2 and the speaker, which are the tall or large bodies that decide clearance under the shelf.
3. The rest can wait for the footprint review in design/open-items.md.

## PCB revision 2026-10-29

23 LEDs at R31.5: five per upper side, thirteen below, approximately 13-degree pitch. USB-C remains on the underside at 12 o'clock and its through mounts are reserved on both faces. J3 uses the Hirose FH19C-4S-0.5SH(10) drawing (0.2 mm bottom-contact tail). Updated land patterns for U1, J1, J2, J3, U4 and U5 are in `../src/landpatterns.json`; original placeholder package identifiers are retained to keep library bindings stable. U5 DLA0010A has **ten terminals and no separate pad 11**. The speaker is physically mounted on the PCB with a 15 x 11 mm body allowance plus assembly space; this solder-pad speaker requires adhesive retention and hand-soldered short leads, not an assumed reflow footprint. USB-C slot representation and final enclosure/antenna clearance still require review.

## Revision C component replacement
U1 is now ESP32-C3FH4X, not the MINI module. Add Y2 ABM8-40.000MHZ-10-1-U-T, ANT1 Johanson 2450AT18D0100001E, L4-L6, C34-C45 and R22-R23. C44/C45 are initially DNP. The generated BOM is the current quantity/reference list (141 placed parts, 139 fitted before other options). RF and crystal values require hardware tuning; see rf-redesign.md.
