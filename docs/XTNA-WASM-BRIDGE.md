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

Only the import and export sections are decoded; code, data and custom sections are skipped by
length. Nothing is instantiated, compiled, or executed.

## Output

```text
# 1 imports, 2 exports
# instantiation: line 2
  js -> wasm  exports.add  (line 3)
  wasm -> js  abort  => abortImpl  (line 1)
```

| Field               | Meaning                                                        |
| ------------------- | -------------------------------------------------------------- |
| `jsToWasm`          | glue sites that reach a real export                            |
| `wasmToJs`          | imports the glue supplies, with the provider identifier        |
| `unresolvedImports` | imports the glue never supplies (a real bug in most bundles)   |
| `unusedExports`     | exports nothing in this glue reaches                           |
| `instantiationLine` | where the import object is handed to `WebAssembly.instantiate` |

`--json` returns the full structure plus the raw import/export tables. The MCP tool
`wasm_bridge` accepts `wasm_path` and `js_path` and returns the same facts as authenticated
Evidence, with the exact file digests and explicit static-only limitations.

## Limits

- Static only: a call inside a `Function` built from a string, or an export reached through a
  computed property, is invisible.
- The import object must be an object literal or a `const` bound to one in the same file.
- `new WebAssembly.Instance` and `instantiate`/`instantiateStreaming` are recognised; other
  wrappers (bundler shims, `wasm-bindgen` internals) need a hand-written adapter.
- Function-level reachability inside the module is not computed: this links boundaries, not
  call graphs inside Wasm.
