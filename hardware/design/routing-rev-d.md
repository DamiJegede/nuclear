# Orb mainboard Rev D — routed engineering draft

2026-10-29. Four-layer, 69 mm circular board, 141 components, 100 logical nets (84 signals with multiple board pads), 23 LEDs. ESP32-C3FH4X, external 40 MHz crystal and Johanson SMT antenna retain the Rev C netlist and pin assignments.

The rectangle beyond the former outline was antenna copper-clearance documentation. Its boundary and all four antenna cutouts are now clipped to the circular PCB edge. USB-C remains on the underside at 12 o'clock. The speaker remains directly board-mounted using adhesive and short soldered leads. The upper LED count remains five on each side; thirteen LEDs occupy the lower arc.

## Current verification

Fusion document **Orb Mainboard Rev D - Routed** is saved. Native copper recalculation and DRC confirm **zero airwires**, **zero copper-clearance errors** and **zero overlap errors**. The native signal API also reports no unrouted wire objects. No errors have been approved or hidden. Native evidence is retained in `native-drc-errors.json`, `native-airwires.json` and the exported Fusion archive.

The remaining native results are **two Matched Signal Lengths errors and forty Wire Stub warnings**. They still require engineering review and correction before fabrication. All connections are routed; this is not a clean full-DRC or manufacturing release. Independent checks using square and elongated USB mounting-pad shapes found no different-net copper clearance violations below 0.127 mm, no prohibited copper in the antenna zone or pedestal foot areas, no edge clearance violations and no via drill spacing below 0.2 mm.

Same-net SMD-to-via clearance is set to zero specifically for the required filled-and-copper-capped via-in-pad construction. Different-net copper spacing remains 0.127 mm and all connectivity checks remain enabled. USB mounting-pad corner collisions were rerouted; no different-net overlaps remain. The native Fusion [same-signal clearance documentation](https://help.autodesk.com/cloudhelp/ENU/Fusion-ECAD/files/ECD-GENERAL-RULES-COPPER-CLEARANCE.htm) describes this distinction.

## Source and regeneration

`src/design.py`, `layout.py` and `landpatterns.json` define components, pins and placement. `src/routing.json` stores the copper snapshot and native rules. `src/routing.py` restores it during `src/build.py` and rejects placement, pad-geometry or netlist changes using a fingerprint. Make routing changes in the source snapshot, not only in generated `fusion/orb.brd`; otherwise regeneration would erase them. The previous Rev B and C Fusion archives are retained as historical backups and their routes must not be applied to changed geometry.

## Stack and fabrication assumptions

Four active copper layers are 1 / 2 / 15 / 16. Nominal reference stack is JLC04161H-7628: 35 µm outer copper, 0.2104 mm outer dielectric, 15.2 µm inner copper, 1.065 mm core, mirrored lower stack. Layer 2 carries the main ground pour with a limited number of signal crossings; layers 1 and 16 also carry ground pours. Antenna clearance applies to all four layers.

Minimum track width is 0.15 mm and different-net copper clearance is 0.127 mm. Main LED distribution retains wide copper; other supply routes were widened where geometry permits. Local narrow sections remain; see `power-width-audit.json`. Preferred supply widths are retained separately from the minimum escape width. Native rules use a 0.2 mm minimum drill and a 0.125 mm minimum via annulus; explicit via diameters are preserved instead of automatically expanding them. Via drill edge spacing is at least 0.2 mm. These are engineering assumptions for the cited fabrication process, not a production order.

**Filled and copper-capped via-in-pad processing is mandatory.** The exposed ground pads and several dense signal/passive pads use 0.45 mm diameter, 0.2 mm drill vias. Same-net SMD-to-via copper overlap is intentional for this process. Different-net isolation and unconnected-line checks remain enabled. Do not substitute ordinary open-hole via assembly, which can wick solder and impair the joints. See `via-audit.json` for pad locations (the snapshot itself is authoritative after subsequent route edits).

## Fabrication hold

This is an engineering draft, not a fabrication release. The confirmed zero-airwire result establishes connectivity only. RF matching and feed impedance, crystal loop geometry/frequency, USB pair geometry and lengths, switching-regulator loop layout, supply current/temperature performance, exact supplier land patterns (especially FPC and USB plated slots), assembly clearance and full ERC/DRC still require review. The antenna values are starting values and need tuning with the final enclosure and battery. Several land patterns remain provisional. No Gerbers are released for manufacture.

Sources: [JLCPCB stackups](https://jlcpcb.com/impedance), [fabrication capabilities](https://jlcpcb.com/capabilities/pcb-capabilities/), and the manufacturer references collected in `rf-redesign.md`.
