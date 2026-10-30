#!/usr/bin/env node
/**
 * Normalize minified JavaScript before it reaches an agent's context.
 *
 * Literal-only expressions are folded, literal-tested branches collapse, and
 * escaped strings are decoded. Nothing is evaluated: every rule requires
 * literal operands, so calls, getters and identifiers are left alone. The
 * output is derived from the input bytes; the input file is never modified.
 */
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const flag = (name) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};
const has = (name) => args.includes(`--${name}`);

const input = flag("in");
const output = flag("out");
const maxPasses = flag("max-passes");
const asJson = has("json");

if (input === undefined) {
  process.stderr.write(
    "usage: node scripts/ast-normalize.mjs --in <file> [--out <file>] [--max-passes n] [--json]\n",
  );
  process.exit(2);
}

const { normalizeJavaScriptAst } = await import(
  pathToFileURL(resolve("dist/application/javascript/AstNormalization.js")).href
);

const source = await readFile(resolve(input), "utf8");
const normalized = normalizeJavaScriptAst(source, {
  ...(maxPasses === undefined ? {} : { maxPasses: Number(maxPasses) }),
});
if (!normalized.ok) {
  process.stderr.write(
    `${normalized.error.code}: ${normalized.error.message}\n`,
  );
  process.exit(1);
}
const result = normalized.value;

if (asJson) {
  process.stdout.write(
    `${JSON.stringify(
      {
        input: resolve(input),
        ...(output === undefined ? {} : { output: resolve(output) }),
        input_bytes: Buffer.byteLength(source),
        output_bytes: Buffer.byteLength(result.transformed),
        ...result.stats,
        observations: result.observations,
        unknowns: result.unknowns,
        coverage: result.coverage,
        limits: result.limits,
      },
      null,
      2,
    )}\n`,
  );
} else if (output === undefined) {
  process.stdout.write(result.transformed);
} else {
  await writeFile(resolve(output), result.transformed, "utf8");
  process.stderr.write(
    `normalized ${String(result.stats.foldedConstants)} constants, ` +
      `${String(result.stats.removedBranches)} branches, ` +
      `${String(result.stats.decodedStrings)} strings -> ${resolve(output)}\n`,
  );
}
