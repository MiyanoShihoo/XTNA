import type {
  ApplicationEdge,
  ApplicationNode,
} from "./javascriptApplicationGraphSchemas.js";
import type { JavaScriptApplicationGraph } from "./javascriptApplicationGraph.js";
import { compareUnicodeCodePoints } from "../unicodeCodePointOrder.js";

interface AdjacencyEntry {
  readonly edge: ApplicationEdge;
  readonly nextNodeId: string;
}

interface Predecessor {
  readonly previousNodeId: string;
  readonly edgeId: string;
}

/** Complete reachable graph projection plus the first deterministic path to each node. */
export interface ApplicationFeatureTraversal {
  readonly nodes: ApplicationNode[];
  readonly edges: ApplicationEdge[];
  readonly predecessors: ReadonlyMap<string, Predecessor>;
  /** True when a hop ceiling stopped expansion while reachable edges remained. */
  readonly truncated: boolean;
  /** Nodes whose outgoing edges were not followed because of the hop ceiling. */
  readonly truncatedNodeIds: readonly string[];
}

/** Traverse a JAG without treating edge inference as observed reachability. */
export const traverseApplicationFeature = (
  graph: JavaScriptApplicationGraph,
  seedNodeIds: readonly string[],
  direction: "outgoing" | "incoming" | "both",
  maxHops?: number,
): ApplicationFeatureTraversal => {
  const nodeById = new Map(graph.nodes.map((node) => [node.node_id, node]));
  const adjacency = buildAdjacency(graph.edges, direction);
  const visited = new Set(seedNodeIds);
  const retainedEdges = new Map<string, ApplicationEdge>();
  const predecessors = new Map<string, Predecessor>();
  const truncatedNodeIds: string[] = [];
  const queue: Array<{ readonly id: string; readonly depth: number }> =
    seedNodeIds.map((id) => ({ id, depth: 0 }));
  for (let offset = 0; offset < queue.length; offset += 1) {
    const current = queue[offset];
    if (current === undefined) continue;
    const entries = adjacency.get(current.id) ?? [];
    if (maxHops !== undefined && current.depth >= maxHops) {
      // Stop at the ceiling. Boundary edges that only reach already-visible
      // nodes stay, because dropping them would hide a known relationship.
      let truncated = false;
      for (const entry of entries) {
        if (visited.has(entry.nextNodeId)) {
          retainedEdges.set(entry.edge.edge_id, entry.edge);
        } else {
          truncated = true;
        }
      }
      if (truncated) truncatedNodeIds.push(current.id);
      continue;
    }
    for (const entry of entries) {
      retainedEdges.set(entry.edge.edge_id, entry.edge);
      if (visited.has(entry.nextNodeId)) continue;
      if (!nodeById.has(entry.nextNodeId)) continue;
      visited.add(entry.nextNodeId);
      predecessors.set(entry.nextNodeId, {
        previousNodeId: current.id,
        edgeId: entry.edge.edge_id,
      });
      queue.push({ id: entry.nextNodeId, depth: current.depth + 1 });
    }
  }
  return {
    nodes: [...visited]
      .map((nodeId) => nodeById.get(nodeId))
      .filter((node): node is ApplicationNode => node !== undefined)
      .sort((left, right) =>
        compareUnicodeCodePoints(left.node_id, right.node_id),
      ),
    edges: [...retainedEdges.values()].sort((left, right) =>
      compareUnicodeCodePoints(left.edge_id, right.edge_id),
    ),
    predecessors,
    truncated: truncatedNodeIds.length > 0,
    truncatedNodeIds: [...truncatedNodeIds].sort(compareUnicodeCodePoints),
  };
};

const buildAdjacency = (
  edges: readonly ApplicationEdge[],
  direction: "outgoing" | "incoming" | "both",
): ReadonlyMap<string, AdjacencyEntry[]> => {
  const adjacency = new Map<string, AdjacencyEntry[]>();
  for (const edge of edges) {
    if (direction !== "incoming")
      addAdjacency(adjacency, edge.source_node_id, {
        edge,
        nextNodeId: edge.target_node_id,
      });
    if (direction !== "outgoing")
      addAdjacency(adjacency, edge.target_node_id, {
        edge,
        nextNodeId: edge.source_node_id,
      });
  }
  for (const entries of adjacency.values())
    entries.sort((left, right) =>
      compareUnicodeCodePoints(
        `${left.edge.edge_id}\0${left.nextNodeId}`,
        `${right.edge.edge_id}\0${right.nextNodeId}`,
      ),
    );
  return adjacency;
};

const addAdjacency = (
  adjacency: Map<string, AdjacencyEntry[]>,
  nodeId: string,
  entry: AdjacencyEntry,
): void => {
  const entries = adjacency.get(nodeId);
  if (entries === undefined) adjacency.set(nodeId, [entry]);
  else entries.push(entry);
};
