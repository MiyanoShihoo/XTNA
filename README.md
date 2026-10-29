<div align="center">

<img src="assets/icon.svg" width="120" height="120" alt="XTNA">

# XTNA

**Reverse engineer anything — from your terminal or your agent.**
**在终端里、在 Agent 里，反向工程任何东西。**

[![License: Apache 2.0](https://img.shields.io/badge/license-Apache%202.0-blue?style=flat-square)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A522.5-339933?style=flat-square&logo=nodedotjs&logoColor=white)](package.json)
[![Release](https://img.shields.io/badge/release-1.0.0-brightgreen?style=flat-square)]()
[![MCP](https://img.shields.io/badge/MCP-stdio-5c4ee5?style=flat-square)](https://modelcontextprotocol.io)

</div>

---

## Overview · 概述

**EN** — XTNA is an evidence-first reverse-engineering toolkit: one CLI, one MCP server, and a
shared evidence model across native binaries, managed code, JavaScript and Electron
applications, browser pages, Android packages, firmware, and captured traffic. Every result
carries its authority, coverage, limitations and unknowns; observations stay separate from
inferences.

**中文** — XTNA 是一个以证据为核心的逆向工具箱：一个 CLI、一个 MCP 服务器，以及一套贯穿
原生二进制、托管代码、JavaScript/Electron 应用、浏览器页面、Android 包、固件与流量抓包的
统一证据模型。每个结果都携带来源权威、覆盖度、限制与未知项；观察与推断始终分开。

## Design principles · 设计原则

- **Evidence over assertion · 证据优先** — observations, derivations, inferences and unknowns never collapse into one field.
- **Predictable resources · 资源可预测** — budgets follow measured memory; truncation is reported, never silent.
- **Bounded by default · 默认有界** — paging, hop ceilings and retained Evidence keep answers inside your context.
- **Local first · 本地优先** — no telemetry, no upload; analysis runs against local artifacts.
- **Provider-agnostic · 与 provider 无关** — Ghidra, IDA, Hopper, Rizin, objdump, apktool and JADX feed one model.

## What you get · 包含什么

**EN**

- **231 MCP tools** over one CLI and one MCP server: native binaries, managed PE/CLI,
  JavaScript/Electron application graphs, browser capture, Android, Apple bundles, firmware,
  WASM, EVM and packet captures.
- **Evidence ledger** with per-record authority, confidence, coverage and limitations.
- **Optional gateway** (`xtna-vault`) for bidirectional secret redaction and content-addressed
  caching of read-only results — outside the evidence path, so digests stay verifiable.
- **Analysis utilities**: symbol overlay, dossier exporter, checkpoints, taint path search,
  graph export, constant radar, schema synthesis, hypothesis board, offline panel and APK audit.

**中文**

- **231 个 MCP 工具**，一个 CLI + 一个 MCP 服务器：原生二进制、托管 PE/CLI、
  JavaScript/Electron 应用图、浏览器捕获、Android、Apple bundle、固件、WASM、EVM 与抓包。
- **证据账本**：每个记录都带来源权威、置信度、覆盖度与限制。
- **可选网关**（`xtna-vault`）：双向密钥脱敏 + 只读结果的内容寻址缓存，位于证据链之外，
  digest 依然可验证。
- **分析工具集**：符号覆盖层、档案导出、检查点、污点路径查询、图导出、常量雷达、
  Schema 推导、假设看板、离线面板与 APK 审计。

## Quick start · 快速开始

```bash
git clone https://github.com/MiyanoShihoo/XTNA.git
cd XTNA
npm ci --ignore-scripts
npm run compile
npm run verify:xtna
node scripts/rea.mjs --help
```

**EN** — Node ≥ 22.5 (24.x recommended). XTNA never installs or upgrades Ghidra, IDA, Hopper,
apktool or JADX; it drives the tools you already have.

**中文** — 要求 Node ≥ 22.5（推荐 24.x）。XTNA 不会安装或升级 Ghidra、IDA、Hopper、apktool、
JADX，只调用你本机已有的工具。

### MCP server · MCP 服务器

```bash
node scripts/rea.mjs mcp
```

```json
{
  "mcpServers": {
    "xtna": {
      "command": "node",
      "args": ["/absolute/path/to/XTNA/scripts/rea.mjs", "mcp"]
    }
  }
}
```

### Windows providers · Windows provider 接入

```bat
scripts\xtna-env.cmd --version
scripts\xtna-env.cmd analyze "C:\path\target.exe" --provider ghidra --format json
```

**EN** — One console session wires JDK, Ghidra, apktool, jadx-headless-mcp and aapt2. Every
value can be overridden; nothing is downloaded.

**中文** — 一条命令为当前控制台接好 JDK、Ghidra、apktool、jadx-headless-mcp 与 aapt2。
每一项都可覆盖，不下载任何东西。

## Toolbox · 工具箱

| Command · 命令 | EN | 中文 |
|---|---|---|
| `npm run audit:apk -- <apk>` | DEX inventory + ad/analytics/tracking SDK fingerprints | DEX 盘点 + 广告/统计/追踪 SDK 指纹 |
| `npm run overlay -- …` | Symbol overlay store, Ghidra/IDA export, text rendering | 符号覆盖层存储、导出与渲染 |
| `npm run dossier -- …` | Evidence bundle → reviewable Markdown | 证据包 → 可评审 Markdown |
| `npm run checkpoint -- …` | Hash-verified snapshots of evidence and overlays | 证据与覆盖层的哈希校验快照 |
| `npm run graph:export` / `npm run taint` | Application graph → taint path search | 应用图 → 污点路径查询 |
| `npm run crypto:radar -- <file>` | Algorithm constant signatures with offsets | 算法常量特征与偏移 |
| `npm run schema:synth -- …` | JSON samples → TypeScript / Pydantic / OpenAPI | JSON 样本 → 类型定义 |
| `npm run hypothesis -- …` | Claims with confidence, status and contradictions | 假设、置信度、状态与反证 |
| `npm run panel -- …` | Single-file offline investigation panel | 单文件离线调查面板 |

Reference: [APK audit](docs/XTNA-APK-AUDIT.md) · [Symbol overlay](docs/XTNA-SYMBOL-OVERLAY.md) ·
[Dossier](docs/XTNA-DOSSIER.md) · [Checkpoints](docs/XTNA-CHECKPOINTS.md) ·
[Taint](docs/XTNA-TAINT-PATH.md) · [Panel](docs/XTNA-PANEL.md)

## The gateway · 网关

**EN** — `gateway/` is a standalone stdio MCP server that sits in front of XTNA or any MCP
server. Credentials in tool output become session placeholders such as `<vault:1:ab12cd>`; pass
one back as an argument and the real value is restored before the call reaches the upstream.
Only results annotated `readOnlyHint: true` are cached, keyed by canonical request hash.

**中文** — `gateway/` 是独立的 stdio MCP 服务器，可挡在 XTNA 或任意 MCP 服务器前面。工具输出
里的密钥会变成会话占位符 `<vault:1:ab12cd>`；把占位符当参数传回，网关在请求到达上游前还原
真值。只有带 `readOnlyHint: true` 的结果会按规范请求哈希缓存。

```bash
npm --prefix gateway install
npm run vault:build
npm run vault:test        # 12 protocol checks · 12 项协议检查
npm run vault:test:e2e    # 6 process-level checks · 6 项进程级检查
```

## Verification · 验证

| Check · 检查 | Result · 结果 |
|---|---|
| `npm run typecheck` | pass · 通过 |
| `npm run compile` | pass · 通过 |
| `npm run verify:xtna` | 8/8 |
| `npm run vault:test` | 12/12 |
| `npm run vault:test:e2e` | 6/6 |
| Ghidra (analyze / search / decompile / instructions / procedure info / call graph) | verified on a 5.3 MB PE · 已在 5.3MB PE 上验证 |
| JavaScript analysis | Vite build + self-authored Electron asar, 2 IPC channels paired · 已验证 |
| APK audit | 38 MB signed APK · 38MB 签名包 |
| PE probes | 5.3 MB 32-bit executable · 5.3MB 32 位可执行文件 |

**EN** — `npm run check:pr` (the full upstream suite) is not runnable on the authoring host:
turbo cannot resolve a global configuration path without writing outside the allowed scope.
Details and the exact unverified list are in [RELEASE.md](RELEASE.md) and
[XTNA_CHANGELOG.md](XTNA_CHANGELOG.md).

**中文** — `npm run check:pr`（上游完整测试套件）在作者机器上无法运行：turbo 需要在允许范围之外
写全局配置才能解析路径。详细情况与完整"未验证"清单见 [RELEASE.md](RELEASE.md) 与
[XTNA_CHANGELOG.md](XTNA_CHANGELOG.md)。

## Documentation · 文档

- [Roadmap and delivery status · 路线图与交付状态](docs/XTNA-ROADMAP.md)
- [Changelog · 变更记录](XTNA_CHANGELOG.md)
- [Release readiness · 发布就绪清单](RELEASE.md)
- [Security policy · 安全策略](SECURITY.md)
- [Contributing · 贡献指南](CONTRIBUTING.md)

## License · 许可

**EN** — Apache License 2.0 (see [LICENSE](LICENSE)). XTNA incorporates the REA analysis engine,
Copyright (c) 2026 morluto, licensed under MIT; that text is kept verbatim in
[LICENSE-REA-MIT](LICENSE-REA-MIT) and attribution is in [NOTICE](NOTICE).

**中文** — 采用 Apache License 2.0（见 [LICENSE](LICENSE)）。XTNA 包含 REA 分析引擎，
Copyright (c) 2026 morluto，以 MIT 授权；原文完整保留在 [LICENSE-REA-MIT](LICENSE-REA-MIT)，
归属声明见 [NOTICE](NOTICE)。第三方声明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)
与 `licenses/`。
