#!/usr/bin/env node
/**
 * Generate a runtime-probe skeleton for one address.
 *
 * The script is a starting point: it records entry arguments, the return value
 * and a short backtrace as JSON lines. Nothing attaches to a target here.
 */
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const flag = (name) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};

const provider = flag("provider") ?? "frida";
const address = flag("address") ?? flag("procedure");
const output = flag("out");

if (address === undefined) {
  process.stderr.write(
    "usage: node scripts/probe-gen.mjs --address <0x…|symbol> [--provider frida|lldb] [--module name] [--args 4] [--frames 4] [--symbol label] [--out probe.js]\n",
  );
  process.exit(2);
}
if (provider !== "frida" && provider !== "lldb") {
  process.stderr.write("--provider must be frida or lldb\n");
  process.exit(2);
}

const { generateProbe } = await import(
  pathToFileURL(resolve("dist/application/probes/RuntimeProbeGeneration.js"))
    .href
);

const script = generateProbe({
  provider,
  address,
  ...(flag("module") === undefined ? {} : { moduleName: flag("module") }),
  ...(flag("args") === undefined
    ? {}
    : { argumentCount: Number(flag("args")) }),
  ...(flag("frames") === undefined
    ? {}
    : { backtraceFrames: Number(flag("frames")) }),
  ...(flag("symbol") === undefined ? {} : { symbol: flag("symbol") }),
});

if (output === undefined) {
  process.stdout.write(script);
} else {
  const target = resolve(output);
  await writeFile(target, script, "utf8");
  process.stderr.write(`wrote ${provider} probe for ${address} -> ${target}\n`);
}
