<div align="center">

<img src="assets/icon.svg" width="120" height="120" alt="XTNA">

# XTNA

**终端里、Agent 里,反向工程任何东西。**

以证据为核心的逆向工具箱:一个 CLI、一个 MCP 服务器、一套贯穿原生二进制、托管代码、
JavaScript/Electron 应用、浏览器页面、Android 包、固件与流量抓包的证据模型。

[![License: Apache 2.0](https://img.shields.io/badge/license-Apache%202.0-blue?style=flat-square)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A522.5-339933?style=flat-square&logo=nodedotjs&logoColor=white)](package.json)
[![Status](https://img.shields.io/badge/status-0.1.0--beta-orange?style=flat-square)](#状态)

[English](README.md) · [简体中文](README.zh-CN.md)

</div>

---

## 设计原则

- **证据优先**:每个结果都区分观察、推导、推断与未知,并携带对应的覆盖度与限制。
- **资源可预测**:预算跟随实测内存,截断必须上报,大目标降级为具名缺口而不是静默的半截答案。
- **默认有界**:分页、跳数上限、可保留证据,让一次查询落在你真实的上下文预算内。
- **本地优先**:无遥测、不上传;分析针对本地产物,调用你已装好的工具。
- **与 provider 无关**:Ghidra、IDA、Hopper、Rizin、objdump、apktool、JADX、浏览器运行时,统一进一套证据模型。

## 有什么

- **231 个 MCP 工具**,一个 CLI + 一个 MCP 服务器:原生二进制(Ghidra / IDA / Hopper /
  Rizin / objdump)、托管 PE/CLI、JavaScript/Electron 应用图、浏览器捕获、Android、
  Apple bundle、固件、WASM、EVM、抓包分析等。
- **证据账本**:每个结果都带 authority、coverage、limitations、unknowns;观察与推断分开。
- **有界查询**:分页、`max_hops`、可 retained 的完整证据、适配上下文窗口的摘要。
- **可选网关 `xtna-vault`**:双向密钥脱敏 + 只读结果的内容寻址缓存,位于证据链之外,
  不影响 digest 可验证性。
- **APK 审计**:DEX 盘点 + 广告/统计/追踪 SDK 指纹识别。

## 快速开始

```bash
git clone https://github.com/MiyanoShihoo/xtna.git
cd xtna
npm ci --ignore-scripts
npm run compile
npm run verify:xtna
node scripts/rea.mjs --help
```

要求 Node ≥ 22.5(推荐 24.x)。深度分析调用你本机已有的工具,XTNA **不会**自动安装或升级
Ghidra、IDA、Hopper、apktool、JADX。

### 启动 MCP 服务器

```bash
node scripts/rea.mjs mcp
```

客户端配置:

```json
{
  "mcpServers": {
    "xtna": {
      "command": "node",
      "args": ["/绝对路径/xtna/scripts/rea.mjs", "mcp"]
    }
  }
}
```

### Windows:接上可选 provider

```bat
scripts\xtna-env.cmd --version
scripts\xtna-env.cmd analyze "C:\path\target.exe" --provider ghidra --format json
```

## 可选网关

`gateway/` 是独立 stdio MCP 服务器,可挡在 XTNA(或任意 MCP 服务器)前面:

- **双向脱敏**:工具输出里的密钥变成会话占位符 `<vault:1:ab12cd>`;把占位符当参数传回,
  网关在请求到达上游前还原真值。模型全程不持有明文。
- **内容寻址缓存**:只缓存 `readOnlyHint: true` 的工具结果、资源读取与 prompt。

```bash
npm --prefix gateway install
npm run vault:build
npm run vault:test        # 12 项协议层检查(内存传输)
npm run vault:test:e2e    # 6 项进程级检查(真 HTTP 上游 + 真 stdio)
```

## APK 审计

```bash
npm run audit:apk -- sample.apk
npm run audit:apk -- sample.apk --json --markdown report.md
```

纯存在性 DEX 扫描,覆盖约 38 个广告/统计/追踪 SDK 族。设置 `REA_AAPT2_COMMAND` 可补充
包名、SDK 版本区间与声明权限。

文档:[英文](docs/XTNA-APK-AUDIT.md) · [中文](docs/XTNA-APK-AUDIT.zh-CN.md)

## 符号覆盖层

`npm run overlay -- add --binary ./target.exe --address 0x401000 --name WinMain_candidate --confidence inferred`
把分析者推断的名字、类型与注释保存在证据账本之外,以二进制摘要为键,可导出只改名的
Ghidra / IDA 脚本。

[英文](docs/XTNA-SYMBOL-OVERLAY.md) · [中文](docs/XTNA-SYMBOL-OVERLAY.zh-CN.md)

## 档案导出与路线图

`npm run dossier -- --evidence evidence.json --out report.md` 把已存储的 Evidence 包投影成
可评审的 Markdown,不新增任何观察。每个路线图模块的交付状态见
[docs/XTNA-ROADMAP.md](docs/XTNA-ROADMAP.md)。

[中文](docs/XTNA-DOSSIER.md)

## 污点路径查询

`npm run taint -- --graph g.json --source source --sink sink --sanitizer sanitizer`
在显式属性图上枚举简单路径,把 sanitizer 当作屏障,并如实报告截断。查询前可先用`npm run graph:export` 把现有应用图投影成该格式。

[参考](docs/XTNA-TAINT-PATH.md)

`npm run overlay:render` 把已存储的伪代码按覆盖层重渲染用于评审,证据包保持字节不变。

## 检查点

`npm run checkpoint -- create --name session --evidence evidence.json --overlay-dir ~/.xtna/overlays`
把 Evidence 包与覆盖层连同哈希清单一起冻结;恢复前逐文件校验哈希。

[参考](docs/XTNA-CHECKPOINTS.md)

## 验证状态

| 检查 | 命令 | 状态 |
|---|---|---|
| 类型检查 | `npm run typecheck` | 通过 |
| 构建 | `npm run compile` | 通过 |
| 分发自检 | `npm run verify:xtna` | 6/6 |
| 网关协议 | `npm run vault:test` | 11/11 |
| 网关进程级 | `npm run vault:test:e2e` | 6/6 |
| 真实 APK 审计 | `npm run audit:apk -- sample.apk` | 已在 38MB 签名包上验证 |
| 真实 PE 探针 | 5MB 32 位游戏 exe 上的 `inspect-pe-*` | 导入表/资源/证书/objdump 均通过 |

完整测试套件 `npm run check:pr` **尚未**针对本分发运行。已验/未验的精确边界见
[XTNA_CHANGELOG.md](XTNA_CHANGELOG.md)。

## 状态

`0.1.0-beta`。源码可用,npm 包**尚未发布**。公开发布的前置条件:完整测试套件通过,
以及在不受限沙箱外完成一次真实目标的端到端分析。

## 文档

- [变更记录](XTNA_CHANGELOG.md) — 每一条修复,以及每一条未验证项
- [APK 审计](docs/XTNA-APK-AUDIT.zh-CN.md)
- [安全策略](SECURITY.md)
- [贡献指南](CONTRIBUTING.md)
- 引擎参考文档:`docs/`

## 许可与归属

XTNA 采用 **Apache License 2.0**(见 [LICENSE](LICENSE))。

其中包含 REA 分析引擎,Copyright (c) 2026 morluto,以 MIT 许可发布。该上游文本完整保留在
[LICENSE-REA-MIT](LICENSE-REA-MIT),原始版权声明未做改动;合并归属见 [NOTICE](NOTICE)。
上游项目与本分发无隶属关系。第三方声明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)
与 `licenses/`。
