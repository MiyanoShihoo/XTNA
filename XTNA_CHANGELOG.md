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

### Changed

- `PRODUCT_IDENTITY`: `displayName` **XTNA**, CLI binary `xtna`, MCP server key `xtna`,
  config file `xtna.json`, package `xtna`.
- MCP `serverInfo.name` is `xtna`.
- Root `README.md` rewritten for this distribution.

### Not yet verified in a clean environment

- The full upstream test suite (`npm run check:pr`) has not been executed for this
  distribution. `npm run typecheck` and `npm run compile` pass, and a live
  `initialize` handshake returns `serverInfo.name = "xtna"`.
- No real-provider verification (Ghidra/IDA/Hopper) was performed for the budget change;
  the change is confined to retained-budget accounting and keeps the admission ceiling.

### Known gaps carried over

- Bidirectional feature tracing has no hop ceiling of its own; large graphs can still
  return more than a context window holds.
- Modern bundler (Vite/Webpack) chunk resolution still needs explicit asset mapping in some
  layouts.
- Windows x64 remains narrower than macOS for provider coverage.
