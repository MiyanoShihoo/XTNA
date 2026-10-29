#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { queryPropertyGraph } from "../dist/domain/investigation/PropertyGraph.js";

const args = process.argv.slice(2);
const flag = (name, fallback) =>
  args.indexOf(`--${name}`) >= 0
    ? args[args.indexOf(`--${name}`) + 1]
    : fallback;
const graphPath = flag("graph");
if (graphPath === undefined) {
  process.stderr.write(
    "usage: node scripts/taint-path.mjs --graph g.json --source <sel> --sink <sel> [--sanitizer <sel>]... [--max-hops 5] [--max-paths 20] [--max-visited 20000] [--json]\n",
  );
  process.exit(2);
}
const maxHops = Number(flag("max-hops", "5"));
const maxPaths = Number(flag("max-paths", "20"));
const maxVisited = Number(flag("max-visited", "20000"));
const sanitizers = args.flatMap((value, index) =>
  value === "--sanitizer" && args[index + 1] !== undefined
    ? [args[index + 1]]
    : [],
);
const graph = JSON.parse(
  (await readFile(resolve(graphPath), "utf8")).replace(/^\uFEFF/u, ""),
);
const result = queryPropertyGraph({
  graph,
  from: flag("source", "source"),
  to: flag("sink", "sink"),
  maxHops,
  maxPaths,
  maxVisited,
  sanitizers,
});
const report = {
  graph: graphPath,
  status:
    result.missingNodes.length > 0
      ? "no-match"
      : result.paths.length === 0
        ? "no-path"
        : result.status,
  source_selector: flag("source", "source"),
  sink_selector: flag("sink", "sink"),
  sanitizer_selectors: sanitizers,
  max_hops: maxHops,
  max_paths: maxPaths,
  max_visited: maxVisited,
  explored_nodes: result.visited,
  path_count: result.paths.length,
  truncated: result.status === "truncated",
  paths: result.paths.map((path, index) => ({
    path_id: index + 1,
    hops: path.edges.length,
    node_ids: path.nodes,
    edges: path.edges,
  })),
  missing_nodes: result.missingNodes,
  limitations: result.limitations,
};
if (args.includes("--json"))
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
else {
  console.log(`status   ${report.status}`);
  console.log(
    `paths    ${report.path_count} (explored ${report.explored_nodes} nodes)`,
  );
  for (const path of report.paths)
    console.log(
      `  #${path.path_id} ${path.hops} hops: ${path.node_ids.join(" -> ")}`,
    );
  for (const limitation of report.limitations) console.log(`  ! ${limitation}`);
}
