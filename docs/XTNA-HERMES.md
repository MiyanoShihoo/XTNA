# Hermes bytecode inspection

`npm run hermes:inspect -- --in <index.android.bundle> [--json]` reads the header of a React
Native Hermes bytecode file (`.hbc`, usually shipped as `assets/index.android.bundle` inside an
APK).

## What the header contains

The first 60 bytes have kept the same layout across Hermes releases:

| Offset | Size | Field                                          |
| -----: | ---: | ---------------------------------------------- |
|      0 |    4 | magic `0xc61fbc3f` (little-endian)             |
|      4 |    4 | bytecode version                               |
|      8 |   20 | SHA-1 of the source that produced the bytecode |
|     28 |    4 | declared total file length                     |
|     32 |    4 | index of the global-code function              |
|     36 |    4 | function count                                 |
|     40 |    4 | string-kind count                              |
|     44 |    4 | identifier count                               |
|     48 |    4 | small-string count                             |
|     52 |    4 | overflow-string count                          |
|     56 |    4 | string-storage byte length                     |

The tool reports those facts, whether the version falls inside the range whose prefix is known
(50–120), and whether the declared length matches the file on disk. A non-Hermes file exits `3`
with the leading four bytes in the report; a file shorter than the header exits `3` as
`truncated`.

## What it does not do

- **No table decoding.** The string table, function table and bytecode sections changed layout
  between Hermes releases; this tool does not guess at them.
- **No AST.** Structured extraction from Hermes bytecode needs a version-aware bytecode
  deserializer; that remains an open gap, so the roadmap keeps feature 2 **partial**.
- **No V8 startup snapshots.** A V8 snapshot has no stable magic to recognize; it is not parsed
  here, and the roadmap says so rather than pretending detection works.
- **No APK traversal.** Pass the extracted bundle; use `inspect_artifact`/`extract_artifact` to
  get it out of the APK.

## Example

```bash
npm run hermes:inspect -- --in android/app/src/main/assets/index.android.bundle
# Hermes bytecode: .../index.android.bundle
# version: 96
# source hash: 3f2c...
# functions: 4211 (global code #0)
# strings: 18233 small, 41 overflow, 902 identifiers, 3 kinds
# string storage: 812344 bytes
# declared length: 1923441 bytes; file: 1923441 bytes
# limits: header only; tables and AST are not decoded
```

## Validation

Five unit tests cover a modern header, an older version, a foreign magic, a truncated prefix and
an out-of-range version; one acceptance test runs the CLI against a synthetic 1 KiB bundle and a
non-Hermes file. **No real-world bundle was parsed in this pass** — the fixtures are synthetic.
