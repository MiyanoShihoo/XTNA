# Hermes bytecode inspection

`npm run hermes:inspect -- --in <index.android.bundle|file.hbc> [--tables] [--json]` reads a React
Native Hermes bytecode file.

## Header

The header is the 128-byte `BytecodeFileHeader` from
`include/hermes/BCGen/HBC/BytecodeFileFormat.h`:

| Offset | Size | Field                                                                                               |
| -----: | ---: | --------------------------------------------------------------------------------------------------- |
|      0 |    8 | magic `0x1F1903C103BC1FC6` (little-endian); the complement marks a delta-prepped file               |
|      8 |    4 | bytecode version                                                                                    |
|     12 |   20 | SHA-1 of the source that produced the bytecode                                                      |
|     32 |    4 | declared total file length                                                                          |
|     36 |    4 | global-code function index                                                                          |
|     40 |    4 | function count                                                                                      |
|     44 |    4 | string-kind run count                                                                               |
|     48 |    4 | identifier count                                                                                    |
|     52 |    4 | small-string count                                                                                  |
|     56 |    4 | overflow-string count                                                                               |
|     60 |    4 | string-storage byte length                                                                          |
|    64+ |    … | bigint/regexp/literal/shape counters, segment id, CJS and source tables (layout depends on version) |

Two header generations are recognised: **v76–v88** carries array/object buffers and no bigint
table; **v89+** adds bigint and shape tables and moves the tail fields. The version is read first
and selects the layout — a v84 file is never parsed with the v89 field map.

## Tables (`--tables`)

After the header come the small function headers (16 bytes on v76–v88, 12 bytes on v89+), the
run-length string kinds, the identifier hashes, the small string table (4 bytes per entry:
`isUTF16:1 | offset:23 | length:8`), the overflow table, and the string storage. Names are
resolved through the string table; an overflowed function header is reported as
`overflowed: true` instead of being guessed at.

```text
strings: 7 (first: global, pas., test, log, console, length, password)
functions: global
```

## What it does not do

- **No bytecode body decoding and no AST.** Function offsets/sizes are reported, instructions are
  not.
- **No V8 startup snapshots.** A V8 snapshot has no stable magic to recognise; it is not parsed.
- **No APK traversal.** Pass the extracted bundle; use `inspect_artifact`/`extract_artifact` first.

## Validation

- Unit tests cover the 128-byte header (execution and delta forms), both function-header
  generations, string resolution and a foreign magic.
- Real files: the [Zenodo Hermes benchmark](https://doi.org/10.5281/zenodo.8223659)
  (`HermesBench.zip`, CC-BY-4.0) provides 14 v84 modules with matching JS sources. All 14 parse;
  string tables decode to their identifiers (`global`, `password`, `console`, `length`, …) and
  function names resolve (`global`, `z`, `b`, `c` in the closure cases). Samples are not committed.
