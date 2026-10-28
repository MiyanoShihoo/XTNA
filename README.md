# XTNA

**Reverse engineer anything — from your terminal or your agent.**

XTNA is a local-first reverse-engineering toolkit: one CLI, one MCP server, and a shared
evidence model across binaries, managed code, JavaScript/Electron applications, browser
pages, mobile packages, firmware, and captured traffic.

XTNA is built on the REA analysis engine (MIT). The engine keeps its evidence contracts;
this distribution carries its own identity, its own release cadence, and the fixes listed
below.

---

## What XTNA changes

### 1. Result-budget accounting no longer starves later sources

`analyze_javascript_application` admits each source against a parent result budget. The
engine previously charged **every** retained file with a fixed 8x expansion estimate of
its JSON transfer size and accumulated those estimates. Large bundles exhausted the
nominal budget after roughly ten sources while the V8 heap was still mostly free; every
remaining source was then offered a **0-byte** semantic allowance and dropped.

XTNA charges what the decode actually retained:

- the per-file 8x estimate remains the **admission ceiling** for one file (OOM safety);
- cumulative accounting uses the observed `used_heap_size` growth of the decode, with the
  raw byte count as a floor;
- the same correction applies to static checkpoints, which were charged at 6x.

A related cascade is gone: a projection failure on one source used to force
`offeredResultBudget = 0` for *all* later sources. Each remaining source is now admitted
against the live budget, so a small file can still complete after a large one overflowed.
Only genuine heap exhaustion closes a run.

### 2. A provider status value can no longer kill the MCP server

`capture_browser_scenario` modelled HTTP response status as `100..599`. CDP reports the
status the server actually sent — non-standard servers answer outside that range, and
Playwright reports `0` for a response it observed without a usable status line. The
`ZodError` from that mismatch escaped the tool handler and terminated the MCP server.

- the captured status schema now accepts the values a provider can actually observe;
- the final capture is validated with `safeParse`, so a future contract mismatch fails
  **one scenario** with a typed `BrowserObservationError` that names the offending field
  instead of taking the process down.

### 4. Bounded bidirectional tracing

`trace_application_feature` had no ceiling: `direction: "both"` walked the entire reachable
graph. It now accepts `max_hops` (1–64). Expansion stops at the ceiling, the response
reports `hop_limit` / `hop_truncated`, and any reachability past the boundary is stated as
unknown instead of being silently absent. Omitting the field preserves the old behaviour.

### 5. Product identity

`PRODUCT_IDENTITY` now carries `XTNA`, `xtna` as the CLI binary, `xtna` as the MCP server
key, and `xtna.json` as the config file. `tools/list` negotiation reports
`serverInfo.name = "xtna"`.

---

## Quick start

```bash
npm ci
npm run compile
node scripts/rea.mjs --help
```

Run the MCP server:

```bash
node scripts/rea.mjs mcp
```

Register it with an MCP client:

```json
{
  "mcpServers": {
    "xtna": {
      "command": "npx",
      "args": ["-y", "xtna@0.1.0", "mcp"]
    }
  }
}
```

## Choosing a deep-analysis provider

XTNA does not ship a decompiler. It drives the tools you already have — Ghidra, IDA,
Hopper, Rizin, GNU objdump — and normalizes their output into one evidence model. See
`docs/` for per-provider setup. Providers remain bring-your-own; the installer never
installs or upgrades them.

## Optional gateway: xtna-vault

`gateway/` is a separate stdio MCP server that sits in front of XTNA (or any MCP
server) and does two things the engine deliberately does not:

1. **Bidirectional secret redaction.** Values that look like credentials are replaced
   in tool output with session placeholders such as `<vault:1:ab12cd>`. Pass a
   placeholder back in any tool argument and the gateway restores the real value before
   the call reaches the upstream server — the model never holds the plaintext but can
   still use it.
2. **Content-addressed caching.** Tool results annotated `readOnlyHint: true`, resource
   reads and prompt fetches are stored by canonical request hash and replayed within
   their TTL. Anything without a read-only annotation is never cached.

It lives outside the evidence path on purpose: redacting inside the engine would break
the digests that make Evidence verifiable.

```bash
npm --prefix gateway install
npm run vault:build
npm run vault:test          # 11 protocol-level checks, in-memory transport
npm run vault:test:e2e      # 6 process-level checks: real HTTP upstream, real stdio pipes

node gateway/dist/index.js --config gateway/xtna-vault.example.json
```

Register it instead of the server directly:

```json
{
  "mcpServers": {
    "xtna": {
      "command": "node",
      "args": ["gateway/dist/index.js", "--config", "gateway/xtna-vault.json"]
    }
  }
}
```

Two internal tools are exposed to the model: `vault_stats` (placeholder count, cache
hits/misses) and `vault_cache_clear` (drop one upstream or everything).

## Build and verification

```bash
npm ci --ignore-scripts     # husky hooks are optional in a fork
npm run typecheck
npm run compile
```

`npm run check:pr` is the full upstream gate and is expensive; run it before a release.

## Compatibility with REA

- Evidence schemas, tool names, and CLI subcommands are unchanged.
- `REA_*` environment variables keep working.
- Configuration written for REA is read as-is; XTNA writes `xtna.json` for new setups.

## Roadmap

- Optional secret-redaction gateway in front of the MCP server (placeholder tokens that
  expand only on the way back to the provider) — kept **outside** the evidence path so
  digests stay verifiable.
- Content-addressed reuse of completed analysis results across sessions.
- Bundler-aware chunk resolution for Vite/Webpack layouts that inline `assets/*.js`.

## License

MIT. XTNA retains the upstream REA copyright and third-party notices in `LICENSE`,
`THIRD_PARTY_NOTICES.md`, and `licenses/`.
