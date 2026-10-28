<div align="center">

<img src="assets/icon.svg" width="120" height="120" alt="XTNA">

# XTNA

**终端里、Agent 里,反向工程任何东西。**

以证据为核心的逆向工具箱:一个 CLI、一个 MCP 服务器、一套贯穿原生二进制、托管代码、
JavaScript/Electron 应用、浏览器页面、Android 包、固件与流量抓包的证据模型。

[![License: MIT](https://img.shields.io/badge/license-MIT-f4c430?style=flat-square)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A522.5-339933?style=flat-square&logo=nodedotjs&logoColor=white)](package.json)
[![Status](https://img.shields.io/badge/status-0.1.0--beta-orange?style=flat-square)](#状态)

[English](README.md) · [简体中文](README.zh-CN.md)

</div>

---

## 为什么有 XTNA

XTNA 基于 [REA](https://github.com/morluto/rea) 分析引擎(MIT)分发。引擎本身很好,
但周边的工程毛刺很贵。本分支保留全部证据契约,修掉的都是实际吃掉分析时间的故障:

| REA 6.8.0 中的问题 | XTNA 的处理 |
|---|---|
| 大型 JS 应用在堆还很空时,约十个源文件就把名义预算耗尽,后续每个文件只拿到 0 字节语义配额 | 按**实测堆增长**记账;固定 8× 估算只保留为单文件准入门槛 |
| 任一文件的 application projection 失败,后续**所有**文件预算被置零 | 每个文件按实时预算独立准入 |
| 响应状态码超出 `100..599` 触发未捕获 `ZodError`,**整个 MCP 服务器退出** | 接受 provider 实际能观察到的状态;最终校验改为单场景类型化失败 |
| `direction: "both"` 的特征追踪会走完整张图 | 新增 `max_hops`,并显式报告截断 |
| Vite `base` 产生的绝对模块路径(`import("/assets/x.js")`)被判为主机路径拒绝 | 命中已盘点路径时映射到逻辑根,并记录部署假设 |
| 改名分发后 **Windows 原生调用全部失效**(manifest 锁死 6.8.0) | `npm run compile` 自动同步原生 manifest 的版本与摘要 |

这些改动没有让引擎变深,只是让它**可预测**。

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
git clone <本仓库地址> xtna
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
npm run vault:test        # 11 项协议层检查(内存传输)
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

上游完整测试套件 `npm run check:pr` **尚未**针对本分发运行。已验/未验的精确边界见
[XTNA_CHANGELOG.md](XTNA_CHANGELOG.md)。

## 状态

`0.1.0-beta`。源码可用,npm 包**尚未发布**。公开发布的前置条件:完整测试套件通过,
以及在不受限沙箱外完成一次真实目标的端到端分析。

## 文档

- [变更记录](XTNA_CHANGELOG.md) — 每一条修复,以及每一条未验证项
- [APK 审计](docs/XTNA-APK-AUDIT.zh-CN.md)
- [安全策略](SECURITY.md)
- [贡献指南](CONTRIBUTING.md)
- 上游引擎文档:`docs/`

## 许可与归属

MIT。XTNA 是 REA 分析引擎的分发版本,Copyright (c) 2026 morluto,
修改部分 Copyright (c) 2026 XTNA contributors。上游项目与本分发无隶属关系。
第三方声明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) 与 `licenses/`。
