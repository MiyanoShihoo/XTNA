#!/usr/bin/env node
/**
 * XTNA taint path search over an explicit property graph.
 *
 * The graph is supplied as JSON:
 *   { "nodes": [{ "id": "...", "kind": "source|sink|sanitizer|...", "label": "..." }],
 *     "edges": [{ "from": "...", "to": "...", "label": "..." }] }
 *
 * The search enumerates simple paths from a source selector to a sink selector,
 * refuses to pass through sanitizer nodes, and stops at a hop ceiling and a path
 * ceiling. It reports truncation instead of silently returning a short list.
 *
 * This is a graph algorithm, not a claim about a specific program: the graph must
 * come from an analysis that recorded its own coverage.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  const value = index >= 0 ? args[index + 1] : undefined;
  return value === undefined ? fallback : value;
};
const flags = new Set(args.filter((a) => a.startsWith("--")));

const graphPath = flag("graph");
if (graphPath === undefined) {
  process.stderr.write(
    "usage: node scripts/taint-path.mjs --graph g.json --source <sel> --sink <sel> " +
      "[--sanitizer <sel>]... [--max-hops 5] [--max-paths 20] [--json]\n",
  );
  process.exit(2);
}

const maxHops = Number(flag("max-hops", "5"));
const maxPaths = Number(flag("max-paths", "20"));
if (!Number.isInteger(maxHops) || maxHops < 1 || maxHops > 64) {
  process.stderr.write("--max-hops must be an integer 1..64\n");
  process.exit(2);
}
if (!Number.isInteger(maxPaths) || maxPaths < 1 || maxPaths > 1000) {
  process.stderr.write("--max-paths must be an integer 1..1000\n");
  process.exit(2);
}

const sanitizers = [];
for (let index = 0; index < args.length; index += 1)
  if (args[index] === "--sanitizer" && args[index + 1] !== undefined)
    sanitizers.push(args[index + 1]);

const rawGraph = await readFile(resolve(graphPath), "utf8");
const graph = JSON.parse(rawGraph.replace(/^\uFEFF/u, ""));
const nodes = new Map((graph.nodes ?? []).map((node) => [node.id, node]));
const adjacency = new Map();
for (const edge of graph.edges ?? []) {
  const list = adjacency.get(edge.from) ?? [];
  list.push(edge);
  adjacency.set(edge.from, list);
}
for (const list of adjacency.values())
  list.sort(
    (a, b) =>
      String(a.to).localeCompare(String(b.to)) ||
      String(a.label ?? "").localeCompare(String(b.label ?? "")),
  );

const matches = (node, selector) =>
  node.id === selector || node.kind === selector || node.label === selector;

const select = (selector) =>
  [...nodes.values()]
    .filter((node) => matches(node, selector))
    .map((node) => node.id)
    .sort();
const sourceIds = select(flag("source", "source"));
const sinkIds = new Set(select(flag("sink", "sink")));
const sanitizerIds = new Set(sanitizers.flatMap(select));

if (sourceIds.length === 0 || sinkIds.size === 0) {
  const report = {
    graph: graphPath,
    status: "no-match",
    reason:
      sourceIds.length === 0
        ? "source selector matched no node"
        : "sink selector matched no node",
    sources: sourceIds,
    sinks: [...sinkIds],
  };
  process.stdout.write(
    flags.has("--json")
      ? `${JSON.stringify(report, null, 2)}\n`
      : `${report.reason}\n`,
  );
  process.exit(0);
}

const paths = [];
let truncated = false;
let explored = 0;

const walk = (nodeId, path, edges, depth) => {
  if (paths.length >= maxPaths) {
    truncated = true;
    return;
  }
  explored += 1;
  if (depth > 0 && sinkIds.has(nodeId)) {
    paths.push({ nodes: [...path], edges: [...edges] });
    return;
  }
  if (depth >= maxHops) return;
  for (const edge of adjacency.get(nodeId) ?? []) {
    const next = edge.to;
    if (!nodes.has(next)) continue;
    if (sanitizerIds.has(next)) continue;
    if (path.includes(next)) continue;
    walk(
      next,
      [...path, next],
      [...edges, { from: edge.from, to: edge.to, label: edge.label ?? null }],
      depth + 1,
    );
  }
};

for (const sourceId of sourceIds) {
  if (sanitizerIds.has(sourceId)) continue;
  walk(sourceId, [sourceId], [], 0);
}

const report = {
  graph: graphPath,
  status: paths.length === 0 ? "no-path" : truncated ? "truncated" : "complete",
  source_selector: flag("source", "source"),
  sink_selector: flag("sink", "sink"),
  sanitizer_selectors: sanitizers,
  max_hops: maxHops,
  max_paths: maxPaths,
  sources: sourceIds,
  sinks: [...sinkIds].sort(),
  explored_nodes: explored,
  path_count: paths.length,
  truncated,
  paths: paths.map((path, index) => ({
    path_id: index + 1,
    hops: path.edges.length,
    node_ids: path.nodes,
    edges: path.edges,
    labels: path.nodes.map((id) => nodes.get(id)?.label ?? id),
  })),
  limitations: [
    truncated
      ? `Stopped after ${String(maxPaths)} paths; more paths may exist within the hop ceiling.`
      : "All simple paths within the hop and path ceilings were enumerated.",
    "Sanitizer nodes stop expansion; a sanitizer that only conditionally neutralises a value is treated as a barrier, so a reported path is a candidate, not proof.",
    "The graph's own coverage and provenance decide what this result means; this tool adds no observations.",
  ],
};

if (flags.has("--json")) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
  console.log(`status   ${report.status}`);
  console.log(`sources  ${report.sources.join(", ")}`);
  console.log(`sinks    ${report.sinks.join(", ")}`);
  console.log(
    `paths    ${String(report.path_count)} (explored ${String(explored)} nodes, max ${String(maxHops)} hops)`,
  );
  for (const path of report.paths)
    console.log(
      `  #${String(path.path_id)} ${String(path.hops)} hops: ${path.labels.join(" -> ")}`,
    );
  for (const limitation of report.limitations) console.log(`  ! ${limitation}`);
}
