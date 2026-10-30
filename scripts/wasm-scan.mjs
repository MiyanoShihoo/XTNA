#!/usr/bin/env node
/**
 * Scan a directory for WebAssembly modules and report each call graph.
 *
 * Detection is by magic, so renamed and extension-less modules are still found.
 * The scan is bounded: 500 files, 16 MiB per module and eight directory levels
 * by default; hitting a bound is reported rather than silently ignored.
 */
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const flag = (name) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};

const input = flag("in");
if (input === undefined) {
  process.stderr.write(
    "usage: node scripts/wasm-scan.mjs --in <dir> [--max-files N] [--json]\n",
  );
  process.exit(2);
}

const { scanWasmDirectory } = await import(
  pathToFileURL(resolve("dist/application/wasm/WasmModuleScan.js")).href
);

const directory = resolve(input);
const info = await stat(directory).catch(() => null);
if (info === null || !info.isDirectory()) {
  process.stderr.write(`${directory} is not a directory\n`);
  process.exit(2);
}

const maxFiles = flag("max-files");
const report = await scanWasmDirectory(
  directory,
  maxFiles === undefined ? {} : { maxFiles: Number(maxFiles) },
);

if (args.includes("--json")) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
  const lines = [
    `wasm scan: ${report.root}`,
    `modules: ${String(report.modules.length)} (files examined ${String(report.scannedFiles)}, non-wasm ${String(report.skippedNonWasm)})`,
  ];
  for (const module of report.modules)
    lines.push(
      `  ${module.path}  functions=${String(module.functions)} edges=${String(module.edges)} undecoded=${String(module.undecodedFunctions)}`,
    );
  if (report.truncated) lines.push("truncated: true");
  for (const limitation of report.limitations) lines.push(`  ! ${limitation}`);
  process.stdout.write(`${lines.join("\n")}\n`);
}
