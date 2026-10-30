# Wasm ↔ JavaScript bridge

`npm run wasm:link -- --wasm module.wasm --js glue.js` and the MCP tool `wasm_bridge`
link a WebAssembly module to the JavaScript that instantiates it, in both directions.

## Why

`inspect_wasm_artifact` answers "what does this module import and export". It cannot answer
"which JavaScript function feeds `env.abort`, and which exports does the page actually call".
Without that, a Wasm-heavy application is a black box sitting in the middle of the call graph.

## What it reads

| Side | Source                  | Facts                                                                              |
| ---- | ----------------------- | ---------------------------------------------------------------------------------- |
| Wasm | binary sections 2 and 7 | imports (module, name, kind) and exports (name, kind)                              |
| JS   | the glue file           | import-object bindings, `WebAssembly.instantiate` line, `.exports.<name>` accesses |

Only the import and export sections are decoded here; code, data and custom sections are skipped
by length. Nothing is instantiated, compiled, or executed. The call graph below reads the code
section separately and is a different tool.

## Output

```text
# 1 imports, 2 exports
# instantiation: line 2
  js -> wasm  exports.add  (line 3)
  wasm -> js  abort  => abortImpl  (line 1)
```

| Field               | Meaning                                                             |
| ------------------- | ------------------------------------------------------------------- |
| `jsToWasm`          | glue sites that reach a real export                                 |
| `wasmToJs`          | imports the glue supplies, with the provider identifier             |
| `functions`         | function index space: imported/defined, type index and export names |
| `unresolvedImports` | imports the glue never supplies (a real bug in most bundles)        |
| `unusedExports`     | exports nothing in this glue reaches                                |
| `instantiationLine` | where the import object is handed to `WebAssembly.instantiate`      |

`--json` returns the full structure plus the raw import/export tables. The MCP tool
`wasm_bridge` accepts `wasm_path` and `js_path` and returns the same facts as authenticated
Evidence, with the exact file digests and explicit static-only limitations.

## Call graph

`npm run wasm:calls -- --in module.wasm [--json]` decodes the function body section and reports
every `call` / `call_indirect` site:

```text
wasm call graph: module.wasm
functions: 67 defined, 1 imported
edges: 396
undecoded: none
  f1 -> f9
  f1 -> f8
```

| Field                | Meaning                                                                                 |
| -------------------- | --------------------------------------------------------------------------------------- |
| `functions`          | defined functions with index, export name when present, call sites                      |
| `edges`              | `{from, to, kind}`; `call_indirect` records `to: null` plus its type index              |
| `undecodedFunctions` | functions where an unknown opcode (SIMD, atomics, future proposals) stopped the decoder |
| `truncated`          | the 20,000-edge cap was hit                                                             |

Operand skipping follows an explicit opcode table (core MVP plus sign-extension, bulk-memory,
tail-call and the standardized SIMD map, including memory, const/shuffle, lane and arithmetic
immediates). A function is either fully decoded or reported undecoded with the opcode that
stopped it (`undecodedAt`) — it is never guessed at. As a self-check, a decode that does not end
exactly on the function's final `end` is reported undecoded rather than trusted. `call_indirect`
targets stay unknown because they depend on the runtime table.

## Module discovery

`npm run wasm:scan -- --in <dir> [--json] [--max-files N]` walks a directory and parses every
module it finds. Detection is by magic (`\0asm`), so a renamed or extension-less module is still
found; non-wasm files are counted and skipped rather than reported as empty modules.

```text
wasm scan: ./dist
modules: 2 (files examined 14, non-wasm 12)
  ./dist/a.wasm  functions=67 edges=396 undecoded=0
```

The walk is bounded: 500 files, 16 MiB per module and eight directory levels by default. Hitting
a bound sets `truncated` and names the limit; an unreadable file becomes a limitation row, not a
silent omission.

## Limits

- Static only: a call inside a `Function` built from a string, or an export reached through a
  computed property, is invisible.
- The import object must be an object literal or a `const` bound to one in the same file.
- `new WebAssembly.Instance` and `instantiate`/`instantiateStreaming` are recognised; other
  wrappers (bundler shims, `wasm-bindgen` internals) need a hand-written adapter.
- The call graph is static structure: no reachability, no runtime table resolution, and no
  indirect target inference.
- SIMD is decoded for the standardized opcode map; **atomics** (`0xFE`) and unassigned
  subopcodes still stop a function as undecoded rather than being skipped blindly.
- Directory scanning is local files only; it does not open APKs, ASAR archives or other
  containers — extract those first.
