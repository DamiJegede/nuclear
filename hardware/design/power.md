# Orb power tree and budget

All figures are from the datasheets named below or are labelled **estimate**. Nothing here is a measurement: measure on the first assembled board.

```
USB-C 5 V -> ESD (USBLC6) -> BQ24074 IN
                               |  charger + power path
                               +-- BAT  <-> battery (Grepow GRP7550040-based, 2.4-2.5 Ah est., PCM, no NTC)  [MAX17048 gauge on the cell]
                               +-- OUT = VSYS  (4.3-4.5 V on USB; battery voltage less ~0.1 V at 1 A on battery: "supplement mode")
                                      |-- TPS63802 buck-boost -> 3V3 : ESP32-C3-MINI-1, PN7161 host I/O (VDD(PAD)), I2C pull-ups
                                      |-- PN7161 VBAT and VDD(UP): its TX LDO makes the RF supply from VSYS (datasheet "configuration 1")
                                      |-- MAX98357A VDD
                                      `-- TPS22918 load switch -> VLED : 23 x WS2812B, SN74LV1T34 (data level shifter)
```

## Parts and why

| Block | Part | Datasheet facts used |
| --- | --- | --- |
| Charger / power path | BQ24074RGTR | 4.35-10.5 V in; OUT regulated 4.3-4.5 V; IOUT and IBAT (discharge) rated 4.5 A; charge up to 1.5 A; battery supplement mode; ISET: ICHG = 890/R (KISET 797-975 A.ohm); ILIM: IIN = 1610/R (KILIM 1500-1720); no NTC: 10 k from TS to VSS (section 10.2.2.3). EN2=1 EN1=0 selects the ILIM resistor. |
| 3.3 V | TPS63802DLAR | 1.3-5.5 V in, 2 A at 3.3 V (from 2.3 V in), Iq 11 uA, VFB 0.5 V so 560 k / 100 k = 3.30 V; inductor 0.47 uH (0.37-0.57), output 7-8.2 uF effective. MODE low = power save. |
| Fuel gauge | MAX17048G+T10 | CELL and VDD on the cell, I2C 0x36, ALRT open drain (left unused). |
| NFC | PN7161A1HN/C101E | I2C version, HVQFN40, 0x28 with ADR0=ADR1=GND; VEN VIH 1.1 V (3.3 V GPIO is fine); TXLDO 250 mA continuous; VBAT/VDD(UP) = battery supply is "configuration 1"; low-power polling about 100 uA average. |
| Audio | MAX98357A (TQFN-16) | 2.5-5.5 V, 2.4 mA quiescent, <0.6 uA shutdown (SD_MODE low), I2S with no MCLK. SD_MODE high through 2 k = left word; 2 k because VDD (down to 3.0 V) can be below the 3.3 V logic. |
| LED rail | TPS22918DBVR + SN74LV1T34DBVR | Switch 1-5.5 V, 2 A; QOD to VOUT discharges the rail. The buffer is a single-supply level translator (VIH 2.0 V at VCC 5 V): 3.3 V in, VLED out, which meets the WS2812B input threshold of 0.7 x VDD. |

## Budget (estimates)

| Load | Current | Source |
| --- | --- | --- |
| 23 x WS2812B, worst case all white | 23 x 60 mA = **1.38 A** | LED datasheet (peak); a normal colour at full brightness is about a third of that |
| PN7161 transmitting | up to 250 mA from VSYS | TXLDO limit, datasheet |
| ESP32-C3 BLE | 170 mA peak at 0 dBm TX, 86 mA RX; light sleep 130 uA, deep sleep 5 uA | ESP32-C3-MINI-1 datasheet tables 6-5 and 6-7 |
| MAX98357A | 2.4 mA idle, **0.6 uA** in shutdown; at 8 ohm about 0.2 A for 0.5 W | datasheet; speaker drive level is an estimate |
| Everything idle, LED rail off, amp shut down, BLE connected | **about 0.5 mA** (estimate: BLE connection about 0.3 mA, gauge 23 uA, buck-boost 11 uA, switch and buffer leakage) | estimate |

Worst case at once (LEDs white + NFC + BLE + amp) is about 2.4 A at the battery, which is 1 C on a 2.4 Ah pack. The BQ24074 OUT and BAT paths are rated 4.5 A, and the USB input is limited to 0.9 A (ILIM 1.8 k), so on USB the rest comes from the battery in supplement mode. **Open items:** the Grepow pack's continuous discharge rating (ask the supplier), the 12 mm thick pack's PCM trip current, and the inrush into the two 100 uF bulk capacitors when the LED switch closes (fit a CT capacitor on the TPS22918 so inrush stays well under 1 A; the BQ24074 shuts OUT if it sags below the battery by VO(SC2)).

Standby reasoning: 2400 mAh / 0.5 mA is about 4,800 h, so the cell is not what limits standby; the real limit is how often it is read and lit. Re-measure after the first build.

## Charging

ISET 1.13 k gives 0.79 A (about C/3 on 2.4 Ah). The ILIM 1.8 k gives a 0.9 A input limit; charging and the system share it (DPPM reduces charge current first). A USB source that only offers the default 500 mA will sag: the BQ24074 input voltage regulation lowers the draw instead of collapsing the source. Termination current is the default 10% (ITERM open) and the safety timers are the defaults (TMR open).
