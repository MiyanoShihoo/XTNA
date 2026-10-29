#!/usr/bin/env node
/**
 * Narrate the difference between two structured reports.
 *
 * Records are paired by a stable key (default `name`, then `id`, then `path`);
 * every other field is compared as-is. The output is Markdown or JSON, and says
 * what changed — never why.
 */
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const flag = (name) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};
const asJson = args.includes("--json");

const beforePath = flag("before");
const afterPath = flag("after");
const output = flag("out");

if (beforePath === undefined || afterPath === undefined) {
  process.stderr.write(
    "usage: node scripts/diff-narrate.mjs --before <a.json> --after <b.json> [--key name] [--out report.md] [--json]\n",
  );
  process.exit(2);
}

const { diffDocuments, narrateDiff } = await import(
  pathToFileURL(resolve("dist/application/diff/VersionDiffNarrative.js")).href
);

const readJson = async (path) =>
  JSON.parse((await readFile(resolve(path), "utf8")).replace(/^\uFEFF/u, ""));

const diff = diffDocuments(
  await readJson(beforePath),
  await readJson(afterPath),
  {
    ...(flag("key") === undefined ? {} : { key: flag("key") }),
  },
);
const markdown = narrateDiff(diff);

if (asJson) {
  process.stdout.write(
    `${JSON.stringify({ before: resolve(beforePath), after: resolve(afterPath), diff }, null, 2)}\n`,
  );
} else if (output === undefined) {
  process.stdout.write(`${markdown}\n`);
} else {
  await writeFile(resolve(output), `${markdown}\n`, "utf8");
  process.stderr.write(`wrote ${resolve(output)}\n`);
}
