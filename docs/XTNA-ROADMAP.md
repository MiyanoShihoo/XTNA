# Roadmap and delivery status

This page maps the architecture roadmap to what this distribution actually ships. Status is
deliberately conservative: **shipped** means implemented and covered by a check that runs
without a vendor tool; **partial** means a working slice with a named gap; **planned** means
not implemented here.

## Stability and platform (P0–P2)

| Theme | Status | Where |
|---|---|---|
| Result-budget accounting from measured heap growth instead of a fixed multiplier | shipped | `src/javascript/analysis/JavaScriptAnalysisWorker.ts`; `verify:xtna` |
| No cascading zero budget after one projection failure | shipped | same |
| Browser capture survives out-of-contract provider values | shipped | `browserScenarioCaptureValues.ts`, `PlaywrightBrowserScenarioProvider.ts` |
| Bounded bidirectional feature tracing (`max_hops`) | shipped | traversal + trace schemas |
| Vite-rooted absolute module specifier resolution | shipped | `JavaScriptArtifactPathResolution.ts` |
| Windows native artifact version/manifest sync | shipped | `scripts/sync-windows-native-manifest.mjs` |
| Secret redaction at the MCP boundary | shipped | `gateway/` (bidirectional placeholders) |
| Content-addressed cache for read-only results | shipped | `gateway/` + single-flight coalescing |
| Streaming cursor pagination for every large result | partial | paging exists per tool; not one global scheduler |
| Process-lifecycle RAII pool for all providers | partial | `src/process/ProviderProcess.ts` already owns kill/dispose; not unified across every adapter |
| MCP JSON Schema flattening for strict hosts | planned | — |
| Sandboxed dynamic execution (container / Windows Sandbox) | planned | — |
| Local model pre-filtering (Ollama / vLLM) | planned | — |

## Feature modules

| # | Module | Status | Notes |
|---:|---|---|---|
| 1 | Wasm end-to-end + JS bridge | partial | `inspect_wasm_artifact` covers imports/exports/WAT; JS↔Wasm call edges not built |
| 2 | Hermes / V8 snapshot / PyInstaller | planned | — |
| 3 | Semantic version diff | partial | `compare_functions`, `compare_artifacts`, `compare_application_versions` exist; no change narrative |
| 4 | Runtime probe generation | partial | `instrument_with_frida`, `observe_native_calls` accept caller scripts; no auto-generated probe |
| 5 | Cross-boundary causal tracing | planned | — |
| 6 | Heap snapshot query | planned | — |
| 7 | AST normalization pipeline | partial | attribute/alias recovery exists; no constant folding / unflattening |
| 8 | Symbol overlay | **shipped** | `scripts/symbol-overlay.mjs` + Ghidra/IDA export; not yet projected into analysis output |
| 9 | Algorithm/protocol fingerprinting | planned | — |
| 10 | Schema synthesis (OpenAPI/proto/TS) | planned | — |
| 11 | Standalone client SDK generation | planned | — |
| 12 | Stateful mock server | partial | `export_environment_bundle` replays recorded reads; no state machine |
| 13 | Property-graph / taint queries | **shipped** (graph-level) | scripts/taint-path.mjs: simple-path search with sanitizer barriers and hop/path ceilings; no built-in graph exporter yet |
| 14 | Hypothesis board | planned | — |
| 15 | Sub-agent orchestration | planned | MCP already allows concurrent clients; shared-ledger concurrency is the gap |
| 16 | Live web investigation UI | planned | — |
| 17 | Investigation checkpoints | planned | — |
| 18 | Dossier exporter | **shipped** | `scripts/dossier.mjs`, Markdown from an Evidence bundle |

## Agent architecture (Plan-and-Execute, sandbox tiers)

| Theme | Status |
|---|---|
| DAG planner / concurrent read-only execution | planned (server side); the gateway already coalesces duplicate reads |
| Three-tier command safety with dry-run | planned |
| Observation windowing into CAS with cursors | partial — Evidence bundles are already file-backed; no automatic summary+cursor gateway |

## Sequencing used here

1. Ship the failures that cost analysis time and can be verified offline.
2. Ship the two modules that need no vendor tool and no new dependency (symbol overlay,
   dossier).
3. Keep every unverified claim labelled `partial` or `planned` above rather than claiming a
   generation leap.
