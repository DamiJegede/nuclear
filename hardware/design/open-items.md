# Current revision: C — bare ESP32-C3FH4X + SMT antenna

See [rf-redesign.md](rf-redesign.md) for current placement, clock, RF circuitry and outstanding validation. The Rev B module-antenna notes and routing checkpoint below are retained as historical review context; Rev C supersedes their component positions. Rev C has 141 parts, 100 logical nets and 23 LEDs.

# Open items before the board can be fabricated

Each item says who needs to do it. Items marked **vendor** are things the generated files deliberately do not guess.

## Footprints and assembly
- Manufacturer-derived lands now cover the ESP32-C3 module, TE USB-C, Hirose FH19C-4S-0.5SH(10), TI BQ24074 and TPS63802. Source drawings and geometry are in `references/` and `src/landpatterns.json`. Legacy package identifiers containing PLACEHOLDER are retained for stable bindings; those identifiers do not describe the revised geometry.
- TPS63802 has ten leads and no separate exposed pad. The previous fictional pad 11 has been removed.
- JST uses the KiCad S2B-PH-SM4-TB footprint. Verify against the ordered connector revision.
- USB mounts are represented by plated pads and milling paths. Four Fusion annular-ring warnings remain: confirm the plated-slot geometry and annular copper with the board fabricator before release.
- CMS-151103 is mounted directly on the PCB using adhesive and short hand-soldered connections. Its 15 x 11 mm body plus connections reserve 19.5 x 12 mm. This is a manual assembly arrangement; the supplier does not provide a reflow PCB land pattern.
- Remaining generic IC, crystal, passive and WS2812B lands require review against the exact purchased parts. Confirm the LED revision and pin order.

## Mechanical and RF placement
- USB-C stays on the bottom face at 12 o'clock. Its front face is aligned to the y=34.5 mm board apex; confirm against the curved edge and enclosure opening in 3D.
- LED revision: 23 total, five per upper side and thirteen below. Radius 31.5 mm, 13-degree pitch within each arc, 50-degree top gap. Calculated minimum adjacent LED pad separation is 0.309 mm. USB through-board mounts reserve space on both faces.
- The speaker is centred at (0,9); the battery header and two polymer capacitors have been rearranged above it.
- The ESP32 antenna faces 9 o'clock. Copper keep-out is present, but the bottom battery overlaps its projected antenna area. RF clearance is unresolved; revise the battery/module/enclosure arrangement before release.
- Confirm battery lead exit, component heights, speaker acoustic chamber and pedestal fit against the enclosure assembly. The FPC tail must be 0.2 mm thick, bottom-contact, 0.5 mm pitch to match the selected Hirose candidate.

## NFC antenna and RF (engineer)
- Antenna turns, the EMC filter (L2, L3, C22, C23), series and parallel matching (C24-C26) and the receive network (C27, C28, R15, R16) are **placeholders marked TBD**. Take starting values from NXP's PN7160 reference design and antenna application notes, then tune with a VNA on the real antenna tail near the real tap surface (12 mm away).
- The FPC connector uses positions 2 and 3 for RF and leaves 1 and 4 open (docs/ORB.md says two positions are used and two left open but not which). Change it if the tail is built the other way.
- 27.12 MHz crystal Y1 and its load capacitors C20, C21 are TBD: pick a crystal that meets the PN7160 clock requirements (about +/-100 ppm FCC, 30 ppm PLL) and size the load capacitors for it.
- Keep copper, the LED ring, the battery and the speaker out of the ESP32 antenna keep-out; the ring is on the top side at radius 31.5 mm.

## Power (engineer)
- Grepow pack: continuous discharge rating and PCM behaviour; the pack has no NTC, so the charger's TS pin is fixed at 10 k and thermal protection rests on the pack's PCM (confirm with the supplier, as docs/ORB.md already says).
- LED rail inrush: choose the TPS22918 CT capacitor (see design/power.md).
- LED peak current (1.38 A worst case) against the firmware brightness cap, `NORMAL_LED_BRIGHTNESS_CAP_PERCENT` (100 today). A cap near 60% roughly halves the worst-case current if the battery or thermal budget needs it.
- BQ24074 ILIM and ISET were chosen for a 0.9 A USB source (1.8 k, 1.13 k). Change R8 and R9 if the design targets a different source.
- The 3.3 V I2C pull-ups run against a MAX17048 supplied from the cell (3.0-4.2 V): confirm the gauge's SDA/SCL input limits at its minimum VDD, or pull up from VSYS.

## Firmware (done here, needs review)
- The PN7161 is the I2C part: order **PN7161A1HN/C101E**, not the SPI variant, or the pin plan does not fit (design/pin-plan.md explains the pin count).
- GPIO assignments are PROPOSED in `apps/orb-firmware/src/config.rs` and proven consistent with the schematic by `hardware/src/check.py`. The ROM prints boot messages on U0TXD (GPIO21), which is the amplifier shutdown line: set EFUSE_UART_PRINT_CONTROL to silence it, or move AUDIO_SHUTDOWN.

## Not designed yet
Beyond the two M2 screws, the enclosure interface, a programming/test fixture, RF test points, the secure element or key storage (docs/ORB.md section 8a: one fleet key in firmware), the speaker's acoustic chamber, and any certification work (FCC/CE, battery transport tests).

## Verification that exists
`hardware/src/check.py` (every pad of every IC is on a net or declared NC, GPIOs unique and valid, strapping rules, divider and resistor arithmetic) and `hardware/src/verify_eagle.py` (re-reads the generated Fusion files and compares every net and pad with `design.py`). The revised files have also been imported into Fusion as Orb Mainboard Rev B - 23 LEDs. Placement DRC reported 347 unrouted connections and four USB annular-ring warnings, with no overlap or clearance errors. This is a placement check, not an electrically validated or fabrication-ready board. `geometry-audit.json` records independent pad-clearance checks. Firmware tests: 135 passed.

## Fusion routing checkpoint
First general-signal pass saved and exported as `hardware/fusion/Orb Mainboard Rev B - 23 LEDs.fbrd`: 65 connections routed, 282 airwires remain. DRC reports only those airwires and four USB annular-ring warnings; no clearance or overlap errors. Power, USB and antenna routing remain manual work. The generated orb.brd is the reproducible placement source, while the archive preserves the separate Fusion routing checkpoint.

## Antenna placement study (October 29)
A position search at 0.5 mm spacing and 5-degree rotations checked the existing board, LED ring, USB mounting holes, pedestal, slots, screws, branding and FPC. Other top components were allowed to move. Of 734,472 sampled positions, 1,467 avoided direct antenna/battery overlap and fixed-part conflicts. None kept the battery outside a conservative rectangular 15 mm expansion of the antenna area, matching Espressif’s recommended clearance in all directions. This is a sampled 2D feasibility study, not proof against every continuous placement or an RF simulation. No PCB placement or routing was changed. Moving the module alone cannot be treated as RF clearance approval; a separate antenna or a mechanical/battery change needs selection and validation. Source: https://docs.espressif.com/projects/esp-hardware-design-guidelines/en/latest/esp32c3/pcb-layout-design.html
