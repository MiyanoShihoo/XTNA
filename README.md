<div align="center">

<img src="assets/icon.svg" width="120" height="120" alt="XTNA">

# XTNA

**Reverse engineer anything — from your terminal or your agent.**

An evidence-first reverse-engineering toolkit: one CLI, one MCP server, and a shared
evidence model across native binaries, managed code, JavaScript and Electron applications,
browser pages, Android packages, firmware, and captured traffic.

[![License: Apache 2.0](https://img.shields.io/badge/license-Apache%202.0-blue?style=flat-square)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A522.5-339933?style=flat-square&logo=nodedotjs&logoColor=white)](package.json)
[![Status](https://img.shields.io/badge/status-0.1.0--beta-orange?style=flat-square)](#status)
[![MCP](https://img.shields.io/badge/MCP-stdio-5c4ee5?style=flat-square)](https://modelcontextprotocol.io)

[English](README.md) · [简体中文](README.zh-CN.md)

</div>

---

## Design principles

- **Evidence over assertion.** Every result separates observation, derivation, inference and unknown, and carries the coverage and limitations that produced it.
- **Predictable resources.** Budgets follow measured memory, truncation is reported, and a large target degrades into named gaps instead of a silent partial answer.
- **Bounded by default.** Paging, hop ceilings and retained Evidence keep a query inside the context you actually have.
- **Local first.** No telemetry, no upload; analysis runs against local artifacts with the tools you already installed.
- **Provider-agnostic.** XTNA drives Ghidra, IDA, Hopper, Rizin, objdump, apktool, JADX and browser runtimes through one evidence model.

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
npm run vault:test        # 12 protocol checks, in-memory transport
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

## Symbol overlay

`npm run overlay -- add --binary ./target.exe --address 0x401000 --name WinMain_candidate --confidence inferred`
keeps analyst-proposed names, types and comments outside the evidence ledger, keyed by the
binary digest, and exports rename-only scripts for Ghidra or IDA.

[English](docs/XTNA-SYMBOL-OVERLAY.md) · [中文](docs/XTNA-SYMBOL-OVERLAY.zh-CN.md)

## Dossier and roadmap

`npm run dossier -- --evidence evidence.json --out report.md` projects a stored Evidence
bundle into a reviewable Markdown document without adding observations. The delivery status of
every roadmap module is tracked in [docs/XTNA-ROADMAP.md](docs/XTNA-ROADMAP.md).

[English](docs/XTNA-DOSSIER.md)

## Taint path search

`npm run taint -- --graph g.json --source source --sink sink --sanitizer sanitizer`
enumerates simple paths over an explicit property graph, treats sanitizers as barriers, and
reports truncation instead of returning a short list.

[Reference](docs/XTNA-TAINT-PATH.md)


`npm run overlay:render` rewrites a copy of stored pseudocode with overlay names for review; the evidence bundle stays byte-identical.

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
- Engine reference: `docs/`

## License and attribution

XTNA is licensed under the **Apache License 2.0** (see [LICENSE](LICENSE)).

It incorporates the REA analysis engine, Copyright (c) 2026 morluto, which is licensed under
the MIT License. That upstream text is reproduced in [LICENSE-REA-MIT](LICENSE-REA-MIT) and the
original notice is retained; see [NOTICE](NOTICE) for the combined attribution. The upstream
project is not affiliated with this distribution. Third-party notices are in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and `licenses/`.
