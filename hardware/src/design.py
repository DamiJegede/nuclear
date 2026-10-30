"""The Orb main board as data: part types (pins by datasheet), instances (value, MPN) and the nets.

This file is the single source of truth. `check.py` verifies it, `build.py` writes the Fusion (Eagle format) files, the BOM and the pin plan from it.
Pin and pad numbers come from the manufacturers' datasheets (see design/README in hardware/README.md); anything marked TBD or VERIFY needs the
board engineer.
"""
from collections import OrderedDict

# ---------------------------------------------------------------------------------------------------------------------------------
# Part types. pins: (symbol pin name, [pad numbers], side 'L'|'R')  -- several pads under one name = one symbol pin with several pads.
# pkg: the library package; desc: shown in the BOM.
# ---------------------------------------------------------------------------------------------------------------------------------
def P(name, pads, side): return (name, [str(p) for p in (pads if isinstance(pads, (list, tuple)) else [pads])], side)

TYPES = OrderedDict()

TYPES["R"] = dict(prefix="R", pkg="R0402", pins=[P("1", 1, "L"), P("2", 2, "R")], desc="Resistor")
TYPES["C"] = dict(prefix="C", pkg="C0402", pins=[P("1", 1, "L"), P("2", 2, "R")], desc="Capacitor")
TYPES["C0603"] = dict(prefix="C", pkg="C0603", pins=[P("1", 1, "L"), P("2", 2, "R")], desc="Capacitor")
TYPES["CPOL"] = dict(prefix="C", pkg="CPOL7343", pins=[P("P", 1, "L"), P("N", 2, "R")], desc="Polymer capacitor")
TYPES["L"] = dict(prefix="L", pkg="L0402", pins=[P("1", 1, "L"), P("2", 2, "R")], desc="Inductor")
TYPES["L_PWR"] = dict(prefix="L", pkg="L2016", pins=[P("1", 1, "L"), P("2", 2, "R")], desc="Power inductor")
TYPES["TP"] = dict(prefix="TP", pkg="TP1MM", pins=[P("TP", 1, "L")], desc="Test pad")
TYPES["XTAL"] = dict(prefix="Y", pkg="XTAL2016", pins=[P("1", 1, "L"), P("GND_A", 2, "R"), P("2", 3, "R"), P("GND_B", 4, "L")], desc="Crystal")

TYPES["ESP32C3FH4X"] = dict(prefix="U", pkg="ESP32C3_QFN32", desc="Espressif ESP32-C3FH4X, 4 MB in-package flash, QFN32 5 x 5 mm", pins=[
    P("LNA_IN",1,"L"), P("VDD_RF",[2,3],"L"), P("IO0",4,"R"), P("IO1",5,"R"), P("IO2",6,"L"), P("EN",7,"L"), P("IO3",8,"L"),
    P("IO4",9,"R"),P("IO5",10,"R"),P("VDD_RTC",11,"L"),P("IO6",12,"R"),P("IO7",13,"R"),P("IO8",14,"R"),P("IO9",15,"R"),P("IO10",16,"R"),
    P("VDD_CPU",17,"L"),P("VDD_SPI",18,"L"),P("IO18",25,"R"),P("IO19",26,"R"),P("RXD0_IO20",27,"R"),P("TXD0_IO21",28,"R"),
    P("XTAL_N",29,"R"),P("XTAL_P",30,"R"),P("VDDA",[31,32],"L"),P("GND",33,"L")])
NC_ESP={str(i):"NC on FH4X: in-package flash, do not connect" for i in range(19,25)}
TYPES["XTAL40"] = dict(prefix="Y",pkg="ABM8_3225",pins=TYPES["XTAL"]["pins"],desc="Abracon ABM8 3.2 x 2.5 mm 40 MHz crystal")
TYPES["ANT24"] = dict(prefix="ANT",pkg="JOHANSON_2450AT18D",pins=[P("FEED",1,"L"),P("GND",[2,4],"L"),P("TUNE",3,"R")],desc="Johanson 2450AT18D0100001E 2.4 GHz SMT antenna, thin-edge reference layout")

# PN7161 HVQFN40 (NXP PN7160_PN7161 rev 4.2 table 7). I2C version: PN7161A1HN/C101E.
TYPES["PN7161"] = dict(prefix="U", pkg="HVQFN40_6X6", desc="NXP PN7161A1HN NFC controller (I2C)", pins=[
    P("I2C_ADR0", 1, "L"), P("DWL_REQ", 2, "L"), P("I2C_ADR1", 3, "L"), P("VSS_PAD", 4, "L"), P("SDA", 5, "L"), P("VDD_PAD", 6, "L"), P("SCL", 7, "L"),
    P("IRQ", 8, "L"), P("VSS_A", 9, "L"), P("VEN", 10, "L"), P("VBAT2", 12, "L"), P("VDD_UP", 13, "L"), P("VDD_TX", 14, "R"),
    P("RXN", 15, "R"), P("RXP", 16, "R"), P("VDD_VMID", 17, "R"), P("TVDD_IN", 18, "R"), P("TX2", 19, "R"), P("VSS_TX", 20, "R"), P("TX1", 21, "R"),
    P("TVDD_IN2", 22, "R"), P("ANT1", 23, "R"), P("ANT2", 24, "R"), P("VDD_HF", 25, "R"), P("VDD_A", 26, "R"), P("VDD", 27, "R"), P("VBAT", 28, "R"),
    P("XTAL2", 29, "R"), P("XTAL1", 30, "R"), P("VDD_D", 31, "R"), P("DCDC_EN", 37, "R"), P("WKUP_REQ", 39, "L"), P("CLK_REQ", 40, "L"), P("VSS", 41, "L"),
])
NC_PN = {"11": "i.c. (leave open)", "32": "NC", "33": "NC", "34": "NC", "35": "NC", "36": "NC", "38": "i.c. (leave open)"}

TYPES["MAX17048"] = dict(prefix="U", pkg="TDFN8_2X2", desc="Analog/Maxim MAX17048G+T10 fuel gauge (TDFN-8)", pins=[
    P("CTG", 1, "L"), P("CELL", 2, "L"), P("VDD", 3, "L"), P("GND", [4, 9], "L"), P("ALRT", 5, "R"), P("QSTRT", 6, "R"), P("SCL", 7, "R"), P("SDA", 8, "R"),
])
TYPES["BQ24074"] = dict(prefix="U", pkg="VQFN16_3X3", desc="TI BQ24074RGTR charger and power path (VQFN-16)", pins=[
    P("TS", 1, "L"), P("BAT", [2, 3], "R"), P("CE", 4, "L"), P("EN2", 5, "L"), P("EN1", 6, "L"), P("PGOOD", 7, "R"), P("VSS", [8, 17], "L"), P("CHG", 9, "R"),
    P("OUT", [10, 11], "R"), P("ILIM", 12, "L"), P("IN", 13, "L"), P("TMR", 14, "L"), P("ITERM", 15, "L"), P("ISET", 16, "L"),
])
TYPES["TPS63802"] = dict(prefix="U", pkg="VSON10_2X3", desc="TI TPS63802DLAR buck-boost 3.3 V (VSON-10)", pins=[
    P("EN", 1, "L"), P("MODE", 2, "L"), P("AGND", 3, "L"), P("FB", 4, "R"), P("PG", 5, "R"), P("VOUT", 6, "R"), P("L2", 7, "R"), P("GND", 8, "L"),
    P("L1", 9, "L"), P("VIN", 10, "L"),
])
TYPES["MAX98357A"] = dict(prefix="U", pkg="TQFN16_3X3", desc="Analog/Maxim MAX98357AETE+T I2S Class D amplifier (TQFN-16)", pins=[
    P("DIN", 1, "L"), P("GAIN_SLOT", 2, "L"), P("GND", [3, 11, 15, 17], "L"), P("SD_MODE", 4, "L"), P("VDD", [7, 8], "R"), P("OUTP", 9, "R"), P("OUTN", 10, "R"),
    P("LRCLK", 14, "L"), P("BCLK", 16, "L"),
])
NC_AMP = {"5": "NC", "6": "NC", "12": "NC", "13": "NC"}
TYPES["TPS22918"] = dict(prefix="U", pkg="SOT23_6", desc="TI TPS22918DBVR load switch (SOT-23-6)", pins=[
    P("VIN", 1, "L"), P("GND", 2, "L"), P("ON", 3, "L"), P("CT", 4, "R"), P("QOD", 5, "R"), P("VOUT", 6, "R"),
])
TYPES["SN74LV1T34"] = dict(prefix="U", pkg="SOT23_5", desc="TI SN74LV1T34DBVR level-shifting buffer (SOT-23-5)", pins=[
    P("A", 2, "L"), P("GND", 3, "L"), P("Y", 4, "R"), P("VCC", 5, "R"),
])
NC_BUF = {"1": "NC"}
TYPES["USBLC6"] = dict(prefix="D", pkg="SOT23_6", desc="ST USBLC6-2SC6 USB ESD protection (SOT-23-6)", pins=[
    P("IO1_A", 1, "L"), P("GND", 2, "L"), P("IO2_A", 3, "L"), P("IO2_B", 4, "R"), P("VBUS", 5, "R"), P("IO1_B", 6, "R"),
])
TYPES["WS2812B"] = dict(prefix="LED", pkg="WS2812B_5050", pins=[P("VDD", 1, "L"), P("DOUT", 2, "R"), P("VSS", 3, "L"), P("DIN", 4, "L")], desc="WS2812B addressable LED (5050; revision TBC)")
TYPES["USBC"] = dict(prefix="J", pkg="USBC24_TE2345986", desc="TE Connectivity 2345986-1 USB-C receptacle (24 pads, USB 3.1 top mount, dual row SMT; only the USB 2.0 pads are used)", pins=[
    P("GND", ["A1", "B12", "A12", "B1"], "L"), P("VBUS", ["A4", "B9", "A9", "B4"], "L"), P("CC1", "A5", "L"), P("CC2", "B5", "L"), P("DP", ["A6", "B6"], "R"), P("DN", ["A7", "B7"], "R"),
    P("SBU1", "A8", "R"), P("SBU2", "B8", "R"), P("SHIELD", ["S1", "S2", "S3", "S4"], "R"),
])
NC_USB_SS = {p: "SuperSpeed pair, unused (USB 2.0 only)" for p in ["A2", "A3", "A10", "A11", "B2", "B3", "B10", "B11"]}
TYPES["JST_BAT"] = dict(prefix="J", pkg="JST_S2B_PH_SM4_TB", desc="JST S2B-PH-SM4-TB battery header", pins=[P("BAT_P", 1, "L"), P("BAT_N", 2, "L"), P("MECH", ["S1", "S2"], "R")])
TYPES["FPC4"] = dict(prefix="J", pkg="FPC4_PLACEHOLDER", desc="Hirose FH19C-4S-0.5SH(10), 0.5 mm pitch, 0.2 mm bottom-contact FPC", pins=[P("1", 1, "L"), P("2", 2, "L"), P("3", 3, "R"), P("4", 4, "R"), P("MECH", ["M1", "M2"], "R")])
TYPES["SPK"] = dict(prefix="SPK", pkg="SPK_PADS", desc="Speaker CMS-151103-088SP (wire or pad connection)", pins=[P("P", 1, "L"), P("N", 2, "R")])

# ---------------------------------------------------------------------------------------------------------------------------------
# Instances and nets
# ---------------------------------------------------------------------------------------------------------------------------------
INST = OrderedDict()   # ref -> dict(type, value, mpn, mfr, note, dnp, group, nets{pin: net}, nc{pad: why})

def add(ref, typ, value, nets, mpn="", mfr="", note="", dnp=False, group="", nc=None):
    assert ref not in INST, ref
    INST[ref] = dict(type=typ, value=value, mpn=mpn, mfr=mfr, note=note, dnp=dnp, group=group, nets=dict(nets), nc=dict(nc or {}))

# ---- MCU ----
add("U1", "ESP32C3FH4X", "ESP32-C3FH4X", {
    "VDD_RF":"ESP_VDD_RF", "VDD_RTC":"3V3", "VDD_CPU":"3V3", "VDDA":"3V3", "VDD_SPI":"ESP_VDD_SPI", "LNA_IN":"ESP_RF_CHIP", "XTAL_N":"ESP_XTAL_N", "XTAL_P":"ESP_XTAL_P", "GND": "GND", "EN": "EN", "IO0": "NFC_IRQ", "IO1": "NFC_VEN", "IO2": "CHG_STATUS", "IO3": "LED_EN", "IO4": "I2C_SDA", "IO5": "I2C_SCL",
    "IO6": "LED_DATA_3V3", "IO7": "I2S_BCLK", "IO8": "VBUS_SENSE", "IO9": "BOOT", "IO10": "I2S_LRCLK", "IO18": "USB_DN", "IO19": "USB_DP",
    "RXD0_IO20": "I2S_DIN", "TXD0_IO21": "AMP_SD"}, mpn="ESP32-C3FH4X", mfr="Espressif", group="mcu", nc=NC_ESP,
    note="Bare FH4X chip: pins 19-24 NC, exposed pad 33 GND. Separate 40 MHz crystal and two RF matching networks; matching requires assembled-board tuning.")
add("C1", "C0603", "10uF", {"1": "3V3", "2": "GND"}, "", "", "3V3 bulk", group="mcu")
add("C2", "C", "100nF", {"1": "3V3", "2": "GND"}, group="mcu")
add("R1", "R", "10k", {"1": "3V3", "2": "EN"}, group="mcu", note="EN pull-up (datasheet: R=10k, C=1uF RC delay)")
add("C3", "C", "1uF", {"1": "EN", "2": "GND"}, group="mcu")
add("R3", "R", "100k", {"1": "3V3", "2": "CHG_STATUS"}, group="mcu", note="Pull-up for BQ24074 /CHG (open drain) and for GPIO2, which the datasheet recommends pulling high")
add("TP1", "TP", "EN", {"TP": "EN"}, group="mcu", note="Reset pad: short to GND to reset")
add("TP2", "TP", "BOOT", {"TP": "BOOT"}, group="mcu", note="IO9: short to GND at reset for download mode (USB-JTAG/serial)")
add("TP3", "TP", "3V3", {"TP": "3V3"}, group="mcu")
add("TP4", "TP", "GND", {"TP": "GND"}, group="mcu")
add("TP5", "TP", "VSYS", {"TP": "VSYS"}, group="mcu")
add("TP6", "TP", "VBAT", {"TP": "VBAT"}, group="mcu")

# Bare-chip power, clock and 2.4 GHz RF. Values marked initial need measurement.
add("L4","L","2nH",{"1":"3V3","2":"ESP_VDD_RF"},note="VDD3P3 LC filter per Espressif reference; >=500 mA rated RF inductor",group="mcu")
for ref,val,net in [("C34","1uF","ESP_VDD_RF"),("C35","100nF","3V3"),("C36","100nF","3V3"),("C37","1uF","ESP_VDD_SPI"),("C38","1uF","3V3"),("C39","10nF","3V3")]:
    add(ref,"C",val,{"1":net,"2":"GND"},group="mcu",note="Local bare-chip supply decoupling; placement locked to corresponding supply pins")
add("Y2","XTAL40","40MHz",{"1":"ESP_XTAL_DRIVE","2":"ESP_XTAL_N","GND_A":"GND","GND_B":"GND"},mpn="ABM8-40.000MHZ-10-1-U-T",mfr="Abracon",note="10 pF load, +/-10 ppm initial tolerance and stability, -10 to +60 C; verify total frequency error on hardware",group="mcu")
add("L5","L","24nH",{"1":"ESP_XTAL_P","2":"ESP_XTAL_DRIVE"},note="Espressif initial crystal harmonic-suppression value; tune after test",group="mcu")
for ref,net in [("C40","ESP_XTAL_DRIVE"),("C41","ESP_XTAL_N")]:
    add(ref,"C","16pF",{"1":net,"2":"GND"},note="C0G initial load: 16pF/2 + estimated 2pF stray = 10pF; verify +/-10 ppm on assembled PCB",group="mcu")
add("L6","L","2.4nH",{"1":"ESP_RF_CHIP","2":"RF_50OHM"},note="Initial chip-match series inductor; not a validated match, tune to Espressif RF targets",group="rf")
add("C42","C","1pF",{"1":"ESP_RF_CHIP","2":"GND"},note="C0G initial chip matching shunt; tune with L6/C43",group="rf")
add("C43","C","1pF",{"1":"RF_50OHM","2":"GND"},note="C0G initial chip matching shunt; tune with L6/C42",group="rf")
add("R22","R","0",{"1":"RF_50OHM","2":"ANT_FEED"},note="Antenna pi network series position, replace with matching L/C during tuning",group="rf")
for ref,net in [("C44","RF_50OHM"),("C45","ANT_FEED")]:
    add(ref,"C","1pF",{"1":net,"2":"GND"},dnp=True,note="Antenna pi matching shunt, initially DNP; tune in final enclosure",group="rf")
add("ANT1","ANT24","2450AT18D0100001E",{"FEED":"ANT_FEED","GND":"GND","TUNE":"ANT_GND_TUNE"},mpn="2450AT18D0100001E",mfr="Johanson Technology",group="rf",note="Reference thin-edge 8 x 3.4 mm ground clearance extended to board edge; no battery, USB shell, LEDs or copper plane below")
add("R23","R","0",{"1":"ANT_GND_TUNE","2":"GND"},note="Thin-edge tuning link from antenna pad 3 to ground boundary, may become L/C after RF measurement",group="rf")

# ---- USB-C ----
add("J1", "USBC", "USB-C", {"GND": "GND", "VBUS": "VBUS", "CC1": "CC1", "CC2": "CC2", "DP": "USB_DP_J", "DN": "USB_DN_J", "SBU1": "NC_SBU1", "SBU2": "NC_SBU2", "SHIELD": "GND"},
    "2345986-1", "TE Connectivity", "USB 2.0 use of a USB 3.1 receptacle: SuperSpeed pads and SBU left open. On the bottom side at 12 oclock, front aligned to board apex; LEDs clear of through-mounts", group="usb", nc=NC_USB_SS)
add("R4", "R", "5.1k", {"1": "CC1", "2": "GND"}, group="usb", note="USB-C sink pull-down (Rd)")
add("R5", "R", "5.1k", {"1": "CC2", "2": "GND"}, group="usb", note="USB-C sink pull-down (Rd)")
add("D1", "USBLC6", "USBLC6-2SC6", {"IO1_A": "USB_DP_J", "IO1_B": "USB_DP", "IO2_A": "USB_DN_J", "IO2_B": "USB_DN", "VBUS": "VBUS", "GND": "GND"}, "USBLC6-2SC6", "STMicroelectronics", group="usb",
    note="ESD protection on D+/D- and VBUS")
add("R6", "R", "120k", {"1": "VBUS", "2": "VBUS_SENSE"}, group="usb", note="VBUS divider (3.2 V at 5 V) into IO8: external power present, also high at reset so USB download works")
add("R7", "R", "220k", {"1": "VBUS_SENSE", "2": "GND"}, group="usb")

# ---- Battery, charger and power path (BQ24074: OUT is VSYS) ----
add("J2", "JST_BAT", "BAT", {"BAT_P": "VBAT", "BAT_N": "GND", "MECH": "GND"}, "S2B-PH-SM4-TB", "JST", "Pin 1 = positive (red), pin 2 = negative (black)", group="power")
add("U4", "BQ24074", "BQ24074RGTR", {"IN": "VBUS", "BAT": "VBAT", "OUT": "VSYS", "VSS": "GND", "CE": "GND", "EN1": "GND", "EN2": "VSYS", "ILIM": "ILIM", "ISET": "ISET", "TS": "TS",
    "CHG": "CHG_STATUS", "PGOOD": "PGOOD_NC", "TMR": "NC_TMR", "ITERM": "NC_ITERM"}, "BQ24074RGTR", "Texas Instruments", group="power",
    note="EN2=1, EN1=0: input current set by ILIM; TMR and ITERM open = default timers and 10% termination")
add("R8", "R", "1.8k", {"1": "ILIM", "2": "GND"}, group="power", note="ILIM: IINmax = KILIM/R = 1610/1.8k = 0.9 A (datasheet KILIM 1500-1720 A.ohm); VERIFY against the USB source you design for")
add("R9", "R", "1.13k", {"1": "ISET", "2": "GND"}, group="power", note="ISET: ICHG = KISET/R = 890/1.13k = 0.79 A (datasheet KISET 797-975 A.ohm) = about C/3 on 2400 mAh")
add("R10", "R", "10k", {"1": "TS", "2": "GND"}, group="power", note="No battery NTC: 10k fixed resistor TS to VSS (datasheet 10.2.2.3)")
add("C4", "C0603", "4.7uF", {"1": "VBUS", "2": "GND"}, group="power", note="IN bypass (1-10uF)")
add("C5", "C0603", "10uF", {"1": "VSYS", "2": "GND"}, group="power", note="OUT bypass (4.7-47uF)")
add("C6", "C0603", "10uF", {"1": "VBAT", "2": "GND"}, group="power", note="BAT bypass (4.7-47uF)")
add("U3", "MAX17048", "MAX17048G+T10", {"CTG": "GND", "CELL": "VBAT", "VDD": "VBAT", "GND": "GND", "QSTRT": "GND", "SCL": "I2C_SCL", "SDA": "I2C_SDA", "ALRT": "FG_ALRT_NC"},
    "MAX17048G+T10", "Analog Devices (Maxim)", group="power", note="I2C address 0x36. ALRT left open (firmware polls). A pack with a PCM and no NTC: VERIFY pack thermal protection with the supplier")
add("C7", "C", "100nF", {"1": "VBAT", "2": "GND"}, group="power", note="Gauge VDD decoupling")

# ---- 3.3 V buck-boost ----
add("U5", "TPS63802", "TPS63802DLAR", {"VIN": "VSYS", "EN": "VSYS", "MODE": "GND", "AGND": "GND", "GND": "GND", "L1": "SW1", "L2": "SW2", "VOUT": "3V3", "FB": "FB_3V3", "PG": "PG_3V3_NC"},
    "TPS63802DLAR", "Texas Instruments", group="power", note="MODE low = power save (best idle). Set MODE high (forced PWM) if RF noise from PFM is a problem")
add("L1", "L_PWR", "0.47uH", {"1": "SW1", "2": "SW2"}, "", "", "0.47 uH (0.37-0.57), saturation current >= 4 A, DCR low; pick from TPS63802 datasheet table 10-2", group="power")
add("R11", "R", "560k", {"1": "3V3", "2": "FB_3V3"}, group="power", note="VOUT = 0.5 V x (1 + 560k/100k) = 3.3 V")
add("R12", "R", "100k", {"1": "FB_3V3", "2": "GND"}, group="power")
add("C8", "C0603", "10uF", {"1": "VSYS", "2": "GND"}, group="power", note="Input: 4-5uF effective")
add("C9", "C0603", "10uF", {"1": "3V3", "2": "GND"}, group="power", note="Output: 7-8.2 uF effective after derating: fit two")
add("C10", "C0603", "10uF", {"1": "3V3", "2": "GND"}, group="power")

# ---- I2C pull-ups ----
add("R13", "R", "2.2k", {"1": "3V3", "2": "I2C_SDA"}, group="i2c")
add("R14", "R", "2.2k", {"1": "3V3", "2": "I2C_SCL"}, group="i2c")

# ---- NFC ----
add("U2", "PN7161", "PN7161A1HN/C101E", {
    "I2C_ADR0": "GND", "I2C_ADR1": "GND", "DWL_REQ": "GND", "VSS_PAD": "GND", "VSS_A": "GND", "VSS_TX": "GND", "VSS": "GND", "SDA": "I2C_SDA", "SCL": "I2C_SCL", "IRQ": "NFC_IRQ",
    "VEN": "NFC_VEN", "VDD_PAD": "3V3", "VBAT": "VSYS", "VBAT2": "VSYS", "VDD_UP": "VSYS", "VDD_TX": "VDD_TX", "TVDD_IN": "VDD_TX", "TVDD_IN2": "VDD_TX",
    "TX1": "NFC_TX1", "TX2": "NFC_TX2", "RXP": "NFC_RXP", "RXN": "NFC_RXN", "VDD_VMID": "NFC_VMID", "VDD_HF": "NFC_VDDHF", "VDD_A": "NFC_VDD", "VDD": "NFC_VDD", "VDD_D": "NFC_VDD",
    "XTAL1": "NFC_XTAL1", "XTAL2": "NFC_XTAL2", "WKUP_REQ": "GND", "ANT1": "NFC_ANT1_NC", "ANT2": "NFC_ANT2_NC", "DCDC_EN": "NFC_DCDC_NC", "CLK_REQ": "NFC_CLKREQ_NC"},
    "PN7161A1HN/C101E", "NXP", group="nfc", nc=NC_PN,
    note="I2C version (A1), address 0x28 with ADR0=ADR1=GND. TX supply from VBAT through the internal TXLDO (configuration 1: VBAT = VDD(UP)). VEN VIH 1.1 V works from the 3.3 V GPIO")
add("C11", "C", "100nF", {"1": "VSYS", "2": "GND"}, group="nfc", note="VBAT decoupling")
add("C12", "C0603", "4.7uF", {"1": "VSYS", "2": "GND"}, group="nfc", note="VBAT / VDD(UP) bulk (TBD per NXP reference design)")
add("C13", "C0603", "4.7uF", {"1": "VDD_TX", "2": "GND"}, group="nfc", note="VDD(TX) decoupling (TBD per NXP reference design)")
add("C14", "C", "100nF", {"1": "VDD_TX", "2": "GND"}, group="nfc")
add("C15", "C", "1uF", {"1": "NFC_VDD", "2": "GND"}, group="nfc", note="VDD / VDD(A) / VDD(D) decoupling (internal LDO output; TBD per NXP reference design)")
add("C16", "C", "100nF", {"1": "NFC_VDD", "2": "GND"}, group="nfc")
add("C17", "C", "100nF", {"1": "NFC_VMID", "2": "GND"}, group="nfc", note="Receiver reference VDD(VMID)")
add("C18", "C", "100nF", {"1": "NFC_VDDHF", "2": "GND"}, group="nfc", note="VDD(HF) monitor")
add("C19", "C", "100nF", {"1": "3V3", "2": "GND"}, group="nfc", note="VDD(PAD) decoupling")
add("Y1", "XTAL", "27.12MHz", {"1": "NFC_XTAL1", "2": "NFC_XTAL2", "GND_A": "GND", "GND_B": "GND"}, "", "", "27.12 MHz crystal, load capacitance and ESR per the PN7160 clock requirements (TBD part); +/-100 ppm (FCC) or better", group="nfc")
add("C20", "C", "12pF", {"1": "NFC_XTAL1", "2": "GND"}, group="nfc", note="Crystal load capacitor (TBD with the chosen crystal)")
add("C21", "C", "12pF", {"1": "NFC_XTAL2", "2": "GND"}, group="nfc", note="Crystal load capacitor (TBD with the chosen crystal)")
# antenna network: EMC filter, series and parallel matching, receive path. ALL VALUES ARE PLACEHOLDERS to tune with a VNA (NXP AN13220 / PN7160 antenna design guide).
add("L2", "L", "TBD", {"1": "NFC_TX1", "2": "NFC_EMC1"}, group="nfc", dnp=False, note="EMC filter inductor (placeholder footprint, value from the NXP reference design)")
add("L3", "L", "TBD", {"1": "NFC_TX2", "2": "NFC_EMC2"}, group="nfc", note="EMC filter inductor")
add("C22", "C", "TBD", {"1": "NFC_EMC1", "2": "GND"}, group="nfc", note="EMC filter capacitor")
add("C23", "C", "TBD", {"1": "NFC_EMC2", "2": "GND"}, group="nfc", note="EMC filter capacitor")
add("C24", "C", "TBD", {"1": "NFC_EMC1", "2": "NFC_ANT_P"}, group="nfc", note="Series matching capacitor")
add("C25", "C", "TBD", {"1": "NFC_EMC2", "2": "NFC_ANT_N"}, group="nfc", note="Series matching capacitor")
add("C26", "C", "TBD", {"1": "NFC_ANT_P", "2": "NFC_ANT_N"}, group="nfc", note="Parallel matching capacitor (tune the antenna resonance)")
add("C27", "C", "TBD", {"1": "NFC_ANT_P", "2": "NFC_RXC1"}, group="nfc", note="Receive coupling capacitor")
add("C28", "C", "TBD", {"1": "NFC_ANT_N", "2": "NFC_RXC2"}, group="nfc", note="Receive coupling capacitor")
add("R15", "R", "TBD", {"1": "NFC_RXC1", "2": "NFC_RXP"}, group="nfc", note="Receive series resistor")
add("R16", "R", "TBD", {"1": "NFC_RXC2", "2": "NFC_RXN"}, group="nfc", note="Receive series resistor")
add("J3", "FPC4", "NFC antenna", {"1": "NC_FPC1", "2": "NFC_ANT_P", "3": "NFC_ANT_N", "4": "NC_FPC4", "MECH": "GND"}, "FH19C-4S-0.5SH(10)", "Hirose", "4-pos 0.5 mm FPC, 0.2 mm bottom-contact tail; RF on 2 and 3, 1 and 4 open. Confirm antenna supplier tail stack-up", group="nfc")

# ---- Audio ----
add("U6", "MAX98357A", "MAX98357AETE+T", {"DIN": "I2S_DIN", "BCLK": "I2S_BCLK", "LRCLK": "I2S_LRCLK", "SD_MODE": "AMP_SD_R", "GAIN_SLOT": "NC_GAIN", "VDD": "VSYS", "GND": "GND",
    "OUTP": "SPK_P", "OUTN": "SPK_N"}, "MAX98357AETE+T", "Analog Devices (Maxim)", group="audio", nc=NC_AMP,
    note="GAIN_SLOT open = 9 dB. SD_MODE high through 2k = left word of the stereo stream (put the mono audio in the left slot)")
add("R17", "R", "2k", {"1": "AMP_SD", "2": "AMP_SD_R"}, group="audio", note="Series resistor on SD_MODE (datasheet: needed when VDD can be below the 3.3 V logic level)")
add("R18", "R", "100k", {"1": "AMP_SD_R", "2": "GND"}, group="audio", note="Holds the amplifier in shutdown while IO21 floats (it prints boot logs at reset)")
add("C29", "C0603", "10uF", {"1": "VSYS", "2": "GND"}, group="audio")
add("C30", "C", "100nF", {"1": "VSYS", "2": "GND"}, group="audio")
add("SPK1", "SPK", "CMS-151103-088SP", {"P": "SPK_P", "N": "SPK_N"}, "CMS-151103-088SP", "CUI Devices", "Speaker candidate from docs/ORB.md; verify assembly and acoustics", group="audio")

# ---- LED rail and ring ----
add("U7", "TPS22918", "TPS22918DBVR", {"VIN": "VSYS", "ON": "LED_EN", "VOUT": "VLED", "QOD": "VLED", "GND": "GND", "CT": "NC_CT"}, "TPS22918DBVR", "Texas Instruments", group="led",
    note="Gates the LED rail: 23 idle WS2812B draw about 1 mA each. QOD tied to VOUT discharges the rail when off. 2 A rating covers the 1.38 A worst case (23 x 60 mA)")
add("R19", "R", "100k", {"1": "LED_EN", "2": "GND"}, group="led", note="Keeps the LED rail off at reset")
add("C31", "C0603", "10uF", {"1": "VSYS", "2": "GND"}, group="led", note="Switch input")
add("C32", "CPOL", "100uF", {"P": "VLED", "N": "GND"}, group="led", note="Bulk on the LED rail (TBD: size with the real peak current)")
add("C33", "CPOL", "100uF", {"P": "VLED", "N": "GND"}, group="led")
add("U8", "SN74LV1T34", "SN74LV1T34DBVR", {"A": "LED_DATA_3V3", "VCC": "VLED", "GND": "GND", "Y": "LED_DATA_BUF"}, "SN74LV1T34DBVR", "Texas Instruments", group="led", nc=NC_BUF,
    note="Single-supply translator: 3.3 V input, output swings to VLED, so the data meets the LED's 0.7 x VDD input threshold")
add("R20", "R", "100k", {"1": "LED_DATA_3V3", "2": "GND"}, group="led", note="Keeps the input low while the MCU pin floats")
add("R21", "R", "33", {"1": "LED_DATA_BUF", "2": "LED_DATA_0"}, group="led", note="Series damping at the first LED")
N_LED = 23   # five LEDs on each upper side, thirteen below; see layout.py
for i in range(1, N_LED + 1):
    din = "LED_DATA_0" if i == 1 else f"LED_CHAIN_{i - 1}"
    dout = f"LED_CHAIN_{i}" if i < N_LED else "LED_END_NC"
    add(f"LED{i}", "WS2812B", "WS2812B", {"VDD": "VLED", "VSS": "GND", "DIN": din, "DOUT": dout}, "WS2812B", "Worldsemi", group="ring",
        note="Revision (5050 vs 2020 vs V5) still to confirm; peak 60 mA each at full white" if i == 1 else "")
    add(f"C{100 + i}", "C", "100nF", {"1": "VLED", "2": "GND"}, group="ring", note="Per-LED decoupling" if i == 1 else "")

# ---------------------------------------------------------------------------------------------------------------------------------
# The firmware's pin plan (also written to apps/orb-firmware/src/config.rs). IO number -> (function, direction, note)
# ---------------------------------------------------------------------------------------------------------------------------------
PIN_PLAN = OrderedDict([
    (0,  ("NFC_IRQ", "in", "PN7161 interrupt, push-pull, active high by default. RTC pad: can wake from deep sleep")),
    (1,  ("NFC_VEN", "out", "PN7161 hardware enable (VIH 1.1 V). RTC pad")),
    (2,  ("CHG_STATUS", "in", "BQ24074 /CHG (open drain, low while charging) with a 100k pull-up. Strapping pin: the pull-up keeps it high at reset unless charging, and the datasheet says GPIO2 does not decide the boot mode")),
    (3,  ("LED_EN", "out", "TPS22918 enable for the LED rail, 100k pull-down. RTC pad")),
    (4,  ("I2C_SDA", "io", "Shared bus: PN7161 (0x28) and MAX17048 (0x36). Default JTAG pad, unused (USB-JTAG is on 18/19)")),
    (5,  ("I2C_SCL", "io", "Shared bus. Default JTAG pad, unused")),
    (6,  ("LED_DATA", "out", "To the SN74LV1T34 input (3.3 V), which drives the ring at VLED. Default JTAG pad, unused")),
    (7,  ("AUDIO_BCLK", "out", "I2S bit clock to the MAX98357A. Default JTAG pad, unused")),
    (8,  ("USB_POWER_SENSE", "in", "VBUS divider. Strapping pin: it must be high for download mode, and USB power is what is present when downloading; any value is fine for normal boot")),
    (9,  ("BOOT", "in", "Reserved: test pad to GND for download mode (internal pull-up). Do not use")),
    (10, ("AUDIO_LRCLK", "out", "I2S word clock")),
    (18, ("USB_D-", "usb", "Native USB (serial/JTAG, DFU recovery) through the ESD array to the USB-C connector")),
    (19, ("USB_D+", "usb", "Native USB")),
    (20, ("AUDIO_DATA", "out", "I2S data (this is U0RXD; UART0 is not used, the console is on native USB)")),
    (21, ("AUDIO_SHUTDOWN", "out", "MAX98357A SD_MODE through 2k, 100k pull-down. This is U0TXD: the ROM can print boot messages here, which can briefly enable the amp at reset (set EFUSE_UART_PRINT_CONTROL to silence it)")),
])

# Pads each IC type must account for (every pad is either on a net or declared NC)
EXPECTED_PADS = {"ESP32C3FH4X": 33, "PN7161": 41, "MAX17048": 9, "BQ24074": 17, "TPS63802": 10, "MAX98357A": 17, "TPS22918": 6, "SN74LV1T34": 5, "USBLC6": 6}
# firmware function -> net name on the schematic
FUNCTION_NET = {"NFC_IRQ": "NFC_IRQ", "NFC_VEN": "NFC_VEN", "CHG_STATUS": "CHG_STATUS", "LED_EN": "LED_EN", "I2C_SDA": "I2C_SDA", "I2C_SCL": "I2C_SCL", "LED_DATA": "LED_DATA_3V3",
                "AUDIO_BCLK": "I2S_BCLK", "USB_POWER_SENSE": "VBUS_SENSE", "BOOT": "BOOT", "AUDIO_LRCLK": "I2S_LRCLK", "USB_D-": "USB_DN", "USB_D+": "USB_DP",
                "AUDIO_DATA": "I2S_DIN", "AUDIO_SHUTDOWN": "AMP_SD"}
# FH4X application GPIOs; GPIO11 remains VDD_SPI, 19-24 are NC package pads.
MODULE_IOS = {0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 18, 19, 20, 21}

# Optional CAD subdivisions of manufacturer terminals (none for the current chip).
EXTRA_PAD_NAMES = {}
