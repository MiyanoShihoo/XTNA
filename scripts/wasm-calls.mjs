#!/usr/bin/env node
/**
 * Report the intra-module call graph of a WebAssembly binary.
 *
 * Decodes function bodies far enough to find `call` and `call_indirect` sites.
 * Unknown opcodes (SIMD, atomics, future proposals) mark the function undecoded
 * instead of guessing; nothing is executed.
 */
import { readFile, stat } from "node:fs/promises";
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
    "usage: node scripts/wasm-calls.mjs --in <module.wasm> [--json]\n",
  );
  process.exit(2);
}

const { readWasmCallGraph } = await import(
  pathToFileURL(resolve("dist/application/wasm/WasmCallGraph.js")).href
);

const path = resolve(input);
const info = await stat(path);
if (!info.isFile()) {
  process.stderr.write(`${path} is not a regular file\n`);
  process.exit(2);
}
const graph = readWasmCallGraph(await readFile(path));

if (!graph.ok) {
  process.stderr.write(`wasm: ${graph.error.message}\n`);
  process.exit(3);
}

const value = graph.value;
const label = (index) => {
  const fact = value.functions.find((item) => item.index === index);
  return fact?.name === undefined
    ? `f${String(index)}`
    : `${fact.name} (f${String(index)})`;
};

if (args.includes("--json")) {
  process.stdout.write(
    `${JSON.stringify({ path, bytes: info.size, ...value }, null, 2)}\n`,
  );
} else {
  const lines = [
    `wasm call graph: ${path}`,
    `functions: ${String(value.functions.length)} defined, ${String(value.importedFunctions)} imported`,
    `edges: ${String(value.edges.length)}${value.truncated ? " (truncated at the edge cap)" : ""}`,
    `undecoded: ${value.undecodedFunctions.length === 0 ? "none" : value.undecodedFunctions.map(String).join(", ")}`,
  ];
  for (const edge of value.edges.slice(0, 200))
    lines.push(
      edge.kind === "direct"
        ? `  ${label(edge.from)} -> ${label(edge.to ?? -1)}`
        : `  ${label(edge.from)} -> indirect(type ${String(edge.typeIndex ?? -1)})`,
    );
  if (value.edges.length > 200) lines.push("  ...");
  process.stdout.write(`${lines.join("\n")}\n`);
}
