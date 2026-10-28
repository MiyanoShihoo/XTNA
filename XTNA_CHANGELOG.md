# XTNA changelog

## 0.1.0 — first XTNA distribution

Baseline: REA 6.8.0 (MIT). Engine evidence contracts, tool names, and `REA_*` environment
variables are unchanged.

### Fixed

**JavaScript application analysis — result budget**

- Cumulative retained-budget accounting used a fixed 8x expansion estimate of each file's
  JSON transfer size. On large bundles the nominal budget was exhausted after roughly ten
  sources while the V8 heap remained largely free, after which every remaining source was
  offered a 0-byte semantic allowance and discarded.
  - Per-file admission still uses the conservative 8x estimate, so peak-memory safety is
    unchanged.
  - Cumulative accounting now charges the observed `used_heap_size` growth of the decode,
    with the raw transfer bytes as a floor.
  - Static checkpoints, previously charged at a fixed 6x, use the same measured
    accounting.
  - Effect: later sources keep a real budget instead of being starved by an accounting
    artifact. Files whose true retention is small are no longer rejected.

- A failed application projection on one source forced `offeredResultBudget = 0` for every
  subsequent source, so a single large file could end semantic analysis for the whole
  application. Each remaining source is now admitted against the live budget.

**Browser scenario capture — provider status values**
- `browserScenarioCaptureSchema` modelled a response status as `100..599`. CDP reports
  the status the origin actually sent, and Playwright reports `0` when it observed a
  response without a usable status line. The resulting `ZodError` escaped the tool handler
  and terminated the MCP server process.
  - The captured status schema now accepts the values a provider can observe.
  - Final capture validation uses `safeParse`; a future contract mismatch fails that one
    scenario with a typed `BrowserObservationError` naming the offending field.

### Added

- `trace_application_feature` accepts `max_hops` (1–64). Expansion stops that many edges
  from the seed; a boundary edge reaching an already-visible node is retained, and the
  result reports `summary.hop_limit`, `summary.hop_truncated`, plus a limitation naming the
  number of unexpanded boundary nodes. Omitting the field keeps the previous complete
  projection, so existing callers are unchanged.
- `npm run verify:xtna`: distribution checks that do not need the Vite pipeline
  (traversal ceiling behaviour, product identity, MCP identity probe).
- **Vite-rooted module resolution.** A module specifier that starts at the deployment
  base (`import("/assets/chunk-abc.js")`, produced by Vite when `base` is set) used to be
  rejected as an unmapped host path. The resolver now maps it onto the logical artifact
  root when that exact path is inventoried, and records the deployment assumption as a
  limitation instead of presenting the mapping as proven.
- **Optional `gateway/` (`xtna-vault`)** — a stdio MCP gateway with bidirectional secret
  redaction (session placeholders that expand only on the way back to the provider),
  content-addressed caching of read-only results, and two internal maintenance tools.
  It is a separate package so the engine's Evidence digests stay untouched.
- Upstreams may now be `transport: "http"` (Streamable HTTP) as well as `stdio`, which is
  what makes a process-level end-to-end run possible on hosts that forbid pipe spawning.
- Tool routes resolve lazily, so a client may call a tool before it has listed tools.
- `npm run vault:test:e2e` — 6 process-level checks: a real HTTP upstream process, a real
  gateway process, real stdio pipes, asserting redaction, cache replay and rehydration.
- `npm run vault:build`, `npm run vault:test`, `npm run vault`.
- `scripts/probe-vite-resolution.mjs`: resolves the specifiers of a real Vite build
  against the production resolver without running the analyzer.

### Added (gateway)

- Concurrent identical read-only calls now coalesce into one upstream request and one cache
  write; the second caller waits on the in-flight promise instead of issuing a duplicate.

### Fixed (packaging)

- `native/windows/build/manifest.json` pinned `packageVersion` to 6.8.0. A distribution
  with a different version failed every Windows native call with *"Windows native artifact
  belongs to another REA version"* before the addon was loaded. The addon itself reports
  only its ABI and Node-API versions, so `npm run compile` now syncs the manifest version
  and artifact digest from `package.json` and the shipped binary
  (`scripts/sync-windows-native-manifest.mjs`).

### Changed

- `PRODUCT_IDENTITY`: `displayName` **XTNA**, CLI binary `xtna`, MCP server key `xtna`,
  config file `xtna.json`, package `xtna`.
- MCP `serverInfo.name` is `xtna`.
- Root `README.md` rewritten for this distribution.

### Not yet verified in a clean environment

- The full upstream test suite (`npm run check:pr`) has not been executed for this
  distribution; its Vitest pipeline could not start under the authoring host's process
  sandbox (`spawn EPERM` in Vite's config bundler). `npm run typecheck`, `npm run compile`,
  and `npm run verify:xtna` pass.
- End-to-end `analyze-javascript-application` reaches the analyzer worker on Windows and
  then stops at `EPERM` while writing its owned `.source` handoff file, which the same host
  sandbox denies to spawned processes. The failure is reported as a per-source
  `execution_failure` with the exact path; it is not a code path this distribution changed.
  Re-run that command outside a restricted process sandbox to confirm the analysis result.
- No real-provider verification (Ghidra/IDA/Hopper) was performed for the budget change;
  the change is confined to retained-budget accounting and keeps the admission ceiling.

### Known gaps carried over

- The gateway has no single-flight coalescing: two identical read-only calls issued
  concurrently both miss and both reach the upstream. Sequential clients (the normal MCP
  pattern) are unaffected.
- Modern bundler (Vite/Webpack) chunk resolution still needs explicit asset mapping in some
  layouts.
- Windows x64 remains narrower than macOS for provider coverage.
