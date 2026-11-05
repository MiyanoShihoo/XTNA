# XTNA

XTNA is a local command-line tool and MCP server for reverse engineering and application
analysis. It reads a binary, an app package, a page or a capture and returns structured records;
each record says how it was observed and where the analysis stopped.

Deep analysis needs tools you install yourself (Ghidra, IDA, Hopper, Rizin, apktool, JADX).
Several modules are still partial — [docs/XTNA-ROADMAP.md](docs/XTNA-ROADMAP.md) marks each one
`shipped`, `partial` or `planned`.

[English](#english) · [简体中文](#chinese)

<a id="english"></a>

## What it does

XTNA reads an artifact and returns records that state four things: which backend observed it,
how strong the claim is (`observed`, `derived`, `inferred`), how far the analysis reached, and
what it could not do. Truncated output says it is truncated. An observation is not silently
promoted to an inference.

The current code covers four areas:

- Binaries and managed code: PE, ELF and Mach-O, PE/CLI metadata, function dossiers, call-path
  tracing, decompiler adapters.
- Apps and pages: JavaScript and Electron graphs, source maps, APK/AAB and IPA/.app bundles,
  passive browser inspection.
- Containers and traffic: ZIP, DMG, Godot PCK, PyInstaller, Node SEA, Hermes headers; HAR,
  mitmproxy, SAZ and qlog.
- Agent tooling: MCP tools, mock servers, client SDK generation, dossiers, checkpoints, a local
  panel.

The per-area documents under [docs/](docs/) are the reference for each area. This list is a map,
not a claim that every sub-feature is finished.

## Getting started

Node.js `^22.23.4 || ^24.22.1 || >=26.12.1` is required.

```bash
git clone https://github.com/MiyanoShihoo/XTNA.git
cd XTNA
npm ci --ignore-scripts
npm run compile
node scripts/rea.mjs --help
```

`package.json` names the binary `xtna`; in a clone the entry point is `scripts/rea.mjs`.

Two commands to try first:

```bash
# Inspect an artifact without any external provider.
node scripts/rea.mjs inspect-artifact ./target.exe --format json --evidence_output evidence.json

# Decompile one function through Ghidra, which you must install and point XTNA at.
node scripts/rea.mjs decompile ./target.exe 0x401000 --provider ghidra --format json
```

## CLI and MCP

The CLI is the same code path the MCP server exposes:

```bash
node scripts/rea.mjs mcp        # stdio transport
```

`setup` can modify client configuration files. Review the installation guide and protect existing
configurations before running it. Configuration safety checks are still under review. The
per-client paths and the registry snippet are in
[docs/installation.md](docs/installation.md#supported-agents). If you would rather not use it,
the MCP entry is a single stdio command and can be registered by hand.

The generated tool catalog in [docs/mcp-contracts.md](docs/mcp-contracts.md#generated-catalog)
lists the tools, their inputs and how results are represented.

## Requirements and limitations

- Deep analysis requires providers you supply. XTNA does not download or install them, and a
  missing provider is reported as such rather than substituted.
- Provider processes run with your permissions. Point them at untrusted input only inside a
  sandbox you control.
- Some modules are partial by design: the roadmap names the missing part for each. Do not read
  a `partial` label as "mostly done".
- The test suites are runnable locally, but not every lane is green on every platform and some
  acceptance lanes have known failures. The repository does not claim a green board it cannot
  reproduce.
- Windows client configuration paths differ per client and change between versions. `setup`
  refuses what it cannot verify instead of guessing.

## Verification

Local gates that exist in `package.json`: `npm run typecheck`, `npm run lint`, `npm run
docs:check`, `npm run test:fast`. `npm run verify:xtna` runs the project's own verification
script. What was actually observed on a given platform is recorded in
[docs/XTNA-ROADMAP.md](docs/XTNA-ROADMAP.md#verified-baseline); anything unrun stays unrun.

## Security notes

- Analysis reads local files. XTNA does not add an upload step to that flow; individual providers
  may behave differently, so read the provider's own guide before pointing it at sensitive input.
- The MCP gateway redacts secret-shaped values from retained evidence. Coverage is per tool and
  stated in each tool's record, not a global guarantee.
- The local panel binds to loopback and checks the WebSocket Origin before accepting a connection
  ([docs/XTNA-ROADMAP.md](docs/XTNA-ROADMAP.md)).

## Documentation

Start at [docs/](docs/): `installation.md`, `cli.md`, `mcp-contracts.md`, `client-configuration.md`
and the per-format guides. Delivery status per module is in
[docs/XTNA-ROADMAP.md](docs/XTNA-ROADMAP.md).

## License

Apache-2.0. See [LICENSE](LICENSE).

---

<a id="chinese"></a>

## 简体中文

XTNA 提供命令行工具和 MCP 接口，用于分析二进制文件、应用程序及相关产物。分析结果包含结构化信息，
并尽可能说明证据来源与能力限制。部分功能仍在开发中，具体状态见项目路线图。

深度分析依赖你自备的外部工具（Ghidra、IDA、Hopper、Rizin、apktool、JADX 等），XTNA 不下载、
不安装它们；缺少时直接报缺少，不会用别的东西顶替。

### 功能范围

当前代码覆盖四类：

- 二进制与托管代码：PE、ELF、Mach-O，PE/CLI 元数据，函数档案，调用路径追踪，反编译适配。
- 应用与页面：JavaScript/Electron 应用图、source map，APK/AAB 与 IPA/.app，被动式浏览器检查。
- 容器与流量：ZIP、DMG、Godot PCK、PyInstaller、Node SEA、Hermes 头；HAR、mitmproxy、SAZ、qlog。
- Agent 工具：MCP 工具、mock 服务器、客户端 SDK 生成、dossier、checkpoint、本地面板。

各领域的细节以 [docs/](docs/) 下对应文档为准；这份清单是索引，不代表每个子功能都已完成。

### 快速开始

需要 Node.js `^22.23.4 || ^24.22.1 || >=26.12.1`。

```bash
git clone https://github.com/MiyanoShihoo/XTNA.git
cd XTNA
npm ci --ignore-scripts
npm run compile
node scripts/rea.mjs --help
```

`package.json` 里的命令名是 `xtna`；在克隆目录中用 `scripts/rea.mjs`。

```bash
# 不依赖外部 provider 的产物检查
node scripts/rea.mjs inspect-artifact ./target.exe --format json --evidence_output evidence.json

# 通过 Ghidra 反编译单个函数（需自行安装并配置 Ghidra）
node scripts/rea.mjs decompile ./target.exe 0x401000 --provider ghidra --format json

# MCP 服务器（stdio）
node scripts/rea.mjs mcp
```

`setup` 会修改客户端配置文件。运行前先阅读安装文档，并保护好现有配置；配置安全检查仍在评审中。
各客户端的路径与注册片段见
[docs/installation.md](docs/installation.md#supported-agents)。不想用 `setup` 时，MCP 入口就是
一条 stdio 命令，可以手工注册。

### 限制

- 外部 provider 由你提供并以其自身权限运行；对不可信输入使用前，先在你自己控制的沙箱里跑。
- 分析读取本地文件，XTNA 不为该流程增加上传步骤；各 provider 行为可能不同，指向敏感输入前先读其文档。
- MCP 网关会对保留证据中的凭据形态内容做脱敏，覆盖范围按工具记录为准，不构成全局保证。
- 部分功能标为 partial，代表有可用切片但存在明确缺口，不等于"基本完成"。
- 测试套件可在本地运行，但并非每个 lane 在所有平台都通过，部分 acceptance lane 存在已知失败。
- 不同客户端的配置路径与格式会随版本变化；`setup` 对无法核实的状态直接拒绝，不做猜测。

### 许可

Apache-2.0，见 [LICENSE](LICENSE)。
