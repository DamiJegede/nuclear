# Orb GPIO pin plan (ESP32-C3FH4X)

Generated from `hardware/src/design.py` by `build.py`; `check.py` fails the build if the schematic and this plan disagree. The same assignments are in `apps/orb-firmware/src/config.rs`.

| IO | Pad | Function | Net | Dir | Notes |
| --- | --- | --- | --- | --- | --- |
| IO0 | 4 | NFC_IRQ | NFC_IRQ | in | PN7161 interrupt, push-pull, active high by default. RTC pad: can wake from deep sleep |
| IO1 | 5 | NFC_VEN | NFC_VEN | out | PN7161 hardware enable (VIH 1.1 V). RTC pad |
| IO2 | 6 | CHG_STATUS | CHG_STATUS | in | BQ24074 /CHG (open drain, low while charging) with a 100k pull-up. Strapping pin: the pull-up keeps it high at reset unless charging, and the datasheet says GPIO2 does not decide the boot mode |
| IO3 | 8 | LED_EN | LED_EN | out | TPS22918 enable for the LED rail, 100k pull-down. RTC pad |
| IO4 | 9 | I2C_SDA | I2C_SDA | io | Shared bus: PN7161 (0x28) and MAX17048 (0x36). Default JTAG pad, unused (USB-JTAG is on 18/19) |
| IO5 | 10 | I2C_SCL | I2C_SCL | io | Shared bus. Default JTAG pad, unused |
| IO6 | 12 | LED_DATA | LED_DATA_3V3 | out | To the SN74LV1T34 input (3.3 V), which drives the ring at VLED. Default JTAG pad, unused |
| IO7 | 13 | AUDIO_BCLK | I2S_BCLK | out | I2S bit clock to the MAX98357A. Default JTAG pad, unused |
| IO8 | 14 | USB_POWER_SENSE | VBUS_SENSE | in | VBUS divider. Strapping pin: it must be high for download mode, and USB power is what is present when downloading; any value is fine for normal boot |
| IO9 | 15 | BOOT | BOOT | in | Reserved: test pad to GND for download mode (internal pull-up). Do not use |
| IO10 | 16 | AUDIO_LRCLK | I2S_LRCLK | out | I2S word clock |
| IO18 | 25 | USB_D- | USB_DN | usb | Native USB (serial/JTAG, DFU recovery) through the ESD array to the USB-C connector |
| IO19 | 26 | USB_D+ | USB_DP | usb | Native USB |
| IO20 | 27 | AUDIO_DATA | I2S_DIN | out | I2S data (this is U0RXD; UART0 is not used, the console is on native USB) |
| IO21 | 28 | AUDIO_SHUTDOWN | AMP_SD | out | MAX98357A SD_MODE through 2k, 100k pull-down. This is U0TXD: the ROM can print boot messages here, which can briefly enable the amp at reset (set EFUSE_UART_PRINT_CONTROL to silence it) |

**Chip facts used** (ESP32-C3 datasheet v2.4, FH4X pin layout): GPIO0-10 and 18-21 retain the existing assignments. GPIO11 is reserved as VDD_SPI; package pads 19-24 are NC for the in-package flash variant. The 40 MHz crystal uses dedicated pads 29/30, not GPIO0/1.  Strapping pins are GPIO2, GPIO8, GPIO9: SPI boot needs GPIO9 = 1 (internal weak pull-up, so a floating pad boots normally); download mode (USB-Serial-JTAG or UART) needs GPIO9 = 0 and GPIO8 = 1 at reset. GPIO2 and GPIO8 are free to use as normal pins after reset (the latches keep the sampled value). GPIO18/19 are the native USB D-/D+. Deep-sleep wake works on GPIO0-5 only.

**Why the NFC controller is on I2C, not SPI.** The firmware constants had four SPI pins for the PN7161. The design uses 12 application GPIOs plus USB D+/D- and BOOT (15 total); SPI would add four more. The PN7161 host interface is fused at the factory (A = I2C, B = SPI, datasheet table 2), so the order code decides: use **PN7161A1HN/C101E (I2C)**. It shares the bus with the MAX17048 (0x28 and 0x36, no clash).
