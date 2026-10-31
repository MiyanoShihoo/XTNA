# V8 snapshot inspection

`npm run v8:inspect -- --in <snapshot_blob.bin|v8_context_snapshot.bin> [--json]` inventories
V8 snapshot containers without executing V8, loading a matching build, or deserializing the heap.

## What is recognized

### Chromium context snapshot

Observed on a Chrome/V8 15.6.75 `v8_context_snapshot.bin`:

|  Offset | Meaning                                                     |
| ------: | ----------------------------------------------------------- |
|  `0x00` | format version (u32)                                        |
|  `0x04` | flags (u32)                                                 |
|  `0x08` | checksum (u64, recorded not verified)                       |
|  `0x10` | V8 version string, NUL-padded, 64 bytes                     |
|  `0x50` | six u32 declared section offsets (`0` terminates/ignores)   |
|  `0x68` | `0xC0DE06D6` magic; the low 16 bits vary by snapshot format |
| section | `0xC0DE....` magic + u32 payload length + payload           |

The inspector reports the header, every declared section that starts with a recognized magic,
payload lengths, observed byte ranges, truncation and coverage. It does **not** assign section
labels: the header does not prove whether a section is a startup blob, read-only heap, or a context.

### Raw SnapshotData

If the first u32 has the `0xC0DE` prefix, the file is reported as `v8-snapshot-data` with its magic,
payload byte count and explicit unknowns. No raw payload decoding is attempted.

## What remains unknown

- Heap object graph, maps, strings, code objects, external references and roots.
- The checksum is recorded but not verified without the matching V8 build.
- Section labels and object semantics are version-specific.
- A bounded prefix (16 MiB) is examined; `coverage.complete` is false for larger files.
- This is not a V8 startup-snapshot _deserializer_; it is a container inventory.

## Validation

- Unit tests build a synthetic Chromium context snapshot and cover header fields, multi-section
  offsets, declared truncation, raw SnapshotData, unrecognized input and bounded-prefix coverage.
- Real-file check against the local Chromium headless shell
  (`v8_context_snapshot.bin`, 752,968 bytes, V8 15.6.75) reports five declared sections.

## Why not a full parser

V8 snapshots are version-locked serialized heaps with no stable public object schema. A parser that
printed object names or code without the matching V8 build would be guessing. This module keeps the
observed container facts and labels the rest as unknown.
