<div align="center">

<img src="assets/icon.svg" width="120" height="120" alt="XTNA">

# XTNA

**Reverse engineer anything — from your terminal or your agent.**
**在终端里、在 Agent 里，反向工程任何东西。**

**[English](#english) · [简体中文](#chinese)**

[![License: Apache 2.0](https://img.shields.io/badge/license-Apache%202.0-blue?style=flat-square)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A522.5-339933?style=flat-square&logo=nodedotjs&logoColor=white)](package.json)
[![MCP](https://img.shields.io/badge/MCP-stdio-5c4ee5?style=flat-square)](https://modelcontextprotocol.io)
[![MCP tool catalog](https://img.shields.io/badge/MCP-tool_catalog-5c4ee5?style=flat-square)](docs/mcp-contracts.md#generated-catalog)

</div>

---

<a id="english"></a>

# English

## What XTNA is

XTNA is an evidence-first reverse-engineering toolkit. One CLI and one MCP server share a
single evidence model that covers native binaries, managed code, JavaScript and Electron
applications, browser pages, Android packages, Apple bundles, firmware, WebAssembly, EVM
bytecode and packet captures.

The point is not "a model looked at a file". Every result carries its **authority**, its
**coverage**, its **limitations** and its **unknowns**. An observation is never silently
promoted to an inference, and a truncated answer says so instead of pretending to be complete.

## Status

- Version **1.0.0**, Apache-2.0, local-first: no telemetry, no upload.
- **234 MCP tools**, **177 CLI commands**, **63 providers**, **26 client integrations**.
- The local gates are green: typecheck, lint (0 errors), docs check and the full source suite
  (20,666 tests at the time of writing).
- Deep analysis needs a provider you supply (Ghidra, IDA, Hopper, Rizin, apktool, JADX …).
  The provider matrix and setup steps live in [docs/installation.md](docs/installation.md).

The roadmap separates **shipped**, **partial** and **planned** per module. Several modules are
deliberately partial; [docs/XTNA-ROADMAP.md](docs/XTNA-ROADMAP.md) states exactly which parts
are missing rather than rounding up.

## Design principles

| Principle               | What it means in practice                                                                                  |
| ----------------------- | ---------------------------------------------------------------------------------------------------------- |
| Evidence over assertion | Each record keeps authority, confidence, coverage and limitations; unknowns are first-class records.       |
| Bounded by default      | Paging, hop ceilings and retained-evidence budgets keep answers inside your context and report truncation. |
| Local first             | Analysis runs against local artifacts; nothing is uploaded and no telemetry is collected.                  |
| Provider-agnostic       | Ghidra, IDA, Hopper, Rizin, objdump, apktool and JADX feed the same model.                                 |
| Fail closed             | Malformed or unsupported input returns a typed failure; it is never guessed into a result.                 |

## Quick start

```bash
git clone https://github.com/MiyanoShihoo/XTNA.git
cd XTNA
npm ci --ignore-scripts
npm run compile
npm run verify:xtna
node scripts/rea.mjs --help
```

Run one inspection and keep the evidence:

```bash
node scripts/rea.mjs inspect-artifact ./target.exe --format json --evidence_output evidence.json
node scripts/rea.mjs inspect ./target.exe --provider ghidra --format json
node scripts/rea.mjs decompile ./target.exe 0x401000 --provider ghidra --format json
```

## MCP server

```bash
node scripts/rea.mjs mcp          # stdio transport
```

Register it in your client with one of the `setup` targets; the [supported agents](docs/installation.md#supported-agents)
list and the [MCP registry](docs/installation.md#mcp-registry) entry carry the exact snippets and per-client
paths. The [generated tool catalog](docs/mcp-contracts.md#generated-catalog) lists every tool.
`rea setup` prints its planned changes and asks for approval before writing files.

## What is inside

| Area                  | Capabilities                                                                                                    |
| --------------------- | --------------------------------------------------------------------------------------------------------------- |
| Native                | PE/ELF/Mach-O, 6502/ARM/ARM64/MIPS, function dossiers, call-path tracing, decompiler adapters, symbol overlays  |
| Managed               | PE/CLI metadata, member inventories, IL boundaries, native-boundary verification                                |
| JavaScript / Electron | Application graphs, routes, source maps, Electron fuses, packaged ASAR/SEA                                      |
| Browser               | Passive CDP inspection, recorded scenarios, network waterfalls, WebMCP discovery                                |
| Android / Apple       | APK/AAB inspection, signing, JADX/apktool bridges, IPA/.app bundles, plists, Interface Builder                  |
| Firmware / containers | ZIP, DMG, Godot PCK, PyInstaller, Node SEA, Hermes headers, firmware extraction                                 |
| Traffic               | HAR, mitmproxy, SAZ and qlog inspection with credential redaction                                               |
| Agent tooling         | Stateful mock servers, client SDK generation, dossiers (MD/HTML/PDF), checkpoints, live panel, worker scheduler |

Utilities worth knowing: `npm run mock:gen`, `npm run sdk:gen`, `npm run dossier`,
`npm run checkpoint`, `npm run panel:serve`, `npm run wasm:scan`, `npm run hermes:inspect`.
Each has its own document under [docs/](docs/README.md).

## Evidence model

A record answers four questions: **who observed it** (provider), **how strong it is**
(authority: observed / derived / inferred), **how far it reaches** (coverage) and **what it
could not do** (limitations, unknowns). Evidence bundles are content-addressed and can be
exported, imported, compared and projected into dossiers without losing those distinctions.

## Verification

- Full source suite: `npm run test:fast`.
- Type/lint/docs gates: `npm run typecheck`, `npm run lint`, `npm run docs:check`.
- Real provider lane: Ghidra 12.2 was verified against `notepad.exe` (915 procedures, 635
  strings) and a real function decompile; the record is in
  [docs/XTNA-ROADMAP.md](docs/XTNA-ROADMAP.md#verified-baseline).
- Unrun or unavailable checks are reported as such — the project does not claim runtime
  behaviour it did not observe.

## Security and privacy

- Analysis is local; no artifact bytes or evidence leave the machine.
- Transport credentials are redacted from retained evidence; generated clients never copy
  captured token values into source.
- Providers that launch a process (Ghidra headless, IDA, Hopper, …) run with the caller's
  permissions; read their guide before pointing them at hostile input.
- The live panel binds to loopback and refuses cross-origin WebSocket upgrades.

## License

Apache-2.0.

---

<a id="chinese"></a>

# 简体中文

## XTNA 是什么

XTNA 是一套**证据优先**的反向工程工具：一个 CLI、一个 MCP 服务器，共用同一套证据模型，
覆盖原生二进制、托管代码、JavaScript/Electron 应用、浏览器页面、Android 包、Apple bundle、
固件、WebAssembly、EVM 字节码与抓包流量。

重点不是"模型看了一眼文件"，而是每条结果都带**权威级别、覆盖范围、限制与未知项**。
观察不会被悄悄升级成推断，被截断的答案会明确说"截断了"。

## 当前状态

- 版本 **1.0.0**，Apache-2.0，本地优先：无遥测、不上传。
- **234 个 MCP 工具**、**177 个 CLI 命令**、**63 个 provider**、**26 个客户端集成**。
- 本地门禁全绿：typecheck、lint（0 error）、docs check、全量源码测试（写作时 20,666 条）。
- 深度分析需要你自备 provider（Ghidra、IDA、Hopper、Rizin、apktool、JADX 等），
  安装与矩阵见 [docs/installation.md](docs/installation.md)。

路线图把每个模块标为 **shipped / partial / planned**。有些模块是"有意保留的 partial"，
缺什么写在 [docs/XTNA-ROADMAP.md](docs/XTNA-ROADMAP.md)，不四舍五入成"完成"。

## 设计原则

| 原则          | 落地方式                                                  |
| ------------- | --------------------------------------------------------- |
| 证据优先      | 每条记录保留权威、置信、覆盖与限制；未知项是一等公民      |
| 默认有界      | 分页、跳数上限、证据保留预算，截断必须上报                |
| 本地优先      | 只分析本地产物，不上传、不采集遥测                        |
| Provider 无关 | Ghidra/IDA/Hopper/Rizin/objdump/apktool/JADX 汇入同一模型 |
| 失败关闭      | 畸形或不支持的输入返回类型化失败，不猜成结果              |

## 快速开始

```bash
git clone https://github.com/MiyanoShihoo/XTNA.git
cd XTNA
npm ci --ignore-scripts
npm run compile
npm run verify:xtna
node scripts/rea.mjs --help
```

一次检查并保留证据：

```bash
node scripts/rea.mjs inspect-artifact ./target.exe --format json --evidence_output evidence.json
node scripts/rea.mjs inspect ./target.exe --provider ghidra --format json
node scripts/rea.mjs decompile ./target.exe 0x401000 --provider ghidra --format json
```

## MCP 服务

```bash
node scripts/rea.mjs mcp          # stdio
```

用 `rea setup` 为客户注册：客户端清单见 [supported agents](docs/installation.md#supported-agents)，
注册入口见 [MCP registry](docs/installation.md#mcp-registry)，完整工具清单见
[generated tool catalog](docs/mcp-contracts.md#generated-catalog)。`rea setup` 会先展示计划、
再请求批准后写文件。

## 能力一览

| 领域                | 内容                                                                                |
| ------------------- | ----------------------------------------------------------------------------------- |
| 原生                | PE/ELF/Mach-O、6502/ARM/ARM64/MIPS、函数档案、调用路径追踪、反编译适配、符号覆盖层  |
| 托管                | PE/CLI 元数据、成员清单、IL 边界、原生边界核验                                      |
| JavaScript/Electron | 应用图、路由、source map、Electron fuse、ASAR/SEA                                   |
| 浏览器              | 被动 CDP 检查、录制场景、网络瀑布、WebMCP 发现                                      |
| Android/Apple       | APK/AAB、签名、JADX/apktool 桥；IPA/.app、plist、Interface Builder                  |
| 固件/容器           | ZIP、DMG、Godot PCK、PyInstaller、Node SEA、Hermes 头、固件提取                     |
| 流量                | HAR、mitmproxy、SAZ、qlog，凭证脱敏                                                 |
| Agent 工具          | 有状态 Mock、客户端 SDK 生成、Dossier（MD/HTML/PDF）、检查点、实时面板、worker 调度 |

常用命令：`npm run mock:gen`、`npm run sdk:gen`、`npm run dossier`、`npm run checkpoint`、
`npm run panel:serve`、`npm run wasm:scan`、`npm run hermes:inspect`。各自都有独立文档。

## 证据模型

一条记录回答四件事：**谁观察的**（provider）、**有多硬**（权威：observed/derived/inferred）、
**覆盖到哪**（coverage）、**做不到什么**（limitations、unknowns）。证据包内容寻址，
可导出、导入、比较，并在导出为报告时不丢失这些区别。

## 验证

- 全量源码测试：`npm run test:fast`
- 类型/静态/文档门禁：`npm run typecheck`、`npm run lint`、`npm run docs:check`
- 真实 provider：Ghidra 12.2 对 `notepad.exe` 实测（915 函数、635 字符串）并完成真实反编译，
  记录见 [docs/XTNA-ROADMAP.md](docs/XTNA-ROADMAP.md#verified-baseline)
- 没跑的检查会明说，不拿"应该没问题"当证据

## 安全与隐私

- 分析全在本地，产物字节与证据不出机器
- 传输凭证从保留证据中脱敏；生成的客户端不会把抓到的 token 值写进源码
- 会拉起进程的 provider（Ghidra headless、IDA、Hopper 等）以调用者权限运行，喂 hostile 输入前先读对应指南
- 实时面板只绑 loopback，并拒绝跨站 WebSocket 升级

## 许可

Apache-2.0。

---
