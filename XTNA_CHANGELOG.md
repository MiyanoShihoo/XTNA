# XTNA changelog

## 1.0.0 — first XTNA release

Baseline: REA 6.8.0 (MIT-licensed upstream; this distribution is Apache-2.0). Engine evidence contracts, tool names, and `REA_*` environment
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
- `npm run overlay:render -- --procedure <selector>` renders a fresh `decompile` through the
  stored symbol overlay, so analysis text can carry analyst names without exporting a bundle
  first. The existing `--evidence` file mode is unchanged; both remain display-only.
- `npm run ast:normalize -- --in <file>` folds literal-only expressions (`!0`, `60 * 1000`,
  `"ab" + "cd"`), collapses branches whose test is a literal, and decodes escaped string
  literals. Every rule requires literal operands, so calls, getters and identifiers are never
  evaluated; untouched ranges keep their original bytes. `--json` reports what changed.
  See `docs/XTNA-AST-NORMALIZATION.md`.
- `npm run sdk:gen -- --in <capture> --out <dir>` projects a recorded HTTP capture into a typed
  client for TypeScript (global `fetch`) and Python (standard library only). Requests sharing a
  method and path template merge into one operation with path and query parameters, request
  bodies and merged response shapes. See `docs/XTNA-CLIENT-SDK.md`.
- `npm run mock:gen -- --in <capture> --out <server.mjs>` generates a dependency-free local
  server with list/read/create/update/delete over the collections the capture seeded, plus
  verbatim replay for other recorded requests and optional JSON persistence.
  See `docs/XTNA-MOCK-SERVER.md`.
- `npm run probe:gen -- --address <0x…|symbol>` emits a Frida or LLDB probe skeleton for one
  address: entry arguments from the ABI registers, the return value and a bounded backtrace,
  as JSON lines. It never attaches to a target. See `docs/XTNA-RUNTIME-PROBES.md`.
- `npm run heap:query -- --in <snapshot.heapsnapshot>` indexes a V8 heap snapshot from its
  declared record layout and answers two questions: which constructors hold the most shallow
  memory, and which instances of one exact name exist with their incoming-reference counts.
  No inspector, no execution. See `docs/XTNA-HEAP-QUERY.md`.
- `npm run trace:causal -- --browser … --ipc … --probe …` merges those streams onto one
  ordered timeline and groups them into candidate chains by explicit `traceId` or by a bounded
  time window. Ordering is evidence; causation stays an inference.
  See `docs/XTNA-CAUSAL-TRACING.md`.

### Added (gateway)

- Concurrent identical read-only calls now coalesce into one upstream request and one cache
  write; the second caller waits on the in-flight promise instead of issuing a duplicate.

### Fixed (packaging)

- `native/windows/build/manifest.json` pinned `packageVersion` to 6.8.0. A distribution
  with a different version failed every Windows native call with _"Windows native artifact
  belongs to another REA version"_ before the addon was loaded. The addon itself reports
  only its ABI and Node-API versions, so `npm run compile` now syncs the manifest version
  and artifact digest from `package.json` and the shipped binary
  (`scripts/sync-windows-native-manifest.mjs`).

### Changed

- Distribution license is now Apache-2.0; the upstream MIT text is retained in LICENSE-REA-MIT and
  attribution is in NOTICE.

- `PRODUCT_IDENTITY`: `displayName` **XTNA**, CLI binary `xtna`, MCP server key `xtna`,
  config file `xtna.json`, package `xtna`.
- MCP `serverInfo.name` is `xtna`.
- Root `README.md` rewritten for this distribution.
- Separate translated editions under `docs/readme/` are gone. The distribution ships one
  bilingual `README.md` with `#english` / `#chinese` anchors, and
  `website/locales/languages.json` lists only the shipped edition. Those 23 files were still
  upstream REA text pointing at `rea.tools`, `npm rea-agents` and the upstream Discord.
- `docs:check`'s documentation-fact check passes again: the README carries the tool-catalog
  badge and the installation / registry / catalog links the checker requires.
- User-facing documentation now invokes the shipped commands: `xtna setup`, `xtna doctor`,
  `xtna analyze`, `npx xtna@1.0.0 …` and `"xtna"` MCP server keys replace the upstream
  `rea` / `rea-agents@…` names across 72 files. Prose that refers to the incorporated REA
  analysis engine still says REA; that editorial pass is outstanding.
- The tree is formatted with `oxfmt` and `npm run format:check` is now a CI step. The gate had
  never run in CI, so 77 tracked files had drifted while the failure was being written off as
  an environment artefact. Local run artifacts (`.fixtures`, `.tmp`, `.tmp-provider`,
  `.verify`, `rea-ghidra-*`, `gateway/test-fixture`, `*.asar`) are excluded rather than
  reformatted.
- `npm run knip` passes: the manual verification scripts and release entry points that nothing
  imports are declared as entries, and `SymbolOverlayRendering.ts` — consumed by
  `scripts/overlay-render.mjs` through the compiled output — is listed as an intentional
  non-imported module.

### Verification status on the authoring host

- The full test suite (`npm run check:pr`) has not been executed for this distribution; its
  Vitest pipeline could not start under the authoring host's process sandbox (`spawn EPERM`
  in Vite's config bundler). `npm run typecheck`, `npm run lint:details`, `npm run compile`,
  and `npm run verify:xtna` pass.
- End-to-end `analyze-javascript-application` is now verified on a real Vite build and on a self-authored Electron asar (2 IPC channels paired) with the
  host temp, HOME and APPDATA redirected to E:. Result: 2 parsed files, 4 findings, 555
  retained data-flow relations, application coverage complete.
- Ghidra 12.2 verification: `analyze` opened a 5.3 MB PE in 197 s with 7,516 procedures;
  `search --kind procedures`, `decompile 0x40100b`, `instructions 0x40100b`,
  `procedure_info` and a forward `get_call_graph` traversal all returned real data.
  Batching Ghidra CLI calls still stalls — the combined `function` + `instructions` run hung
  for over 20 minutes, while one command per process and the MCP tool path both work. See
  `reports/ghidra-verification.md`.
- IDA and Hopper were not exercised on this host.
- `overlay:render` was verified in both modes: file mode against the stored PlantsVsZombies
  Evidence, and live mode against a fresh Ghidra 12.2 decompile of `0x40100b` (1 replacement,
  source unchanged). The provider-unavailable path exits non-zero with the CLI's own error
  document. See `reports/overlay-live-render.md`.

### Known gaps carried over

- Coalescing and caching cover cacheable read-only calls only; a write-capable tool always
  reaches the upstream.
- Modern bundler (Vite/Webpack) chunk resolution still needs explicit asset mapping in some
  layouts.
- Windows x64 remains narrower than macOS for provider coverage.
