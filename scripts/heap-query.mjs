#!/usr/bin/env node
/**
 * Query a V8 heap snapshot without an inspector session.
 *
 * Prints the constructors that hold the most memory, or the instances of one
 * exact name with their ids and sizes. Read-only: the snapshot file is never
 * modified and nothing is executed.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const flag = (name) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};

const input = flag("in");
const name = flag("name");
const minCount = flag("min-count");
const limit = flag("limit");
const asJson = args.includes("--json");

if (input === undefined) {
  process.stderr.write(
    "usage: node scripts/heap-query.mjs --in <snapshot.heapsnapshot> [--name Constructor] [--min-count 2] [--limit 25] [--json]\n",
  );
  process.exit(2);
}

const heap = await import(
  pathToFileURL(resolve("dist/application/heap/HeapSnapshotQuery.js")).href
);

const document = JSON.parse(
  (await readFile(resolve(input), "utf8")).replace(/^\uFEFF/u, ""),
);
const total = heap.heapNodeCount(document);

if (name !== undefined) {
  const nodes = heap.findHeapNodes(
    document,
    name,
    limit === undefined ? 20 : Number(limit),
  );
  const references = heap.incomingReferenceCounts(document);
  if (asJson) {
    process.stdout.write(
      `${JSON.stringify(
        {
          input: resolve(input),
          name,
          nodes: nodes.map((node) => ({
            id: node.id,
            type: node.type,
            self_size: node.selfSize,
            incoming_references: references.get(node.index) ?? 0,
          })),
        },
        null,
        2,
      )}\n`,
    );
  } else {
    process.stdout.write(`# ${name}: ${String(nodes.length)} instance(s)\n`);
    for (const node of nodes)
      process.stdout.write(
        `  id=${String(node.id)} type=${node.type} self=${String(node.selfSize)}B refs=${String(references.get(node.index) ?? 0)}\n`,
      );
  }
} else {
  const rows = heap.summarizeHeap(document, {
    ...(minCount === undefined ? {} : { minCount: Number(minCount) }),
    ...(limit === undefined ? {} : { limit: Number(limit) }),
  });
  if (asJson) {
    process.stdout.write(
      `${JSON.stringify({ input: resolve(input), nodes: total, rows }, null, 2)}\n`,
    );
  } else {
    process.stdout.write(`# nodes: ${String(total)}\n`);
    for (const row of rows)
      process.stdout.write(
        `  ${row.name || "(anonymous)"} [${row.type}] count=${String(row.count)} total=${String(row.selfSize)}B avg=${String(row.averageSize)}B max=${String(row.largestSize)}B\n`,
      );
  }
}
