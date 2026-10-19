# Orb protocol v1: shared test vectors

Both `apps/orb-firmware/src/message.rs` (`golden_vectors`) and `apps/merchant-terminal/Tests` (`testOrbV1GoldenVectors`) assert these bytes.
Format: `| opcode u8 | message id u16 | session u16 | body |`, big-endian. Opcodes are provisional until tested on hardware.

| Message | Header (id, session) | Bytes |
| --- | --- | --- |
| Heartbeat counter 1 | 1, 2 | `02 00 01 00 02 00 00 00 01` |
| BeginPayment attempt `AA`x16, 1250 cents, USD, 30 s | 0x10, 3 | `03 00 10 00 03` + `AA`x16 + `00 00 00 00 00 00 04 E2` + `55 53 44` + `1E` |
| StateChanged ConnectedIdle | 5, 1 | `84 00 05 00 01 03` |

Fragments: `| flags u8 (bit0 first, bit1 last) | message id u16 | index u8 | chunk |`; usable capacity = ATT MTU - 3, chunk = capacity - 4.
