#!/usr/bin/env node
/**
 * Render analysis text through a symbol overlay.
 *
 * Two modes:
 *   --evidence <bundle.json>   render strings already stored in an Evidence bundle
 *   --procedure <selector>     run one decompile through the CLI, render its output
 *
 * Evidence stays byte-identical in both: this rewrites a copy for display.
 */
import { writeSync } from "node:fs";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const flag = (name) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};

/** Write synchronously: process.exit() drops buffered stderr writes. */
const die = (message, code = 1) => {
  writeSync(2, `${message}\n`);
  process.exit(code);
};

const binary = flag("binary");
const evidencePath = flag("evidence");
const procedure = flag("procedure");
const provider = flag("provider");
const targetPath = flag("path");
const outPath = flag("out");

const usage =
  "usage:\n" +
  "  node scripts/overlay-render.mjs --binary <path|sha256> --evidence <bundle.json> [--out rendered.md]\n" +
  "  node scripts/overlay-render.mjs --binary <path|sha256> --procedure <name|address> [--path <target>] [--provider <id>] [--out rendered.md]\n";

if (binary === undefined || (evidencePath === undefined && procedure === undefined)) {
  die(usage, 2);
}
if (evidencePath !== undefined && procedure !== undefined) {
  die(`choose one source: --evidence or --procedure\n${usage}`, 2);
}

const overlayDir = resolve(
  process.env.XTNA_OVERLAY_DIR ?? join(homedir(), ".xtna", "overlays"),
);
const digest = /^[0-9a-f]{64}$/u.test(binary)
  ? binary
  : createHash("sha256").update(await readFile(resolve(binary))).digest("hex");

const overlayRaw = await readFile(join(overlayDir, `${digest}.json`), "utf8").catch(
  () => null,
);
if (overlayRaw === null) {
  die(`no overlay for ${digest}; run "npm run overlay -- add ..." first`);
}
const overlay = JSON.parse(overlayRaw);

const { applySymbolOverlay, hasAddressPlaceholder } = await import(
  pathToFileURL(join(process.cwd(), "dist/application/overlays/SymbolOverlayRendering.js"))
    .href
);

/**
 * Run one decompile through the CLI entry point and return the JSON document it
 * prints. Output is redirected to files rather than pipes so the call also works
 * in sessions where child-process pipes are unavailable.
 */
const decompileJson = async () => {
  const target =
    targetPath ?? (/^[0-9a-f]{64}$/u.test(binary) ? undefined : binary);
  if (target === undefined) {
    die("--path is required when --binary is a digest in live mode", 2);
  }
  const cliArgs = ["decompile", target, procedure, "--json"];
  if (provider !== undefined) cliArgs.push("--provider", provider);
  const workDir = await mkdtemp(join(tmpdir(), "xtna-overlay-"));
  const stdoutPath = join(workDir, "stdout.json");
  const stderrPath = join(workDir, "stderr.log");
  const [outHandle, errHandle] = await Promise.all([
    open(stdoutPath, "w"),
    open(stderrPath, "w"),
  ]);
  let status;
  try {
    status = await new Promise((resolveStatus, reject) => {
      const child = spawn(process.execPath, [resolve("scripts/rea.mjs"), ...cliArgs], {
        stdio: ["ignore", outHandle.fd, errHandle.fd],
        env: process.env,
      });
      child.on("error", reject);
      child.on("close", (code) => resolveStatus(code ?? 1));
    });
  } finally {
    await Promise.all([outHandle.close(), errHandle.close()]);
  }
  const [stdout, stderr] = await Promise.all([
    readFile(stdoutPath, "utf8"),
    readFile(stderrPath, "utf8"),
  ]);
  await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  const trimmed = stdout.trim();
  if (trimmed === "") {
    throw new Error(
      `decompile produced no output (exit ${String(status)}): ${stderr.slice(0, 400)}`,
    );
  }
  try {
    return JSON.parse(trimmed);
  } catch (cause) {
    throw new Error(`decompile did not return JSON: ${trimmed.slice(0, 400)}`, {
      cause,
    });
  }
};

const document =
  evidencePath === undefined
    ? await decompileJson()
    : JSON.parse(
        (await readFile(resolve(evidencePath), "utf8")).replace(/^\uFEFF/u, ""),
      );

// An error document is still valid JSON; rendering it would report "0 replacements"
// for an analysis that never ran.
if (
  typeof document === "object" &&
  document !== null &&
  (Reflect.get(document, "error") !== undefined ||
    Reflect.get(document, "ok") === false)
) {
  die(`analysis failed: ${JSON.stringify(document).slice(0, 800)}`);
}

const records = [];
const walk = (value, trail) => {
  if (typeof value === "string") {
    if (value.length >= 16 && hasAddressPlaceholder(value))
      records.push({ trail, text: value });
    return;
  }
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => walk(item, `${trail}[${String(index)}]`));
    return;
  }
  for (const [key, child] of Object.entries(value))
    walk(child, trail === "" ? key : `${trail}.${key}`);
};
walk(document, "");

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
  "# Overlay-rendered analysis",
  "",
  `- binary SHA-256: \`${digest}\``,
  `- source: ${evidencePath === undefined ? `live decompile of \`${procedure}\`` : `\`${evidencePath}\``}`,
  `- overlay entries: ${String((overlay.entries ?? []).length)}`,
  `- rendered strings: ${String(sections.length)}`,
  `- identifier replacements: ${String(total)}`,
  "",
  "> Rendering only. The analysis document is unchanged; nothing was written back.",
  "",
];
for (const section of sections) {
  lines.push(`## ${section.trail}`, "", "```c", section.text, "```", "");
  lines.push(
    `Replaced: ${section.replacements.map((r) => `${r.from} → ${r.to}`).join(", ")}`,
    "",
  );
}

const markdown = `${lines.join("\n")}\n`;
if (outPath === undefined) process.stdout.write(markdown);
else {
  await writeFile(resolve(outPath), markdown, "utf8");
  process.stderr.write(
    `rendered ${String(sections.length)} strings to ${String(outPath)}\n`,
  );
}
