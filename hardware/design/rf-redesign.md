# Revision C: bare ESP32-C3FH4X and SMT antenna

Engineering draft, not released for fabrication. This revision replaces U1 ESP32-C3-MINI-1-N4X with ESP32-C3FH4X, while preserving all 15 GPIO assignments (12 application pins, USB pair, BOOT). Pads 19-24 are NC on FH4X; pad 33 is ground. The in-package 4 MB flash needs no external flash. VDD_SPI is retained as a supply output with local decoupling, not an extra GPIO.

## Clock and power
Y2 is Abracon ABM8-40.000MHZ-10-1-U-T (40 MHz, 10 pF load, +/-10 ppm initial tolerance and +/-10 ppm stability, -10 to +60 C). This temperature range is a component limit, not the full chip's -40 to +105 C rating. C40/C41 start at 16 pF (estimated 2 pF stray); L5 starts at 24 nH per Espressif. Verify startup, amplitude and total RF carrier offset on the assembled board; load values are initial, not calibrated. The NFC 27.12 MHz Y1 remains independent. No 32.768 kHz crystal is fitted; GPIO0/1 remain NFC signals.

L4 filters VDD3P3 (2 nH initial, >=500 mA required), with C34 on the RF side. C35/C36 decouple CPU/RTC; C37 decouples VDD_SPI. C38/C39 decouple VDDA. Existing C1/C2 provide bulk and high-frequency supply bypass. Decoupling and ground return paths need manual routing close to the actual supply pads.

## SMT antenna
ANT1 is Johanson 2450AT18D0100001E (3.2 x 1.6 x 1.2 mm). The thin-edge reference layout uses 8 x 3.4 mm ground clearance. Our clearance begins at (6.3,28.85), extends to x=14.3 and to the round board edge; its upper drawing boundary y=35 is deliberately outside the board. Battery ends at y=15.5, USB shell remains to its left. Matching components ANT1/C45/R23 are the only placement exceptions inside this area. The generator adds copper-pour cutouts on both layers; RF feed/return traces are intentional exceptions and must be manually checked. Other signal traces and vias must be kept out during routing.

ANT1 pad 1 is feed, pads 2/4 ground, and pad 3 returns through R23 (initial 0 ohm, replacement L/C possible) following the thin-edge reference. C42/L6/C43 provide the chip CLC match; initial 1 pF / 2.4 nH / 1 pF are unvalidated starting values. R22/C44/C45 form the separate antenna pi match: series 0 ohm, shunts initially DNP. Match both networks on the actual PCB with battery and enclosure installed. Do not copy module matching values as a validated design.

The uppermost LED pair (LED1/LED23) and their bottom capacitors move inward 4 mm to R27.5; the other 21 LEDs stay R31.5. Counts stay five per upper side and thirteen below. Independent pad audit found minimum LED pad gap 0.307 mm and minimum pad-to-edge clearance 0.645 mm, with no different-net pad clearance below 0.127 mm. Speaker is centred at (0,0); capacitors/JST are rearranged above it.

## Release work remaining
The board is a placement/schematic revision. Power, clock, USB and RF routing still require completion. The present two-layer setup has no fabricator-controlled stack-up: define the board thickness/material/copper and calculate the 50 ohm RF transmission line before routing it. Prefer the manufacturer's four-layer implementation if the mechanical stack allows. Add the chip's exposed-pad ground vias and RF ground stitching with the agreed fabrication process. QFN and crystal lands are prototype geometry and must be checked against supplier recommended lands; a four-window paste pattern is included for the 3.7 mm exposed pad. USB plated-slot warnings, NFC tuning and its crystal selection remain from Rev B. Three provisional KiCad chip/antenna/crystal STEP models are downloaded and source-recorded, but not attached to Fusion packages. Module RF approvals do not transfer to this bare-chip design.

## Manufacturer references
- [ESP32-C3 datasheet v2.4](https://documentation.espressif.com/esp32-c3_datasheet_en.html)
- [Espressif reference circuits and tuning procedure](https://docs.espressif.com/projects/esp-hardware-design-guidelines/en/latest/esp32c3/schematic-checklist.html)
- [Johanson antenna Rev5, pages 2/5](https://www.johansontechnology.com/docs/3791/Antenna-2450AT18D0100001E-Rev5.0.pdf)
- [Abracon ABM8 manufacturer datasheet](https://www.mouser.com/pdfDocs/abracon-abm8-data.pdf)

## Fusion checkpoint
Saved and exported as `Orb Mainboard Rev C - SMT Antenna.fbrd`. First control-signal pass routes 63 connections (434 wire segments, 31 vias); 297 airwires remain. Fusion DRC reports no overlap or clearance errors and four USB annular-ring warnings. Export readback confirms all 141 placements match the generated source and no routed wire or via enters the reserved antenna area. This confirms geometry only, not impedance, tuning or functional hardware. Clock/supply bypass positions still need refinement during manual routing to minimise their loops and ground returns.
