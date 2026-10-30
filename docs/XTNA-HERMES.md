# Hermes bytecode inspection

`npm run hermes:inspect -- --in <index.android.bundle|file.hbc> [--tables] [--disassemble] [--ast] [--json]`
reads a React Native Hermes bytecode file.

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

## Disassembly (`--disassemble`, bytecode version 84)

Every non-overflowed function body is decoded with the opcode table for **HBC 84**, generated from
`BytecodeList.def` in Hermes **v0.11.0** (the release whose `BytecodeVersion.h` declares 84) by
`scripts/hermes-opcodes.mjs`: 199 opcodes, with each jump macro expanded to its short `Addr8` form
and the `Addr32` `...Long` variant. Jump operands and `Imm32` are signed, and a branch target is
relative to the offset of the branch instruction itself.

The release matters. The earlier table came from Hermes v0.8.0 (a different bytecode version) and
mis-named opcodes; a body still "decoded to its boundary" because the loop simply read
`bytecodeSize` bytes, so the boundary check did not catch it. The fix was to regenerate the table
from the matching release, not to special-case individual files.

```text
code: 1/1 functions decoded
  global: LoadConstString 1, 1
  global: GetGlobalObject 0
  global: PutById 0, 1, 1, 6
```

Other bytecode versions are refused rather than decoded with the wrong opcode map.

## Structured AST (`--ast`, bytecode version 84)

`--ast` implies `--disassemble` and adds two layers:

- **Structure.** Instructions are split into basic blocks at branch targets and after terminators,
  then a linear structurer recovers the canonical `if`/`else` (branch over an else arm) and `while`
  (header branch to the exit plus a back edge) shapes Hermes emits.
- **Expressions.** Inside straight-line runs the register file is simulated: constants, property
  loads, `PutById`/`PutByVal` assignments, binary and unary operators, `Call2`–`Call4`, closures and
  returns become expression nodes. Any other opcode makes its destination an `unknown` expression
  that names the opcode, and unresolved reads stay `rN`.

```text
ast: 1/1 functions structured
  global (structured, 3 blocks)
    global.password = "pas.";
    if (("test".length > 0)) {
      global.console.log(global.password);
    }
    return undefined;
```

Anything that does not match a known shape becomes an `unknown` statement and marks the function
`structured: false`; the AST is never repaired by guessing.

## What it does not do

- **No try/catch recovery.** Hermes keeps exception handlers in a function-level table, not in the
  instruction stream; `Catch` is reported as an unmodelled control-flow statement.
- **No `switch` recovery.** `SwitchImm` carries an unaligned jump table; it is reported as
  unmodelled rather than decoded speculatively.
- **No cross-block data flow.** Register values are tracked inside straight-line runs; a value that
  crosses a branch renders as `rN`.
- **No V8 startup snapshots.** A V8 snapshot has no stable magic to recognise; it is not parsed.
- **No APK traversal.** Pass the extracted bundle; use `inspect_artifact`/`extract_artifact` first.

## Validation

- Unit tests cover the 128-byte header (execution and delta forms), both function-header
  generations, string resolution, a foreign magic, the HBC-84 opcode table, body boundaries,
  if/else and while structuring, the `unknown` fallback and a CLI `--ast` round trip.
- Real files: the [Zenodo Hermes benchmark](https://doi.org/10.5281/zenodo.8223659)
  (`HermesBench.zip`, CC-BY-4.0) provides 14 v84 modules with matching JS sources. All 14 parse;
  string tables decode to their identifiers (`global`, `password`, `console`, `length`, …), function
  names resolve (`global`, `z`, `b`, `c` in the closure cases), **20/20 functions decode with the
  instruction stream ending exactly at the body boundary**, and **20/20 recover a structured AST**
  whose `if`/`while` shapes match the shipped sources (`If-Else`, `ForLoop`, `WhileLoop`).
  Samples are not committed.
