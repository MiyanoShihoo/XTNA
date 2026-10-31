#!/usr/bin/env node
/**
 * Design audit for the XTNA workbench.
 *
 * This is a source/build artefact audit, not a browser computed-style test.
 * It fails when the design brief's hard constraints disappear from the CSS.
 */
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const failures = [];
const checks = [];

const check = (name, condition, detail) => {
  checks.push({ name, ok: condition, detail });
  if (!condition) failures.push(`${name}: ${detail}`);
};

const css = await readFile(join(root, "src", "styles.css"), "utf8");
const app = await readFile(join(root, "src", "App.tsx"), "utf8");
const topology = await readFile(
  join(root, "src", "components", "TopologyCanvas.tsx"),
  "utf8",
);

const requireToken = (token, value) => {
  const pattern = new RegExp(
    `${token.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}\\s*:\\s*${value}`,
    "u",
  );
  check(`token ${token}`, pattern.test(css), `expected ${token}: ${value}`);
};

requireToken("--bg", "#0a0a0a");
requireToken("--surface-1", "#101010");
requireToken("--surface-2", "#141414");
requireToken("--emerald", "#10b981");
requireToken("--amber", "#f59e0b");
requireToken("--faint", "#8f8f8f");

check(
  "mono stack",
  /--mono:\s*[\s\S]*?"JetBrains Mono"[\s\S]*?"Fira Code"/u.test(css),
  "mono stack must lead with JetBrains Mono then Fira Code",
);
check(
  "sans stack",
  /--sans:\s*[\s\S]*?Inter/u.test(css),
  "sans stack must lead with Inter",
);
check(
  "no solid card borders",
  !/\.(railPanel|stripSection|topoSection|metric|drawer|modal)[^{]*\{[^}]*border:\s*1px\s+solid/u.test(
    css,
  ),
  "card-level containers must not declare border: 1px solid",
);
check(
  "topology height >= 56vh",
  /\.topoStage\s*\{[^}]*height:\s*clamp\([^)]*56vh|\.topoStage\s*\{[^}]*height:\s*clamp\([^)]*64vh/u.test(
    css,
  ),
  "topology stage must occupy at least 56vh",
);
check(
  "drawer anchored left",
  /\.drawer\s*\{[^}]*left:\s*0/u.test(css),
  "drawer must be fixed to the left edge",
);
const channel = (value) => {
  const normalized = value / 255;
  return normalized <= 0.03928
    ? normalized / 12.92
    : ((normalized + 0.055) / 1.055) ** 2.4;
};
const luminance = (hex) => {
  const raw = hex.replace("#", "");
  const red = Number.parseInt(raw.slice(0, 2), 16);
  const green = Number.parseInt(raw.slice(2, 4), 16);
  const blue = Number.parseInt(raw.slice(4, 6), 16);
  return (
    0.2126 * channel(red) + 0.7152 * channel(green) + 0.0722 * channel(blue)
  );
};
const contrast = (foreground, background) => {
  const a = luminance(foreground);
  const b = luminance(background);
  const lighter = Math.max(a, b);
  const darker = Math.min(a, b);
  return (lighter + 0.05) / (darker + 0.05);
};
check(
  "faint contrast on bg",
  contrast("#8f8f8f", "#0a0a0a") >= 4.5,
  `contrast ${contrast("#8f8f8f", "#0a0a0a").toFixed(2)} must be >= 4.5`,
);
check(
  "faint contrast on surface-2",
  contrast("#8f8f8f", "#141414") >= 4.5,
  `contrast ${contrast("#8f8f8f", "#141414").toFixed(2)} must be >= 4.5`,
);
check(
  "emerald primary accent",
  /\.queryActions button\s*\{[^}]*background:\s*var\(--emerald\)/u.test(css),
  "primary action should use emerald",
);
check(
  "no default blue accent",
  !/#2f6feb|#6ea0ff/iu.test(css),
  "old blue accent tokens must be gone",
);
check(
  "topology is not wrapped in a card",
  /<section className="topoSection"[\s\S]*?<TopologyCanvas/u.test(app),
  "topology must be mounted directly in the full-bleed section",
);
check(
  "drawer opens from node selection",
  /onSelect=\{openNode\}/u.test(app),
  "App must wire node selection to the drawer",
);
const fitFloor =
  /FIT_MIN_ZOOM\s*=\s*([0-9.]+)/u.exec(topology) ??
  /MIN_ZOOM\s*=\s*([0-9.]+)/u.exec(topology);
const fitFloorValue = fitFloor === null ? Number.NaN : Number(fitFloor[1]);
check(
  "topology fit floor",
  Number.isFinite(fitFloorValue) && fitFloorValue <= 0.03,
  "fit must be able to fit a 400-node graph",
);
const oneColumnHeight = 84 + 399 * 76 + 24;
const neededFit = (820 - 56) / oneColumnHeight;
check(
  "400-node single column fits",
  Number.isFinite(fitFloorValue) && fitFloorValue <= neededFit,
  `fit floor ${String(fitFloorValue)} must be <= ${neededFit.toFixed(4)}`,
);
check(
  "node glow",
  /filter="url\(#nodeGlow\)"/u.test(topology),
  "nodes must render with a glow filter",
);

const distDir = join(root, "dist", "assets");
const built = await readdir(distDir).catch(() => []);
const builtCss = built.filter((name) => name.endsWith(".css"));
check(
  "built CSS present",
  builtCss.length > 0,
  "run npm run build before the audit",
);
let workbenchBundles = 0;
for (const name of builtCss) {
  const text = await readFile(join(distDir, name), "utf8");
  if (!text.includes("--bg:")) continue;
  workbenchBundles += 1;
  check(
    `built CSS ${name}`,
    text.includes("#0a0a0a") && text.includes("#10b981"),
    "built bundle must carry the workbench tokens",
  );
}
check(
  "workbench CSS bundle",
  workbenchBundles > 0,
  "no built CSS bundle carries --bg",
);

for (const entry of checks) {
  process.stdout.write(
    `${entry.ok ? "PASS" : "FAIL"}  ${entry.name}${entry.ok ? "" : ` — ${entry.detail}`}\n`,
  );
}

if (failures.length > 0) {
  process.stderr.write(`\n${failures.length} design audit failure(s)\n`);
  process.exit(1);
}
process.stdout.write(`\n${checks.length} design checks passed\n`);
