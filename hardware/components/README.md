# Revision C model status

The original U1 MINI module model is retained for the Rev B archive only. It does not represent the current ESP32-C3FH4X. New provisional U1 QFN32, Y2 3225 and ANT1 AT18-family STEP models are downloaded but not attached. U1 model has a 3.65 mm exposed-pad envelope versus 3.7 mm nominal on the actual chip; use only for visual clearance. See manifest.json for sources and limitations.

# Orb component 3D models

Downloaded 2026-10-29 from the list in `../design/components.md`. This folder contains **19 STEP models**: eight manufacturer/module or manufacturer-package files, one part-named community model, four generic IC/diode packages, and six generic/provisional LED/passive models. One file is reused for repeated references (for example all 23 LEDs).

**These are standalone models, not attached to the Fusion/Eagle library.** The download does not replace placeholder footprints, settle the USB-C overhang, or approve enclosure clearances. Align each model to the actual footprint origin and pin 1, then verify it in Fusion.

## Model map

| References | STEP file | Source/type | Limitation |
| --- | --- | --- | --- |
| U1 | [U1_ESP32-C3-MINI-1.step](U1_ESP32-C3-MINI-1.step) | [manufacturer](https://www.espressif.com/sites/default/files/3dmodel/ESP32-C3-MINI-1%203D%20Model.STEP) | Manufacturer module-family model; verify alignment and N4X mechanical revision. |
| U4 | [U4_BQ24074_RGT0016C.step](U4_BQ24074_RGT0016C.step) | [manufacturer-package](https://webench.ti.com/cad/dlbxl.cgi/newstep/RGT0016C.stp) | TI package model linked for BQ24074 in TI package search. |
| U5 | [U5_TPS63802_DLA0010A.step](U5_TPS63802_DLA0010A.step) | [manufacturer-package](https://webench.ti.com/cad/dlbxl.cgi/newstep/DLA0010A.stp) | TI DLA0010A model; dimensions take precedence over the unverified 2.5 x 3.0 mm note in components.md. |
| U7 | [U7_TPS22918_DBV0006A.step](U7_TPS22918_DBV0006A.step) | [manufacturer-package](https://webench.ti.com/cad/dlbxl.cgi/newstep/DBV0006A.stp) | TI DBV six-pin package model; align pin 1. |
| U8 | [U8_SN74LV1T34_DBV0005A.step](U8_SN74LV1T34_DBV0005A.step) | [manufacturer-package](https://webench.ti.com/cad/dlbxl.cgi/newstep/DBV0005A.stp) | TI DBV five-pin package model; align pin 1. |
| U2 | [U2_PN7161_HVQFN40_GENERIC.step](U2_PN7161_HVQFN40_GENERIC.step) | [generic-package](https://raw.githubusercontent.com/KiCad/kicad-packages3D/b8b3cfdfad88ba66f21002b3de51dc6f7d55ba5a/Package_DFN_QFN.3dshapes/QFN-40-1EP_6x6mm_P0.5mm.step) | Generic 6 x 6 mm QFN40, not NXP SOT618-1 certification; verify height, exposed pad and pin 1 before clearance sign-off. |
| U3 | [U3_MAX17048_TDFN8_GENERIC.step](U3_MAX17048_TDFN8_GENERIC.step) | [generic-package](https://raw.githubusercontent.com/KiCad/kicad-packages3D/b8b3cfdfad88ba66f21002b3de51dc6f7d55ba5a/Package_DFN_QFN.3dshapes/DFN-8-1EP_2x2mm_P0.5mm_EP0.9x1.5mm.step) | Generic 2 x 2 mm DFN8; verify height and terminal/exposed-pad geometry against Maxim G-package drawing. |
| U6 | [U6_MAX98357_TQFN16_GENERIC.step](U6_MAX98357_TQFN16_GENERIC.step) | [generic-package](https://raw.githubusercontent.com/KiCad/kicad-packages3D/b8b3cfdfad88ba66f21002b3de51dc6f7d55ba5a/Package_DFN_QFN.3dshapes/TQFN-16-1EP_3x3mm_P0.5mm_EP1.6x1.6mm.step) | Generic 3 x 3 mm TQFN16; verify against Maxim T1633 package drawing. |
| D1 | [D1_USBLC6_SOT23-6_GENERIC.step](D1_USBLC6_SOT23-6_GENERIC.step) | [generic-package](https://raw.githubusercontent.com/KiCad/kicad-packages3D/b8b3cfdfad88ba66f21002b3de51dc6f7d55ba5a/Package_TO_SOT_SMD.3dshapes/SOT-23-6.step) | Generic SOT-23-6 package, not an ST-supplied model. |
| J2 | [J2_JST_S2B-PH-SM4-TB.step](J2_JST_S2B-PH-SM4-TB.step) | [community-part](https://raw.githubusercontent.com/AcheronProject/acheron_3D/4d9d420dfb02e4c7346ce7c05ca6e1c95a868e05/JST-S2B-PH-SM4-TB.STEP) | Exact part-named community model; manufacturer download was blocked. Check against JST drawing. |
| LED1-LED23 | [LED_WS2812B_5050_PROVISIONAL.step](LED_WS2812B_5050_PROVISIONAL.step) | [generic-package](https://raw.githubusercontent.com/KiCad/kicad-packages3D/b8b3cfdfad88ba66f21002b3de51dc6f7d55ba5a/LED_SMD.3dshapes/LED_WS2812B_PLCC4_5.0x5.0mm_P3.2mm.step) | PROVISIONAL legacy 5050 body; LED revision is undecided. Not suitable for WS2812B-2020 or unverified V5. |
| C0402 including C22-C28 | [C0402_GENERIC.step](C0402_GENERIC.step) | [generic-package](https://raw.githubusercontent.com/KiCad/kicad-packages3D/b8b3cfdfad88ba66f21002b3de51dc6f7d55ba5a/Capacitor_SMD.3dshapes/C_0402_1005Metric.step) | Generic 0402/1005 capacitor; exact height depends on chosen MPN. |
| C0603 | [C0603_GENERIC.step](C0603_GENERIC.step) | [generic-package](https://raw.githubusercontent.com/KiCad/kicad-packages3D/b8b3cfdfad88ba66f21002b3de51dc6f7d55ba5a/Capacitor_SMD.3dshapes/C_0603_1608Metric.step) | Generic 0603/1608 capacitor; exact height depends on chosen MPN. |
| R1, R3-R21 including R15-R16 | [R0402_GENERIC.step](R0402_GENERIC.step) | [generic-package](https://raw.githubusercontent.com/KiCad/kicad-packages3D/b8b3cfdfad88ba66f21002b3de51dc6f7d55ba5a/Resistor_SMD.3dshapes/R_0402_1005Metric.step) | Generic 0402/1005 resistor. |
| C32,C33 | [CPOL7343_31_GENERIC_PROVISIONAL.step](CPOL7343_31_GENERIC_PROVISIONAL.step) | [generic-package](https://raw.githubusercontent.com/KiCad/kicad-packages3D/b8b3cfdfad88ba66f21002b3de51dc6f7d55ba5a/Capacitor_Tantalum_SMD.3dshapes/CP_EIA-7343-31_Kemet-D.step) | PROVISIONAL 7343-31 body (3.1 mm height class). No polymer capacitor MPN or height selected; do not use for final shelf clearance. |
| L2,L3 | [L0402_GENERIC_PROVISIONAL.step](L0402_GENERIC_PROVISIONAL.step) | [generic-package](https://raw.githubusercontent.com/KiCad/kicad-packages3D/b8b3cfdfad88ba66f21002b3de51dc6f7d55ba5a/Inductor_SMD.3dshapes/L_0402_1005Metric.step) | PROVISIONAL generic 0402 inductor; actual MPN and height remain TBD. |
| SPK1 | [SPK1_CMS-151103-088SP.step](SPK1_CMS-151103-088SP.step) | [manufacturer](https://3dcadfiles.3dexchange.net/step_ap214/205/7814513/Same_Sky_CMS-151103-088SP.zip) | Speaker is still a candidate in components.md. |
| J1 | [J1_TE_2345986-1.step](J1_TE_2345986-1.step) | [manufacturer](https://www.te.com/commerce/DocumentDelivery/DDEController?Action=srchrtrv&DocFormat=3d_stp.zip&DocLang=English&DocNm=CVM_2345986-1&DocType=Customer+View+Model&PartCntxt=2345986-1) | Downloaded through the manufacturer product-page CAD link. USB-C overhang and board alignment still require Fusion verification. |
| J3 | [J3_Hirose_FH19C-4S-0.5SH-10_CANDIDATE.step](J3_Hirose_FH19C-4S-0.5SH-10_CANDIDATE.step) | [manufacturer](https://www.hirose.com/en/product/p/CL0580-0410-1-10) | CANDIDATE only: 4 positions, 0.5 mm pitch, bottom contact, horizontal-entry ZIF, 0.2 mm FPC thickness, nominal 4 x 3 x 0.9 mm. Depth exceeds the drawing's 1.9 mm bar zone; verify layout, actuator access, tail thickness and contact side before selecting. Footprint and BOM remain TBD. |

## Still unresolved

| References/item | Status | Reason |
| --- | --- | --- |
| J3 — 4-position 0.5 mm FPC connector | candidate-downloaded | Hirose FH19C-4S-0.5SH(10) STEP supplied. Confirm 0.2 mm tail, bottom contacts, body/actuator clearance and vendor footprint before final selection. |
| Y1 — 27.12 MHz crystal, 2.0 x 1.6 mm class | part-not-selected | Crystal MPN, load and ESR still TBD. |
| L1 — 0.47 uH power inductor | part-not-selected | No MPN or final height selected. |
| L2,L3 — NFC EMC inductors | generic-only | Provisional L0402 model supplied; final MPN/value/height undecided. |
| C22-C28,R15,R16 — NFC matching/receive network | generic-only | C0402/R0402 models supplied; final values and MPNs depend on tuning. |
| C32,C33 — 100 uF polymer capacitor | generic-only | 7343-31 generic supplied; final MPN and height remain unselected. |
| LED1-LED23 — WS2812B revision | provisional | Legacy 5050 model supplied; 2020/V5 alternatives are not selected. |
| TP1-TP6 — 1 mm test pads | no-body-needed | Copper pads have no separate 3D body. |
| Battery — Custom Grepow GRP7550040-based battery | custom-cad-needed | Not a catalogue part. Requires supplier drawing; no downloaded model or invented geometry supplied. |
| Antenna — NFC antenna FPC and tail | custom-cad-needed | Project-specific geometry. |
| Mechanical assembly — Pedestal, shelf, enclosure and M2 screws | custom-cad-needed | Use project CAD; screw length/head standard not specified. |

## Validation and import

All 19 files passed STEP header/trailer, solid-BREP presence, entity-ID uniqueness and reference-resolution checks. `manifest.json` records source URLs, archive members, pinned community-library revisions, byte counts, SHA-256 hashes and validation results. This is structural validation, not a CAD-kernel geometry or Fusion import test.

In Fusion Electronics, open the library package, attach the corresponding STEP in its 3D package workflow, and align it with the footprint. Start with J1, then U1/U2 and the speaker. Respect the embedded units: the community JST file contains inch-based units; other files declare millimetres. Do not manually assume all source coordinates are millimetres.

U2, U3, U6 and D1 use **generic** packages, not manufacturer-certified part models. The LED, polymer capacitor and inductor alternatives are **provisional**. Confirm final MPNs, terminal geometry and heights before clearance sign-off. The U5 TI model is the authority for its package geometry; the existing list has an unverified 2.5 x 3.0 mm note while TI describes DLA as 2 x 3 mm.

## Source attribution and licenses

- Hirose: official FH19C-4S-0.5SH(10) model, extracted as `FH19C-4S-0.5SH.stp`; candidate for J3. Nominal body is 4 x 3 x 0.9 mm, bottom-contact ZIF for a 0.2 mm tail. The drawing's 11.6 x 1.9 mm bar is not this body's outline; check the physical layout before adopting it.
- Espressif: official ESP32-C3-MINI-1 family model; source geometry and header preserved.
- Texas Instruments: RGT0016C, DLA0010A, DBV0006A and DBV0005A, linked to the specified MPNs in TI package search.
- TE Connectivity: customer view model `c-2345986-1-1-3d.stp`, extracted from the official product-page ZIP.
- Same Sky (formerly CUI Devices): CMS-151103-088SP, extracted from its STEP AP214 archive returned by the manufacturer download service.
- Acheron Project: JST-S2B-PH-SM4-TB model, pinned revision in the manifest. [AOHL v1.3 notice](LICENSE_Acheron.md) retained. The official JST STEP download could not be retrieved (HTTP 403 / browser timeout).
- KiCad library contributors: generic models, pinned revision in the manifest. [KiCad library license](LICENSE_KiCad.md), CC BY-SA 4.0 with the electronic-design exception, retained. Original per-file headers are unchanged.

Manufacturer files remain subject to their suppliers' CAD-use terms. Files are unmodified apart from descriptive filenames and extracting STEP files from ZIP archives.
