#!/usr/bin/env node
/**
 * Export an XTNA application graph into the taint-path graph format.
 *
 * Accepts either a raw JavaScript application graph (nodes with `node_id`,
 * edges with `source_node_id`/`target_node_id`) or an Evidence bundle that
 * contains one. Node kinds can be remapped onto source / sink / sanitizer so
 * `taint-path.mjs` can run without a second manual pass.
 */
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  const value = index >= 0 ? args[index + 1] : undefined;
  return value === undefined ? fallback : value;
};

const inputPath = flag("input");
if (inputPath === undefined) {
  process.stderr.write(
    "usage: node scripts/graph-export.mjs --input <jag.json|bundle.json> --out <graph.json> " +
      "[--map-source kinds] [--map-sink kinds] [--map-sanitizer kinds]\n",
  );
  process.exit(2);
}
const outPath = flag("out");
if (outPath === undefined) {
  process.stderr.write("--out is required\n");
  process.exit(2);
}

const splitKinds = (value) =>
  typeof value === "string" && value.length > 0
    ? value.split(",").map((kind) => kind.trim()).filter(Boolean)
    : [];

const sourceKinds = splitKinds(flag("map-source"));
const sinkKinds = splitKinds(flag("map-sink"));
const sanitizerKinds = splitKinds(flag("map-sanitizer"));

const document = JSON.parse((await readFile(resolve(inputPath), "utf8")).replace(/^\uFEFF/u, ""));

/** Find the first object that looks like an application graph. */
const findGraph = (value, depth = 0) => {
  if (depth > 24 || value === null || typeof value !== "object") return null;
  if (
    Array.isArray(value.nodes) &&
    Array.isArray(value.edges) &&
    value.nodes.length > 0 &&
    typeof value.nodes[0]?.node_id === "string"
  )
    return value;
  for (const child of Object.values(value)) {
    const found = findGraph(child, depth + 1);
    if (found !== null) return found;
  }
  return null;
};

const graph = findGraph(document);
if (graph === null) {
  process.stderr.write("no application graph found in the input\n");
  process.exit(1);
}

const kindOf = (node) => {
  if (sourceKinds.includes(node.kind)) return "source";
  if (sinkKinds.includes(node.kind)) return "sink";
  if (sanitizerKinds.includes(node.kind)) return "sanitizer";
  return node.kind ?? "unknown";
};

const labelOf = (node) =>
  node.label ??
  node.identity?.role_key ??
  node.identity?.key ??
  String(node.node_id);

const nodes = graph.nodes.map((node) => ({
  id: String(node.node_id),
  kind: kindOf(node),
  label: labelOf(node),
}));

const known = new Set(nodes.map((node) => node.id));
const edges = [];
for (const edge of graph.edges) {
  const from = String(edge.source_node_id ?? edge.from);
  const to = String(edge.target_node_id ?? edge.to);
  if (!known.has(from) || !known.has(to)) continue;
  edges.push({ from, to, label: String(edge.relation ?? edge.label ?? "relation") });
}

const exported = {
  schema: "xtna.taint-graph/1",
  source_graph_id: graph.graph_id ?? null,
  kind_map: {
    source: sourceKinds,
    sink: sinkKinds,
    sanitizer: sanitizerKinds,
  },
  nodes,
  edges,
};

await writeFile(resolve(outPath), `${JSON.stringify(exported, null, 2)}\n`, "utf8");
const counts = nodes.reduce((acc, node) => {
  acc[node.kind] = (acc[node.kind] ?? 0) + 1;
  return acc;
}, {});
process.stderr.write(
  `exported ${String(nodes.length)} nodes / ${String(edges.length)} edges -> ${outPath} ` +
    `(${Object.entries(counts).map(([kind, count]) => `${kind}=${String(count)}`).join(", ")})\n`,
);
