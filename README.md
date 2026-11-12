# XTNA

**Reverse-engineer software artifacts with one CLI and MCP server.**

XTNA helps you inspect binaries, application packages, JavaScript/Electron apps, and captured web or network behavior. It returns structured findings with their source, evidence strength, and coverage—and keeps observations, derived facts, inferences, and unknowns distinguishable.

[![MCP tool catalog](https://img.shields.io/badge/MCP-tool_catalog-5c4ee5?style=flat-square)](docs/mcp-contracts.md#generated-catalog)

[English](#english) · [简体中文](#chinese)

<a id="english"></a>

## Get started

Requires Node.js `^22.23.4 || ^24.22.1 || >=26.12.1`.

```bash
git clone https://github.com/MiyanoShihoo/XTNA.git
cd XTNA
npm ci --ignore-scripts
npm run compile
node scripts/rea.mjs --help
```

Start with an artifact inspection; this command does not require an external analysis provider:

```bash
node scripts/rea.mjs inspect-artifact ./target.exe --format json --evidence_output evidence.json
```

For deeper native analysis, install and configure a provider such as Ghidra, then run:

```bash
node scripts/rea.mjs decompile ./target.exe 0x401000 --provider ghidra --format json
```

To use XTNA through MCP, run its stdio server:

```bash
node scripts/rea.mjs mcp
```

The optional `setup` command can modify agent configuration files. Read the [installation guide](docs/installation.md#supported-agents) and review its planned changes before applying them; you can also register the stdio command manually. The published server entry is listed in the [MCP Registry](docs/installation.md#mcp-registry).

## What you can inspect

- **Binaries and managed code:** PE, ELF, Mach-O, managed-code metadata, and provider-backed function analysis.
- **Applications and packages:** JavaScript/Electron applications, Android packages, and Apple application bundles.
- **Captures and containers:** browser or network captures, plus formats such as ZIP, DMG, Godot PCK, and Node SEA.
- **Agent-assisted workflows:** MCP tools and structured investigation results.

These are entry points, not a promise that every sub-feature is complete. See the [documentation index](docs/index.md) for task-specific guides and the [roadmap](docs/XTNA-ROADMAP.md) for delivery status.

## What to expect from results

XTNA identifies the analysis backend and records how far an analysis got. Results distinguish direct observations from derived facts and inferences, and report gaps or unknowns instead of silently presenting them as facts. Truncated output is marked as truncated.

## Requirements and safe use

- Deeper analysis may need providers that you install and configure yourself. XTNA reports a missing provider rather than silently substituting another one.
- Provider processes run with your permissions. Analyze untrusted inputs only in a sandbox you control.
- XTNA's analysis reads local files and does not add an upload step; individual providers may behave differently. Check their documentation before using them with sensitive inputs.
- Some modules are partial and have specific known gaps. Check the [roadmap](docs/XTNA-ROADMAP.md) before relying on a particular capability.
- `setup` edits client configuration. Review the installation guide and its plan before approving changes.

## Documentation and status

- [Task guides](docs/index.md)
- [Installation and agent setup](docs/installation.md)
- [CLI reference](docs/cli.md)
- [MCP tools and result contracts](docs/mcp-contracts.md)
- [Feature status and verification notes](docs/XTNA-ROADMAP.md#verified-baseline)

## License

Apache-2.0. See [LICENSE](LICENSE).

---

<a id="chinese"></a>

## 简体中文

**用一套 CLI 和 MCP 服务，以证据为依据分析软件产物。**

XTNA 可用于检查二进制文件、应用程序包、JavaScript/Electron 应用，以及网页或网络采集数据。它会把分析结果整理为结构化记录，标明来源、证据强度和覆盖范围，并区分直接观察、推导、推断与未知项。

### 快速开始

需要 Node.js `^22.23.4 || ^24.22.1 || >=26.12.1`。

```bash
git clone https://github.com/MiyanoShihoo/XTNA.git
cd XTNA
npm ci --ignore-scripts
npm run compile
node scripts/rea.mjs --help
```

可以先检查产物；此命令不需要外部分析 provider：

```bash
node scripts/rea.mjs inspect-artifact ./target.exe --format json --evidence_output evidence.json
```

如需进一步分析原生二进制，请自行安装并配置 Ghidra 等 provider，再运行：

```bash
node scripts/rea.mjs decompile ./target.exe 0x401000 --provider ghidra --format json
```

通过 MCP 使用 XTNA 时，运行 stdio 服务：

```bash
node scripts/rea.mjs mcp
```

可选的 `setup` 命令会修改 Agent 配置文件。执行前请阅读[安装指南](docs/installation.md#supported-agents)并检查它计划修改的内容；也可以手动注册这条 stdio 命令。已发布的服务器条目见 [MCP Registry](docs/installation.md#mcp-registry)。

### 能检查哪些内容

- **二进制与托管代码：** PE、ELF、Mach-O、托管代码元数据，以及通过 provider 进行的函数分析。
- **应用与程序包：** JavaScript/Electron 应用、Android 程序包和 Apple 应用包。
- **采集数据与容器：** 浏览器或网络采集数据，以及 ZIP、DMG、Godot PCK、Node SEA 等格式。
- **Agent 工作流：** MCP 工具与结构化调查结果。

这些是常见入口，不代表每个子功能都已完成。按任务查阅[文档索引](docs/index.md)，并在[路线图](docs/XTNA-ROADMAP.md)查看各功能的交付状态。

### 分析结果与安全边界

XTNA 会标明分析后端和分析到达的范围；结果会区分直接观察、推导和推断，并报告缺口或未知项，不会把它们默默当成事实。被截断的输出会明确标记。

- 深度分析可能需要你自行安装和配置 provider。缺少 provider 时，XTNA 会报告缺失，不会悄悄换用其他工具。
- Provider 进程以你的权限运行。分析不可信输入时，请使用你自己控制的沙箱。
- XTNA 的分析读取本地文件，不会额外增加上传步骤；具体 provider 的行为可能不同。处理敏感输入前请先查看其文档。
- 部分模块仍有明确缺口。依赖某项具体能力前，请先查看[路线图](docs/XTNA-ROADMAP.md)。
- `setup` 会修改客户端配置。执行前请阅读安装指南并检查变更计划。

### 文档与状态

- [按任务查找指南](docs/index.md)
- [安装与 Agent 配置](docs/installation.md)
- [CLI 参考](docs/cli.md)
- [MCP 工具与结果约定](docs/mcp-contracts.md)
- [功能状态与验证记录](docs/XTNA-ROADMAP.md#verified-baseline)

### 许可

Apache-2.0，见 [LICENSE](LICENSE)。
