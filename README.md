<div align="center">

<img src="assets/icon.svg" width="120" height="120" alt="XTNA">

# XTNA

**Reverse engineer anything — from your terminal or your agent.**
**在终端里、在 Agent 里，反向工程任何东西。**

**[English](#english) · [简体中文](#chinese)**

[![License: Apache 2.0](https://img.shields.io/badge/license-Apache%202.0-blue?style=flat-square)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A522.5-339933?style=flat-square&logo=nodedotjs&logoColor=white)](package.json)
[![Release](https://img.shields.io/badge/release-1.0.0-brightgreen?style=flat-square)](<>)
[![MCP](https://img.shields.io/badge/MCP-stdio-5c4ee5?style=flat-square)](https://modelcontextprotocol.io)
[![MCP tool catalog](https://img.shields.io/badge/MCP-tool_catalog-5c4ee5?style=flat-square)](docs/mcp-contracts.md#generated-catalog)

</div>

---

<a id="english"></a>

## English

### What it is

XTNA is an evidence-first reverse-engineering toolkit: one CLI, one MCP server, and a shared
evidence model across native binaries, managed code, JavaScript and Electron applications,
browser pages, Android packages, firmware, and captured traffic. Every result carries its
authority, coverage, limitations and unknowns; observations stay separate from inferences.

### Design principles

- **Evidence over assertion** — observations, derivations, inferences and unknowns never collapse into one field.
- **Predictable resources** — budgets follow measured memory; truncation is reported, never silent.
- **Bounded by default** — paging, hop ceilings and retained Evidence keep answers inside your context.
- **Local first** — no telemetry, no upload; analysis runs against local artifacts.
- **Provider-agnostic** — Ghidra, IDA, Hopper, Rizin, objdump, apktool and JADX feed one model.

### What you get

- **231 MCP tools** over one CLI and one MCP server: native binaries, managed PE/CLI,
  JavaScript/Electron application graphs, browser capture, Android, Apple bundles, firmware,
  WASM, EVM and packet captures.
- **Evidence ledger** with per-record authority, confidence, coverage and limitations.
- **Optional gateway** (`xtna-vault`) for bidirectional secret redaction and content-addressed
  caching of read-only results — outside the evidence path, so digests stay verifiable.
- **Analysis utilities**: symbol overlay, dossier exporter, checkpoints, taint path search,
  graph export, constant radar, schema synthesis, hypothesis board, offline panel, APK audit.

### Quick start

```bash
git clone https://github.com/MiyanoShihoo/XTNA.git
cd XTNA
npm ci --ignore-scripts
npm run compile
npm run verify:xtna
node scripts/rea.mjs --help
```

Node ≥ 22.5 (24.x recommended). XTNA never installs or upgrades Ghidra, IDA, Hopper, apktool
or JADX; it drives the tools you already have.

MCP client configuration:

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

Windows providers, one console session:

```bat
scripts\xtna-env.cmd --version
scripts\xtna-env.cmd analyze "C:\path\target.exe" --provider ghidra --format json
```

### Toolbox

| Command                                  | What it does                                                |
| ---------------------------------------- | ----------------------------------------------------------- |
| `npm run audit:apk -- <apk>`             | DEX inventory + ad/analytics/tracking SDK fingerprints      |
| `npm run ast:normalize -- <file>`        | Literal folding and literal-branch collapse for minified JS |
| `npm run sdk:gen -- <har>`               | Recorded HTTP traffic to a typed TypeScript / Python client |
| `npm run mock:gen -- <har>`              | Recorded traffic to a stateful local CRUD mock server       |
| `npm run probe:gen -- <addr>`            | Frida / LLDB probe skeleton for one address                 |
| `npm run heap:query -- <snap>`           | V8 heap snapshot summary and instance lookup                |
| `npm run trace:causal -- <streams>`      | Merge UI / IPC / probe streams into one timeline            |
| `npm run overlay -- …`                   | Symbol overlay store, Ghidra/IDA export, text rendering     |
| `npm run dossier -- …`                   | Evidence bundle → reviewable Markdown                       |
| `npm run checkpoint -- …`                | Hash-verified snapshots of evidence and overlays            |
| `npm run graph:export` / `npm run taint` | Application graph → taint path search                       |
| `npm run crypto:radar -- <file>`         | Algorithm constant signatures with offsets                  |
| `npm run schema:synth -- …`              | JSON samples → TypeScript / Pydantic / OpenAPI              |
| `npm run hypothesis -- …`                | Claims with confidence, status and contradictions           |
| `npm run panel -- …`                     | Single-file offline investigation panel                     |

### Gateway

`gateway/` is a standalone stdio MCP server that sits in front of XTNA or any MCP server.
Credentials in tool output become session placeholders such as `<vault:1:ab12cd>`; pass one
back as an argument and the real value is restored before the call reaches the upstream. Only
results annotated `readOnlyHint: true` are cached, keyed by canonical request hash.

```bash
npm --prefix gateway install
npm run vault:build
npm run vault:test        # 12 protocol checks
npm run vault:test:e2e    # 6 process-level checks
```

### Verification

| Check                                                                             | Result                                                          |
| --------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `npm run typecheck` / `npm run compile`                                           | pass                                                            |
| `npm run verify:xtna`                                                             | 8/8                                                             |
| `npm run vault:test`                                                              | 12/12                                                           |
| `npm run vault:test:e2e`                                                          | 6/6                                                             |
| Ghidra: analyze / search / decompile / instructions / procedure info / call graph | verified on a 5.3 MB PE                                         |
| JavaScript analysis                                                               | Vite build + self-authored Electron asar, 2 IPC channels paired |
| APK audit                                                                         | 38 MB signed APK                                                |
| PE probes                                                                         | 5.3 MB 32-bit executable                                        |

`npm run check:pr` is not runnable on the authoring host: turbo cannot resolve a global
configuration path without writing outside the allowed scope. See [RELEASE.md](RELEASE.md) and
[XTNA_CHANGELOG.md](XTNA_CHANGELOG.md) for the exact unverified list.

### Documentation

- [Installation](docs/installation.md#supported-agents) — supported agents, provider setup
- [MCP registry entry](docs/installation.md#mcp-registry) — register the server with a client
- [MCP tool catalog](docs/mcp-contracts.md#generated-catalog) — every tool and its contract
- [Roadmap and delivery status](docs/XTNA-ROADMAP.md)
- [Changelog](XTNA_CHANGELOG.md) · [Release readiness](RELEASE.md)
- [Security policy](SECURITY.md) · [Contributing](CONTRIBUTING.md)

### License

Apache License 2.0 (see [LICENSE](LICENSE)). XTNA incorporates the REA analysis engine,
Copyright (c) 2026 morluto, licensed under MIT; that text is kept verbatim in
[LICENSE-REA-MIT](LICENSE-REA-MIT) and attribution is in [NOTICE](NOTICE).

---

<a id="chinese"></a>

## 中文

### 这是什么

XTNA 是一个以证据为核心的逆向工具箱：一个 CLI、一个 MCP 服务器，以及一套贯穿原生二进制、
托管代码、JavaScript/Electron 应用、浏览器页面、Android 包、固件与流量抓包的统一证据模型。
每个结果都携带来源权威、覆盖度、限制与未知项；观察与推断始终分开。

### 设计原则

- **证据优先** —— 观察、推导、推断与未知永不混进同一个字段。
- **资源可预测** —— 预算跟随实测内存；截断必须上报，从不静默。
- **默认有界** —— 分页、跳数上限与可保留证据，让答案落在你的上下文预算内。
- **本地优先** —— 无遥测、不上传；分析针对本地产物。
- **与 provider 无关** —— Ghidra、IDA、Hopper、Rizin、objdump、apktool、JADX 统一进一套模型。

### 包含什么

- **231 个 MCP 工具**，一个 CLI + 一个 MCP 服务器：原生二进制、托管 PE/CLI、
  JavaScript/Electron 应用图、浏览器捕获、Android、Apple bundle、固件、WASM、EVM 与抓包。
- **证据账本**：每个记录都带来源权威、置信度、覆盖度与限制。
- **可选网关**（`xtna-vault`）：双向密钥脱敏 + 只读结果的内容寻址缓存，位于证据链之外，
  digest 依然可验证。
- **分析工具集**：符号覆盖层、档案导出、检查点、污点路径查询、图导出、常量雷达、
  Schema 推导、假设看板、离线面板、APK 审计。

### 快速开始

```bash
git clone https://github.com/MiyanoShihoo/XTNA.git
cd XTNA
npm ci --ignore-scripts
npm run compile
npm run verify:xtna
node scripts/rea.mjs --help
```

要求 Node ≥ 22.5（推荐 24.x）。XTNA 不会安装或升级 Ghidra、IDA、Hopper、apktool、JADX，
只调用你本机已有的工具。

MCP 客户端配置：

```json
{
  "mcpServers": {
    "xtna": {
      "command": "node",
      "args": ["/绝对路径/XTNA/scripts/rea.mjs", "mcp"]
    }
  }
}
```

Windows provider 接入，一条命令搞定当前控制台：

```bat
scripts\xtna-env.cmd --version
scripts\xtna-env.cmd analyze "C:\path\target.exe" --provider ghidra --format json
```

### 工具箱

| 命令                                     | 作用                                            |
| ---------------------------------------- | ----------------------------------------------- |
| `npm run audit:apk -- <apk>`             | DEX 盘点 + 广告/统计/追踪 SDK 指纹              |
| `npm run ast:normalize -- <file>`        | 压缩代码的字面量折叠与字面量分支消除            |
| `npm run sdk:gen -- <har>`               | 录制流量生成带类型的 TypeScript / Python 客户端 |
| `npm run mock:gen -- <har>`              | 录制流量生成有状态的本地 CRUD 模拟服务          |
| `npm run probe:gen -- <addr>`            | 为单个地址生成 Frida / LLDB 探针骨架            |
| `npm run heap:query -- <snap>`           | V8 堆快照汇总与实例查询                         |
| `npm run trace:causal -- <streams>`      | 把 UI / IPC / 探针事件流合并成时间轴            |
| `npm run overlay -- …`                   | 符号覆盖层存储、Ghidra/IDA 导出、文本渲染       |
| `npm run dossier -- …`                   | 证据包 → 可评审 Markdown                        |
| `npm run checkpoint -- …`                | 证据与覆盖层的哈希校验快照                      |
| `npm run graph:export` / `npm run taint` | 应用图 → 污点路径查询                           |
| `npm run crypto:radar -- <file>`         | 算法常量特征与偏移                              |
| `npm run schema:synth -- …`              | JSON 样本 → TypeScript / Pydantic / OpenAPI     |
| `npm run hypothesis -- …`                | 假设、置信度、状态与反证                        |
| `npm run panel -- …`                     | 单文件离线调查面板                              |

### 网关

`gateway/` 是独立的 stdio MCP 服务器，可挡在 XTNA 或任意 MCP 服务器前面。工具输出里的密钥
会变成会话占位符 `<vault:1:ab12cd>`；把占位符当参数传回，网关在请求到达上游前还原真值。
只有带 `readOnlyHint: true` 的结果会按规范请求哈希缓存。

```bash
npm --prefix gateway install
npm run vault:build
npm run vault:test        # 12 项协议检查
npm run vault:test:e2e    # 6 项进程级检查
```

### 验证

| 检查                                                                              | 结果                                              |
| --------------------------------------------------------------------------------- | ------------------------------------------------- |
| `npm run typecheck` / `npm run compile`                                           | 通过                                              |
| `npm run verify:xtna`                                                             | 8/8                                               |
| `npm run vault:test`                                                              | 12/12                                             |
| `npm run vault:test:e2e`                                                          | 6/6                                               |
| Ghidra：analyze / search / decompile / instructions / procedure info / call graph | 已在 5.3MB PE 上验证                              |
| JavaScript 分析                                                                   | Vite 构建 + 自造 Electron asar，2 条 IPC 通道配对 |
| APK 审计                                                                          | 38MB 签名包                                       |
| PE 探针                                                                           | 5.3MB 32 位可执行文件                             |

`npm run check:pr` 在作者机器上无法运行：turbo 需要在允许范围之外写全局配置才能解析路径。
完整"未验证"清单见 [RELEASE.md](RELEASE.md) 与 [XTNA_CHANGELOG.md](XTNA_CHANGELOG.md)。

### 文档

- [安装](docs/installation.md#supported-agents) —— 支持的 agent 与 provider 配置
- [MCP 注册项](docs/installation.md#mcp-registry) —— 把服务器注册进客户端
- [MCP 工具目录](docs/mcp-contracts.md#generated-catalog) —— 全部工具及其契约
- [路线图与交付状态](docs/XTNA-ROADMAP.md)
- [变更记录](XTNA_CHANGELOG.md) · [发布就绪清单](RELEASE.md)
- [安全策略](SECURITY.md) · [贡献指南](CONTRIBUTING.md)

### 许可

Apache License 2.0（见 [LICENSE](LICENSE)）。XTNA 包含 REA 分析引擎，
Copyright (c) 2026 morluto，以 MIT 授权；原文完整保留在 [LICENSE-REA-MIT](LICENSE-REA-MIT)，
归属声明见 [NOTICE](NOTICE)。第三方声明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)
与 `licenses/`。
