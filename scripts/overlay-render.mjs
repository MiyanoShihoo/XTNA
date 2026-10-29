#!/usr/bin/env node
/**
 * Render stored analysis text through a symbol overlay.
 *
 * Evidence stays byte-identical: this reads a bundle, rewrites a copy of
 * pseudocode/assembly strings for display, and writes Markdown.
 */
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const flag = (name) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};

const binary = flag("binary");
const evidencePath = flag("evidence");
const outPath = flag("out");
if (binary === undefined || evidencePath === undefined) {
  process.stderr.write(
    "usage: node scripts/overlay-render.mjs --binary <path|sha256> --evidence <bundle.json> [--out rendered.md]\n",
  );
  process.exit(2);
}

const overlayDir = resolve(process.env.XTNA_OVERLAY_DIR ?? join(homedir(), ".xtna", "overlays"));
const digest = /^[0-9a-f]{64}$/u.test(binary)
  ? binary
  : createHash("sha256").update(await readFile(resolve(binary))).digest("hex");

const overlayRaw = await readFile(join(overlayDir, `${digest}.json`), "utf8").catch(() => null);
if (overlayRaw === null) {
  process.stderr.write(`no overlay for ${digest}; run "npm run overlay -- add ..." first\n`);
  process.exit(1);
}
const overlay = JSON.parse(overlayRaw);

const { applySymbolOverlay, hasAddressPlaceholder } = await import(
  pathToFileURL(join(process.cwd(), "dist/application/overlays/SymbolOverlayRendering.js")).href
);

const bundle = JSON.parse((await readFile(resolve(evidencePath), "utf8")).replace(/^\uFEFF/u, ""));

const records = [];
const walk = (value, trail) => {
  if (typeof value === "string") {
    if (value.length >= 16 && hasAddressPlaceholder(value)) records.push({ trail, text: value });
    return;
  }
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => walk(item, `${trail}[${String(index)}]`));
    return;
  }
  for (const [key, child] of Object.entries(value)) walk(child, trail === "" ? key : `${trail}.${key}`);
};
walk(bundle, "");

const sections = [];
const seen = new Set();
let total = 0;
for (const record of records) {
  const rendered = applySymbolOverlay(record.text, overlay.entries ?? []);
  if (rendered.replacements.length === 0) continue;
  const key = `${record.trail}\0${rendered.text}`;
  if (seen.has(key)) continue;
  seen.add(key);
  total += rendered.replacements.length;
  sections.push({ trail: record.trail, ...rendered });
}

const lines = [
  `# Overlay-rendered analysis`,
  "",
  `- binary SHA-256: \`${digest}\``,
  `- overlay entries: ${String((overlay.entries ?? []).length)}`,
  `- rendered strings: ${String(sections.length)}`,
  `- identifier replacements: ${String(total)}`,
  "",
  "> Rendering only. The evidence bundle on disk is unchanged.",
  "",
];
for (const section of sections) {
  lines.push(`## ${section.trail}`, "", "```c", section.text, "```", "");
  lines.push(`Replaced: ${section.replacements.map((r) => `${r.from} 鈫?${r.to}`).join(", ")}`, "");
}

const markdown = `${lines.join("\n")}\n`;
if (outPath === undefined) process.stdout.write(markdown);
else {
  await writeFile(resolve(outPath), markdown, "utf8");
  process.stderr.write(`rendered ${String(sections.length)} strings to ${String(outPath)}\n`);
}
