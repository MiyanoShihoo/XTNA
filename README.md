<div align="center">

<img src="assets/icon.svg" width="120" height="120" alt="XTNA">

# XTNA

**Reverse engineer anything — from your terminal or your agent.**

An evidence-first reverse-engineering toolkit: one CLI, one MCP server, and a shared
evidence model across native binaries, managed code, JavaScript and Electron applications,
browser pages, Android packages, firmware, and captured traffic.

[![License: MIT](https://img.shields.io/badge/license-MIT-f4c430?style=flat-square)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A522.5-339933?style=flat-square&logo=nodedotjs&logoColor=white)](package.json)
[![Status](https://img.shields.io/badge/status-0.1.0--beta-orange?style=flat-square)](#status)
[![MCP](https://img.shields.io/badge/MCP-stdio-5c4ee5?style=flat-square)](https://modelcontextprotocol.io)

[English](README.md) · [简体中文](README.zh-CN.md)

</div>

---

## Why XTNA exists

XTNA is a distribution of the [REA](https://github.com/morluto/rea) analysis engine (MIT).
The engine is good; the paper cuts around it are not. This distribution keeps the evidence
contracts and fixes the failure modes that cost real analysis time.

| Problem in REA 6.8.0 | What XTNA does |
|---|---|
| Large JavaScript applications exhausted the nominal result budget after ~10 sources while the heap was mostly free, then every remaining source got a 0-byte semantic allowance | Charges retained budget from **measured heap growth**; the fixed 8× estimate stays only as a per-file admission ceiling |
| One failed application projection zeroed the budget for **every** later source | Each remaining source is admitted against the live budget |
| A response status outside `100..599` raised an uncaught `ZodError` and **terminated the MCP server** | Provider-observed statuses are accepted; final capture validation fails one scenario with a typed error |
| `trace_application_feature` with `direction: "both"` walked the entire graph | Optional `max_hops` with explicit truncation reporting |
| Vite `base` absolute module specifiers (`import("/assets/x.js")`) were rejected as host paths | Mapped onto the logical artifact root when the path is inventoried, with the deployment assumption recorded |
| Renaming the distribution broke **every Windows native call** (manifest pinned to 6.8.0) | `npm run compile` syncs the native manifest version and digest |

None of this makes the engine deeper. It makes it **predictable**.

## What you get

- **231 MCP tools** over one CLI and one MCP server: native binaries (Ghidra / IDA / Hopper /
  Rizin / objdump), managed PE/CLI, JavaScript and Electron application graphs, browser
  capture, Android, Apple bundles, firmware, WASM, EVM, packet captures, and more.
- **Evidence ledger**: every result carries authority, coverage, limitations and unknowns.
  Observations stay separate from inferences.
- **Bounded queries**: paging, `max_hops`, retained Evidence, and summaries that fit a
  context window.
- **Optional gateway (`xtna-vault`)**: bidirectional secret redaction and a content-addressed
  cache for read-only tool results, outside the evidence path so digests stay verifiable.
- **APK audit**: DEX inventory plus ad, analytics and tracking SDK fingerprinting.

## Quick start

```bash
git clone https://github.com/MiyanoShihoo/xtna.git
cd xtna
npm ci --ignore-scripts
npm run compile
npm run verify:xtna
node scripts/rea.mjs --help
```

Requirements: Node ≥ 22.5 (24.x recommended). Deep analysis drives tools you already have —
XTNA never installs or upgrades Ghidra, IDA, Hopper, apktool or JADX.

### Run the MCP server

```bash
node scripts/rea.mjs mcp
```

Register it with any MCP client:

```json
{
  "mcpServers": {
    "xtna": {
      "command": "node",
      "args": ["/absolute/path/to/xtna/scripts/rea.mjs", "mcp"]
    }
  }
}
```

### Windows: wire the optional providers

```bat
scripts\xtna-env.cmd --version
scripts\xtna-env.cmd analyze "C:\path\target.exe" --provider ghidra --format json
```

## The optional gateway

`gateway/` is a standalone stdio MCP server that sits in front of XTNA (or any MCP server):

- **Bidirectional redaction** — credentials in tool output become session placeholders such
  as `<vault:1:ab12cd>`; pass one back as an argument and the real value is restored before
  the call reaches the provider. The model never holds the plaintext.
- **Content-addressed cache** — only results annotated `readOnlyHint: true` (plus resource
  and prompt reads) are replayed, keyed by canonical request hash.

```bash
npm --prefix gateway install
npm run vault:build
npm run vault:test        # 11 protocol checks, in-memory transport
npm run vault:test:e2e    # 6 process-level checks, real HTTP upstream + real stdio
```

## APK audit

```bash
npm run audit:apk -- sample.apk
npm run audit:apk -- sample.apk --json --markdown report.md
```

Presence-only DEX scanning across ~38 ad/analytics/tracking SDK families. Set
`REA_AAPT2_COMMAND` to add package identity, SDK range and declared permissions.

Reference: [English](docs/XTNA-APK-AUDIT.md) · [中文](docs/XTNA-APK-AUDIT.zh-CN.md)

## Verification

| Check | Command | Status |
|---|---|---|
| Types | `npm run typecheck` | passing |
| Build | `npm run compile` | passing |
| Distribution self-check | `npm run verify:xtna` | 6/6 |
| Gateway protocol | `npm run vault:test` | 11/11 |
| Gateway process-level | `npm run vault:test:e2e` | 6/6 |
| Real APK audit | `npm run audit:apk -- sample.apk` | verified on a 38 MB signed APK |
| Real PE probes | `inspect-pe-*` on a 5 MB 32-bit game executable | imports, resources, certificates, objdump |

`npm run check:pr` (the full upstream suite) has **not** been run against this distribution.
See [XTNA_CHANGELOG.md](XTNA_CHANGELOG.md) for the exact verified / unverified split.

## Status

`0.1.0-beta`. Source is ready; the npm package is **not published yet**. Public release is
gated on the full test suite and one end-to-end analysis on a real target outside a
restricted process sandbox.

## Documentation

- [Changelog](XTNA_CHANGELOG.md) — every fix, and every unverified claim
- [APK audit](docs/XTNA-APK-AUDIT.md)
- [Security policy](SECURITY.md)
- [Contributing](CONTRIBUTING.md)
- Upstream engine docs: `docs/`

## License and attribution

MIT. XTNA is a distribution of the REA analysis engine,
Copyright (c) 2026 morluto, with modifications Copyright (c) 2026 XTNA contributors.
The upstream project is not affiliated with this distribution. Third-party notices are in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and `licenses/`.
