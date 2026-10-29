import { describe, expect, it } from "vitest";

import type { JavaScriptApplicationGraph } from "./javascriptApplicationGraph.js";
import { traverseApplicationFeature } from "./javascriptFeatureTraversal.js";

/**
 * The traversal only reads node and edge identity, so the fixture supplies the
 * fields the algorithm uses. Full graph validation is covered elsewhere.
 */
const graphOf = (
  nodeIds: readonly string[],
  pairs: ReadonlyArray<readonly [string, string]>,
) =>
  ({
    nodes: nodeIds.map((nodeId) => ({ node_id: nodeId })),
    edges: pairs.map(([source, target]) => ({
      edge_id: `jag_edge_${source}_${target}`,
      source_node_id: source,
      target_node_id: target,
    })),
  }) as unknown as JavaScriptApplicationGraph;

const chain = graphOf(
  ["a", "b", "c", "d"],
  [
    ["a", "b"],
    ["b", "c"],
    ["c", "d"],
  ],
);

describe("traverseApplicationFeature hop ceiling", () => {
  it("returns the whole reachable component when no ceiling is set", () => {
    const traversal = traverseApplicationFeature(chain, ["a"], "outgoing");

    expect(traversal.nodes.map(({ node_id }) => node_id)).toEqual([
      "a",
      "b",
      "c",
      "d",
    ]);
    expect(traversal.truncated).toBe(false);
    expect(traversal.truncatedNodeIds).toEqual([]);
  });

  it("stops after max_hops edges and marks the boundary", () => {
    const traversal = traverseApplicationFeature(chain, ["a"], "outgoing", 2);

    expect(traversal.nodes.map(({ node_id }) => node_id)).toEqual([
      "a",
      "b",
      "c",
    ]);
    expect(traversal.truncated).toBe(true);
    expect(traversal.truncatedNodeIds).toEqual(["c"]);
  });

  it("keeps a boundary edge that reaches an already visible node", () => {
    // a -> b -> c and c -> a: the cycle closes inside the retained projection.
    const cyclic = graphOf(
      ["a", "b", "c"],
      [
        ["a", "b"],
        ["b", "c"],
        ["c", "a"],
      ],
    );
    const traversal = traverseApplicationFeature(cyclic, ["a"], "outgoing", 2);

    expect(traversal.truncated).toBe(false);
    expect(traversal.edges).toHaveLength(3);
  });

  it("reaches the seed from both directions under a ceiling", () => {
    const graph = graphOf(
      ["seed", "upstream", "downstream", "far"],
      [
        ["upstream", "seed"],
        ["seed", "downstream"],
        ["downstream", "far"],
      ],
    );

    const traversal = traverseApplicationFeature(graph, ["seed"], "both", 1);

    expect(traversal.nodes.map(({ node_id }) => node_id)).toEqual([
      "downstream",
      "seed",
      "upstream",
    ]);
    expect(traversal.truncated).toBe(true);
  });
});
