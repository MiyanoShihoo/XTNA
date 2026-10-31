#!/usr/bin/env node
/**
 * Run one admitted command through a detected container backend.
 *
 * This never falls back to host execution. Without Docker/Podman the command
 * is refused, even if L2/L3 approval is present.
 *
 * usage: node scripts/sandbox-run.mjs --image <image> --tier L2|L3 -- [command args...]
 *        [--cwd <dir>] [--diff-preview] [--approval-token <token>] [--json]
 */
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const separator = args.indexOf("--");
const before = separator === -1 ? args : args.slice(0, separator);
const command = separator === -1 ? [] : args.slice(separator + 1);
const flag = (name) => {
  const index = before.indexOf(`--${name}`);
  return index >= 0 ? before[index + 1] : undefined;
};

const image = flag("image");
const tier = flag("tier");
if (
  image === undefined ||
  (tier !== "L2" && tier !== "L3") ||
  command.length === 0
) {
  process.stderr.write(
    "usage: node scripts/sandbox-run.mjs --image <image> --tier L2|L3 [--cwd dir] [--diff-preview] [--approval-token token] -- <command args...>\n",
  );
  process.exit(2);
}

const { probeSandboxCapability } = await import(
  pathToFileURL(resolve("dist/application/sandbox/SandboxCapability.js")).href
);
const { executeSandboxCommand } = await import(
  pathToFileURL(resolve("dist/application/sandbox/SandboxExecution.js")).href
);

const capability = await probeSandboxCapability();
const request = {
  tier,
  image,
  command: command[0],
  arguments: command.slice(1),
  ...(flag("cwd") === undefined ? {} : { cwd: flag("cwd") }),
  diffPreview: before.includes("--diff-preview"),
  ...(flag("approval-token") === undefined
    ? {}
    : { approvalToken: flag("approval-token") }),
  ...(flag("timeout-ms") === undefined
    ? {}
    : { timeoutMs: Math.max(1, Number(flag("timeout-ms"))) }),
};
const result = await executeSandboxCommand(capability, request);

if (before.includes("--json")) {
  process.stdout.write(`${JSON.stringify({ capability, result }, null, 2)}\n`);
} else {
  process.stdout.write(`backend best: ${capability.best}\n`);
  process.stdout.write(
    `tier ${tier}: ${result.allowed ? "executed" : "refused"} — ${result.reason}\n`,
  );
  if (result.invocation !== undefined)
    process.stdout.write(`invocation: ${result.invocation.join(" ")}\n`);
  if (result.result !== undefined) {
    process.stdout.write(`exit: ${String(result.result.exitCode)}\n`);
    if (result.result.stdout.length > 0)
      process.stdout.write(`stdout:\n${result.result.stdout}\n`);
    if (result.result.stderr.length > 0)
      process.stdout.write(`stderr:\n${result.result.stderr}\n`);
  }
}
process.exitCode = result.allowed ? (result.result?.exitCode ?? 1) : 4;
