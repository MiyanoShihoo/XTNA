#!/usr/bin/env node
/**
 * Statically link a .wasm module to its JavaScript glue.
 *
 * Reads the import and export sections from the module and the import object
 * plus `exports.<name>` accesses from the glue, then reports the candidate call
 * graph in both directions. Nothing is instantiated or executed.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const flag = (name) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};
const asJson = args.includes("--json");

const wasmPath = flag("wasm");
const jsPath = flag("js");

if (wasmPath === undefined || jsPath === undefined) {
  process.stderr.write(
    "usage: node scripts/wasm-link.mjs --wasm <module.wasm> --js <glue.js> [--json]\n",
  );
  process.exit(2);
}

const { analyzeGlue, buildBridgeGraph, readWasmInterface } = await import(
  pathToFileURL(resolve("dist/application/wasm/WasmBridgeGraph.js")).href
);

const wasm = readWasmInterface(
  new Uint8Array(await readFile(resolve(wasmPath))),
);
const glueSource = (await readFile(resolve(jsPath), "utf8")).replace(
  /^\uFEFF/u,
  "",
);
const graph = buildBridgeGraph(wasm, analyzeGlue(glueSource));

if (asJson) {
  process.stdout.write(
    `${JSON.stringify(
      {
        wasm: resolve(wasmPath),
        js: resolve(jsPath),
        imports: wasm.imports,
        exports: wasm.exports,
        ...graph,
      },
      null,
      2,
    )}\n`,
  );
} else {
  process.stdout.write(
    `# ${String(wasm.imports.length)} imports, ${String(wasm.exports.length)} exports\n`,
  );
  process.stdout.write(
    `# instantiation: ${graph.instantiationLine === undefined ? "not found" : `line ${String(graph.instantiationLine)}`}\n`,
  );
  for (const edge of graph.jsToWasm)
    process.stdout.write(
      `  js -> wasm  exports.${edge.to}  (line ${String(edge.line)})\n`,
    );
  for (const edge of graph.wasmToJs)
    process.stdout.write(
      `  wasm -> js  ${edge.from}  => ${edge.to}  (line ${String(edge.line)})\n`,
    );
  if (graph.unresolvedImports.length > 0)
    process.stdout.write(
      `  unresolved: ${graph.unresolvedImports.join(", ")}\n`,
    );
  if (graph.unusedExports.length > 0)
    process.stdout.write(
      `  unused exports: ${graph.unusedExports.join(", ")}\n`,
    );
}
