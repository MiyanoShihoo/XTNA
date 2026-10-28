# APK audit

`npm run audit:apk -- <path.apk>` inventories an APK and fingerprints the advertising,
analytics and tracking SDKs compiled into its DEX payload.

It is a **presence** check: a literal search over the DEX string tables. It answers "is this
SDK compiled in", never "is it active at runtime".

## Quick start

```bash
npm run audit:apk -- sample.apk
npm run audit:apk -- sample.apk --json
npm run audit:apk -- sample.apk --markdown report.md
```

With `REA_AAPT2_COMMAND` set, the audit also reports package identity, SDK range and declared
permissions. Without it those fields stay unavailable rather than guessed.

## Example

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

## What is reported

| Field | Meaning |
|---|---|
| `artifact` | path, byte size and SHA-256 of the exact APK bytes scanned |
| `dex` | every `classes*.dex` entry with its size |
| `manifest` | package, min/target SDK and declared permissions, when aapt2 is configured |
| `sdks` | matched marker families with reference counts and the DEX files they appear in |
| `coverage` | states that the scan is presence-only and runtime activation is unknown |

## Marker families

The table covers the common mediation and measurement stacks: Google Ads/AdMob and UMP,
Facebook Audience Network, Unity Ads, AppLovin, ironSource, ByteDance Pangle, Mintegral,
Vungle/Liftoff, Chartboost, MoPub, InMobi, Amazon Ads, Adjust, AppsFlyer, Branch, Kochava,
Singular, Tenjin, OneSignal, Sentry, Mixpanel, Amplitude, Segment, Datadog, New Relic, Huawei
HMS, Umeng, JPush, Getui, TalkingData, WeChat Open SDK, Line SDK, Twitter/X SDK.

Edit `MARKERS` in `scripts/audit-apk.mjs` to extend it.

## Limitations

- Obfuscated or dynamically loaded SDKs are not matched by descriptor literals.
- Compiled-in presence does not prove initialisation, and mediation adapters are often gated
  by remote configuration.
- No code execution, no network, no device.
- aapt2 is optional; manifest facts are absent, not inferred, when it is missing.

## Environment

| Variable | Effect |
|---|---|
| `REA_AAPT2_COMMAND` | absolute path to `aapt2.exe`; enables manifest, SDK and permission facts |

## Exit codes

| Code | Meaning |
|---|---|
| 0 | audit completed (including "no SDK markers found") |
| 2 | wrong arguments |
| non-zero | unreadable APK or I/O failure |
