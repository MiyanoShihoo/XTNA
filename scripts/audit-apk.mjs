#!/usr/bin/env node
/**
 * XTNA APK audit: inventory an APK's DEX payload and fingerprint the ad,
 * analytics and tracking SDKs compiled into it.
 *
 * The scan is a pure literal search over DEX string tables. It answers "is this
 * SDK present in the build", never "is it active at runtime".
 */
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { basename, resolve } from "node:path";
import { ZipReader, Uint8ArrayReader, Uint8ArrayWriter } from "@zip.js/zip.js";

const MARKERS = {
  "Google Ads / AdMob": ["Lcom/google/android/gms/ads/"],
  "Google Ads Identifier": ["Lcom/google/android/gms/ads/identifier/"],
  "Google UMP (consent)": ["Lcom/google/android/ump/"],
  "Firebase Analytics": ["Lcom/google/firebase/analytics/"],
  "Firebase Crashlytics": ["Lcom/google/firebase/crashlytics/"],
  "Facebook Audience Network": ["Lcom/facebook/ads/"],
  "Facebook Login / Graph": [
    "Lcom/facebook/login/",
    "Lcom/facebook/GraphRequest",
  ],
  "Unity Ads": ["Lcom/unity3d/ads/"],
  AppLovin: ["Lcom/applovin/"],
  ironSource: ["Lcom/ironsource/"],
  "ByteDance Pangle": ["Lcom/bytedance/sdk/openadsdk/"],
  Mintegral: ["Lcom/mbridge/msdk/"],
  "Vungle / Liftoff": ["Lcom/vungle/"],
  Chartboost: ["Lcom/chartboost/"],
  MoPub: ["Lcom/mopub/"],
  InMobi: ["Lcom/inmobi/"],
  "Amazon Ads": ["Lcom/amazon/device/ads/"],
  Adjust: ["Lcom/adjust/sdk/"],
  AppsFlyer: ["Lcom/appsflyer/"],
  Branch: ["Lio/branch/"],
  Kochava: ["Lcom/kochava/"],
  Singular: ["Lcom/singular/sdk/"],
  Tenjin: ["Lcom/tenjin/"],
  OneSignal: ["Lcom/onesignal/"],
  Sentry: ["Lio/sentry/"],
  Mixpanel: ["Lcom/mixpanel/"],
  Amplitude: ["Lcom/amplitude/"],
  Segment: ["Lcom/segment/"],
  Datadog: ["Lcom/datadog/"],
  "New Relic": ["Lcom/newrelic/"],
  "Huawei HMS": ["Lcom/huawei/hms/"],
  "Umeng / Alibaba": ["Lcom/umeng/"],
  JPush: ["Lcn/jpush/"],
  Getui: ["Lcom/igexin/"],
  TalkingData: ["Lcom/tendcloud/"],
  "WeChat Open SDK": ["Lcom/tencent/mm/opensdk/"],
  "Line SDK": ["Lcom/line/sdk/"],
  "Twitter / X SDK": ["Lcom/twitter/sdk/"],
};

const args = process.argv.slice(2);
const flags = new Set(args.filter((arg) => arg.startsWith("--")));
const positional = args.filter((arg) => !arg.startsWith("--"));
if (positional.length !== 1) {
  process.stderr.write(
    "usage: node scripts/audit-apk.mjs <path.apk> [--json] [--markdown <out.md>]\n",
  );
  process.exit(2);
}

const path = resolve(positional[0]);
const bytes = new Uint8Array(await readFile(path));
const sha256 = createHash("sha256").update(bytes).digest("hex");

const zip = new ZipReader(new Uint8ArrayReader(bytes));
const entries = await zip.getEntries();
const dexEntries = entries.filter((entry) =>
  /^classes\d*\.dex$/u.test(entry.filename),
);
const dex = [];
for (const entry of dexEntries) {
  const data = Buffer.from(await entry.getData(new Uint8ArrayWriter()));
  dex.push({ name: entry.filename, bytes: data.length, data });
}
await zip.close();

const sdks = [];
for (const [name, markers] of Object.entries(MARKERS)) {
  let refs = 0;
  const where = new Set();
  for (const marker of markers) {
    const needle = Buffer.from(marker, "utf8");
    for (const file of dex) {
      let from = 0;
      for (;;) {
        const at = file.data.indexOf(needle, from);
        if (at < 0) break;
        refs += 1;
        where.add(file.name);
        from = at + needle.length;
      }
    }
  }
  if (refs > 0) sdks.push({ name, references: refs, dex: [...where].sort() });
}
sdks.sort((left, right) => right.references - left.references);

const aapt2 = process.env.REA_AAPT2_COMMAND;
let manifest = null;
if (aapt2 !== undefined && aapt2 !== "") {
  const result = spawnSync(aapt2, ["dump", "badging", path], {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
    timeout: 60_000,
  });
  if (result.status === 0) {
    const text = result.stdout;
    const field = (name) =>
      text.match(new RegExp(`^${name}: ?(.*)$`, "mu"))?.[1] ?? null;
    const permissions = [
      ...text.matchAll(/^uses-permission: name='([^']+)'/gmu),
    ].map((match) => match[1]);
    manifest = {
      package: field("package"),
      min_sdk: text.match(/^minSdkVersion:'(\d+)'/mu)?.[1] ?? null,
      target_sdk: text.match(/^targetSdkVersion:'(\d+)'/mu)?.[1] ?? null,
      permissions,
    };
  } else {
    manifest = {
      unavailable: result.error?.message ?? "aapt2 exited non-zero",
    };
  }
}

const audit = {
  artifact: { path, name: basename(path), bytes: bytes.length, sha256 },
  dex: dex.map(({ name, bytes: size }) => ({ name, bytes: size })),
  manifest,
  sdks,
  coverage: {
    scan: "literal DEX string-table search",
    presence_only: true,
    runtime_activation: "unknown",
  },
  limitations: [
    "Presence in the DEX string table does not prove the SDK is initialised or that any ad unit is enabled; mediation adapters are often gated by remote config.",
    "Obfuscated or dynamically loaded SDKs will not be matched by descriptor literals.",
    "Manifest facts require REA_AAPT2_COMMAND; without it the manifest section stays unavailable and is not guessed.",
  ],
};

if (flags.has("--json")) {
  process.stdout.write(`${JSON.stringify(audit, null, 2)}\n`);
} else {
  const mib = (value) => `${(value / 1048576).toFixed(1)} MiB`;
  console.log(`APK      ${audit.artifact.name}`);
  console.log(`SHA-256  ${sha256}`);
  console.log(`Size     ${mib(bytes.length)}`);
  if (manifest?.package) {
    console.log(
      `Package  ${manifest.package}  min ${manifest.min_sdk}  target ${manifest.target_sdk}`,
    );
    console.log(`Perms    ${String(manifest.permissions.length)} declared`);
  } else {
    console.log(
      `Manifest unavailable (${manifest?.unavailable ?? "REA_AAPT2_COMMAND not set"})`,
    );
  }
  console.log(
    `DEX      ${String(dex.length)} file(s), ${mib(dex.reduce((sum, d) => sum + d.bytes, 0))}`,
  );
  console.log("");
  if (sdks.length === 0) console.log("No known SDK markers found.");
  const width = Math.max(...sdks.map((sdk) => sdk.name.length), 4);
  for (const sdk of sdks)
    console.log(
      `${sdk.name.padEnd(width)}  ${String(sdk.references).padStart(6)} refs  ${sdk.dex.join(",")}`,
    );
}

const markdownIndex = args.indexOf("--markdown");
if (markdownIndex >= 0) {
  const out = args[markdownIndex + 1];
  if (out === undefined) throw new Error("--markdown requires a path");
  const lines = [
    `# APK audit: ${audit.artifact.name}`,
    "",
    `- SHA-256: \`${sha256}\``,
    `- Size: ${(bytes.length / 1048576).toFixed(1)} MiB`,
    manifest?.package
      ? `- Package: \`${manifest.package}\``
      : "- Package: unavailable",
    `- DEX files: ${String(dex.length)}`,
    "",
    "## Ad and tracking SDKs",
    "",
    "| SDK | References | DEX |",
    "| --- | ---: | --- |",
    ...sdks.map(
      (sdk) =>
        `| ${sdk.name} | ${String(sdk.references)} | ${sdk.dex.join(", ")} |`,
    ),
    "",
    "> Presence only. Compiled-in markers do not prove runtime activation.",
    "",
  ];
  await writeFile(out, lines.join("\n"), "utf8");
  process.stderr.write(`markdown written to ${out}\n`);
}
