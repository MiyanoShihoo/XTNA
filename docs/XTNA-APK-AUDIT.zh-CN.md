# APK 审计

`npm run audit:apk -- <路径.apk>` 盘点一个 APK,并对编译进 DEX 的广告、统计与追踪 SDK 做指纹识别。

这是**存在性**检查:对 DEX 字符串表做字面量搜索。它回答"这个 SDK 有没有被编进包",不回答"运行时是否启用"。

## 快速开始

```bash
npm run audit:apk -- sample.apk
npm run audit:apk -- sample.apk --json
npm run audit:apk -- sample.apk --markdown report.md
```

配置 `REA_AAPT2_COMMAND` 后,还会输出包名、SDK 版本区间与声明权限。没有配置时这些字段保持"不可用",不会猜。

## 输出示例

```
APK      pixiv.apk
SHA-256  35c67312…4ca7c3
Size     38.0 MiB
Manifest unavailable (REA_AAPT2_COMMAND not set)
DEX      5 file(s), 36.5 MiB

Mintegral                4083 refs  classes.dex,classes2.dex,classes3.dex,classes4.dex
ByteDance Pangle         2562 refs  classes.dex,classes2.dex,classes3.dex
AppLovin                 2438 refs  classes.dex,classes2.dex,classes3.dex,classes4.dex,classes5.dex
InMobi                   2069 refs  classes.dex,classes2.dex,classes3.dex,classes4.dex,classes5.dex
Google Ads / AdMob        953 refs  classes.dex,classes2.dex,classes3.dex,classes4.dex
Amazon Ads                188 refs  classes.dex,classes2.dex,classes4.dex,classes5.dex
Google UMP (consent)       45 refs  classes.dex,classes2.dex,classes3.dex,classes4.dex
```

## 字段说明

| 字段 | 含义 |
|---|---|
| `artifact` | 被扫描字节的路径、大小与 SHA-256 |
| `dex` | 每个 `classes*.dex` 条目及其大小 |
| `manifest` | 包名、min/target SDK、声明权限(需 aapt2) |
| `sdks` | 命中的标记族、引用次数、出现在哪些 DEX |
| `coverage` | 明确说明这是存在性扫描,运行时启用状态未知 |

## 覆盖的 SDK 族

Google Ads/AdMob 与 UMP、Facebook Audience Network、Unity Ads、AppLovin、ironSource、字节 Pangle、Mintegral、Vungle/Liftoff、Chartboost、MoPub、InMobi、Amazon Ads、Adjust、AppsFlyer、Branch、Kochava、Singular、Tenjin、OneSignal、Sentry、Mixpanel、Amplitude、Segment、Datadog、New Relic、华为 HMS、友盟、极光 JPush、个推、TalkingData、微信 Open SDK、Line SDK、Twitter/X SDK。

扩充方式:编辑 `scripts/audit-apk.mjs` 里的 `MARKERS`。

## 限制

- 被混淆或动态加载的 SDK 不会以描述符字面量出现,无法命中。
- 编译存在 ≠ 初始化,聚合适配器常由远端配置开关控制。
- 不执行代码、不联网、不接触设备。
- aapt2 是可选的;缺失时 manifest 事实标记为不可用,不做推断。

## 环境变量

| 变量 | 作用 |
|---|---|
| `REA_AAPT2_COMMAND` | `aapt2.exe` 绝对路径;启用手动、SDK 与权限事实 |

## 退出码

| 码 | 含义 |
|---|---|
| 0 | 审计完成(包括"未发现 SDK 标记") |
| 2 | 参数错误 |
| 非 0 | APK 不可读或 I/O 失败 |
