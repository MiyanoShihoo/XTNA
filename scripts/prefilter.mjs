#!/usr/bin/env node
/**
 * Label one piece of text with a local Ollama-compatible model.
 *
 * usage: node scripts/prefilter.mjs --endpoint http://127.0.0.1:11434 --model qwen2.5:3b (--text "…" | --file path) [--json]
 *
 * The endpoint must be loopback. An unreachable model yields `unknown`; the
 * caller keeps the text either way, so a missing model never hides evidence.
 */
import { readFile } from "node:fs/promises";

const args = process.argv.slice(2);
const flag = (name) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};

const endpoint = flag("endpoint");
const model = flag("model");
if (endpoint === undefined || model === undefined) {
  process.stderr.write(
    "usage: node scripts/prefilter.mjs --endpoint <loopback-url> --model <name> (--text <text> | --file <path>) [--json]\n",
  );
  process.exit(2);
}

const { createLocalModelPrefilter } = await import(
  new URL("../dist/application/model/LocalModelPrefilter.js", import.meta.url)
    .href
);

const text =
  flag("file") === undefined
    ? flag("text")
    : await readFile(flag("file"), "utf8");
if (text === undefined) {
  process.stderr.write("provide --text or --file\n");
  process.exit(2);
}

const result = await createLocalModelPrefilter({ endpoint, model }).classify(
  text,
);
if (args.includes("--json"))
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
else
  process.stdout.write(
    `${result.label} (${result.confidence.toFixed(2)}) — ${result.reason} [${result.model}, ${String(result.latencyMs)} ms]\n`,
  );
if (result.label === "unknown") process.exitCode = 3;
