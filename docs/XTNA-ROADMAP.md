# Roadmap and delivery status

This page maps the architecture roadmap to what this distribution actually ships. Status is
deliberately conservative: **shipped** means implemented and covered by a check that runs
without a vendor tool; **partial** means a working slice with a named gap; **planned** means
not implemented here.

## Stability and platform (P0–P2)

| Theme                                                                                                    | Status                    | Where                                                                                                                                                                                  |
| -------------------------------------------------------------------------------------------------------- | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Result-budget accounting from measured heap growth instead of a fixed multiplier                         | shipped                   | `src/javascript/analysis/JavaScriptAnalysisWorker.ts`; `verify:xtna`                                                                                                                   |
| No cascading zero budget after one projection failure                                                    | shipped                   | same                                                                                                                                                                                   |
| Browser capture survives out-of-contract provider values                                                 | shipped                   | `browserScenarioCaptureValues.ts`, `PlaywrightBrowserScenarioProvider.ts`                                                                                                              |
| Bounded bidirectional feature tracing (`max_hops`)                                                       | shipped                   | traversal + trace schemas                                                                                                                                                              |
| Vite-rooted absolute module specifier resolution                                                         | shipped                   | `JavaScriptArtifactPathResolution.ts`                                                                                                                                                  |
| Windows native artifact version/manifest sync                                                            | shipped                   | `scripts/sync-windows-native-manifest.mjs`                                                                                                                                             |
| Secret redaction at the MCP boundary                                                                     | shipped                   | `gateway/` (bidirectional placeholders)                                                                                                                                                |
| Content-addressed cache for read-only results                                                            | shipped                   | `gateway/` + single-flight coalescing                                                                                                                                                  |
| Streaming cursor pagination for every large result                                                       | partial                   | paging exists per tool; not one global scheduler                                                                                                                                       |
| Process-lifecycle RAII pool for all providers                                                            | partial                   | `src/process/ProviderProcess.ts` already owns kill/dispose; not unified across every adapter                                                                                           |
| MCP JSON Schema flattening for strict hosts                                                              | **shipped** (root unions) | `src/contracts/inputSchemaPresentation.ts`: root `anyOf`/`oneOf`/`allOf` presented as one object with self-contained property schemas and inline descriptions; nested unions untouched |
| Sandboxed dynamic execution (container / Windows Sandbox)                                                | planned                   | —                                                                                                                                                                                      |
| Local model pre-filtering (Ollama / vLLM)                                                                | planned                   | —                                                                                                                                                                                      |
| Ghidra provider verification (analyze / search / decompile / instructions / procedure info / call graph) | **verified**              | reports/ghidra-verification.md; CLI function stalls, MCP tool path works                                                                                                               |
| JavaScript analysis end-to-end on a real build                                                           | **verified**              | Vite dist: 2 files, 4 findings, 555 data-flow relations                                                                                                                                |
| Electron application analysis                                                                            | **verified**              | Self-authored asar: 1 window, 1 preload, 2 contextBridge members, 2 IPC channels paired; see reports/electron-verification.md                                                          |

## Feature modules

|   # | Module                              | Status                                | Notes                                                                                                                                                   |
| --: | ----------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
|   1 | Wasm end-to-end + JS bridge         | partial                               | `inspect_wasm_artifact` covers imports/exports/WAT; JS↔Wasm call edges not built                                                                        |
|   2 | Hermes / V8 snapshot / PyInstaller  | planned                               | —                                                                                                                                                       |
|   3 | Semantic version diff               | partial                               | `compare_functions`, `compare_artifacts`, `compare_application_versions` exist; no change narrative                                                     |
|   4 | Runtime probe generation            | **shipped** (skeleton)                | `npm run probe:gen`: address to a Frida or LLDB probe skeleton that records arguments, return value and a backtrace; target selection stays manual      |
|   5 | Cross-boundary causal tracing       | **shipped** (merge + candidates)      | `npm run trace:causal`: browser/IPC/probe streams to one timeline, chains by explicit trace id or bounded window; causation stays an inference          |
|   6 | Heap snapshot query                 | **shipped** (shallow)                 | `npm run heap:query`: V8 .heapsnapshot to a constructor summary or instance list with incoming-reference counts; shallow sizes only, no dominators      |
|   7 | AST normalization pipeline          | **partial** (literal folding shipped) | `npm run ast:normalize`: literal folding, literal-branch collapse and escaped-string decoding; no constant propagation across variables                 |
|   8 | Symbol overlay                      | **shipped** (display projection)      | `scripts/symbol-overlay.mjs` + `overlay:render` (Evidence bundle or live decompile); MCP tool results still carry the decompiler's own names            |
|   9 | Algorithm/protocol fingerprinting   | **shipped** (constant signatures)     | scripts/crypto-radar.mjs: AES/SHA/CRC tables, compression magics, Base64 alphabets, PEM headers with offsets                                            |
|  10 | Schema synthesis (OpenAPI/proto/TS) | **partial**                           | scripts/schema-synth.mjs: JSON samples to TypeScript, Pydantic or OpenAPI 3.1; no wire-format inference                                                 |
|  11 | Standalone client SDK generation    | **shipped** (capture to client)       | `npm run sdk:gen`: HAR entries to typed TypeScript and Python clients, path/query/body/response shapes folded per operation                             |
|  12 | Stateful mock server                | **shipped** (capture to CRUD)         | `npm run mock:gen`: HAR to a dependency-free local server with list/read/create/update/delete over the seeded collections and optional JSON persistence |
|  13 | Property-graph / taint queries      | **shipped** (graph-level)             | scripts/taint-path.mjs for path search and scripts/graph-export.mjs to project an application graph into that format                                    |
|  14 | Hypothesis board                    | **shipped** (file-level)              | scripts/hypothesis.mjs: claims with confidence, status, supporting and contradicting evidence                                                           |
|  15 | Sub-agent orchestration             | planned                               | MCP already allows concurrent clients; shared-ledger concurrency is the gap                                                                             |
|  16 | Live web investigation UI           | **partial**                           | scripts/panel.mjs: single-file offline panel (evidence, limitations, unknowns, symbols, hypotheses, checkpoints); no live server or topology graph      |
|  17 | Investigation checkpoints           | **shipped** (file-level)              | scripts/checkpoint.mjs: hash-verified snapshots of Evidence bundles and overlay files; no process state, no branching                                   |
|  18 | Dossier exporter                    | **shipped**                           | `scripts/dossier.mjs`, Markdown from an Evidence bundle                                                                                                 |

## Agent architecture (Plan-and-Execute, sandbox tiers)

| Theme                                        | Status                                                                                  |
| -------------------------------------------- | --------------------------------------------------------------------------------------- |
| DAG planner / concurrent read-only execution | planned (server side); the gateway already coalesces duplicate reads                    |
| Three-tier command safety with dry-run       | planned                                                                                 |
| Observation windowing into CAS with cursors  | partial — Evidence bundles are already file-backed; no automatic summary+cursor gateway |

## Sequencing used here

1. Ship the failures that cost analysis time and can be verified offline.
2. Ship the two modules that need no vendor tool and no new dependency (symbol overlay,
   dossier).
3. Keep every unverified claim labelled `partial` or `planned` above rather than claiming a
   generation leap.
