export interface PropertyNode {
  readonly id: string;
  readonly kind: string;
  readonly label?: string;
  readonly evidenceIds?: readonly string[];
  readonly properties?: Readonly<
    Record<string, string | number | boolean | null>
  >;
}

export interface PropertyEdge {
  readonly from: string;
  readonly to: string;
  readonly kind?: string;
  readonly evidenceIds?: readonly string[];
}

export interface PropertyGraph {
  readonly nodes: readonly PropertyNode[];
  readonly edges: readonly PropertyEdge[];
}

export interface PropertyPath {
  readonly nodes: readonly string[];
  readonly edges: readonly PropertyEdge[];
}

export interface PropertyGraphQuery {
  readonly graph: PropertyGraph;
  readonly from: string;
  readonly to: string;
  readonly direction?: "forward" | "backward";
  readonly maxHops?: number;
  readonly maxPaths?: number;
  readonly maxVisited?: number;
  readonly sanitizers?: readonly string[];
}

export interface PropertyGraphResult {
  readonly status: "complete" | "truncated" | "invalid";
  readonly paths: readonly PropertyPath[];
  readonly visited: number;
  readonly missingNodes: readonly string[];
  readonly limitations: readonly string[];
}

const matches = (node: PropertyNode, selector: string): boolean =>
  node.id === selector || node.kind === selector || node.label === selector;

export const queryPropertyGraph = ({
  graph,
  from,
  to,
  direction = "forward",
  maxHops = 8,
  maxPaths = 100,
  maxVisited = 20_000,
  sanitizers = [],
}: PropertyGraphQuery): PropertyGraphResult => {
  const missingNodes: string[] = [];
  const limitations: string[] = [];
  const nodes = new Map<string, PropertyNode>();
  for (const node of graph.nodes) {
    if (nodes.has(node.id)) {
      missingNodes.push(node.id);
      limitations.push(`Duplicate node identity: ${node.id}`);
    } else nodes.set(node.id, node);
  }
  const sources = [...nodes.values()]
    .filter((node) => matches(node, from))
    .map(({ id }) => id)
    .sort();
  const targets = new Set(
    [...nodes.values()].filter((node) => matches(node, to)).map(({ id }) => id),
  );
  if (sources.length === 0) missingNodes.push(from);
  if (targets.size === 0) missingNodes.push(to);
  const blocked = new Set(
    [...nodes.values()]
      .filter((node) => sanitizers.some((selector) => matches(node, selector)))
      .map(({ id }) => id),
  );
  const adjacency = new Map<string, PropertyEdge[]>();
  for (const edge of graph.edges) {
    if (!nodes.has(edge.from) || !nodes.has(edge.to)) {
      limitations.push(`Unresolved edge: ${edge.from} -> ${edge.to}`);
      continue;
    }
    const oriented =
      direction === "forward"
        ? edge
        : { ...edge, from: edge.to, to: edge.from };
    const outgoing = adjacency.get(oriented.from) ?? [];
    outgoing.push(oriented);
    adjacency.set(oriented.from, outgoing);
  }
  for (const edges of adjacency.values())
    edges.sort(
      (a, b) => a.to.localeCompare(b.to) || a.from.localeCompare(b.from),
    );
  if (
    !Number.isInteger(maxHops) ||
    maxHops < 0 ||
    !Number.isInteger(maxPaths) ||
    maxPaths < 1 ||
    !Number.isInteger(maxVisited) ||
    maxVisited < 1
  )
    return {
      status: "invalid",
      paths: [],
      visited: 0,
      missingNodes,
      limitations: [
        ...limitations,
        "Bounds must be non-negative integers; path and visit budgets must be positive.",
      ],
    };
  const paths: PropertyPath[] = [];
  let visited = 0;
  let truncated = false;
  const walk = (id: string, path: string[], edges: PropertyEdge[]): void => {
    if (paths.length >= maxPaths || visited >= maxVisited) {
      truncated = true;
      return;
    }
    if (targets.has(id) && edges.length > 0) {
      paths.push({ nodes: path, edges });
      return;
    }
    if (edges.length >= maxHops || blocked.has(id)) return;
    visited += 1;
    for (const edge of adjacency.get(id) ?? []) {
      if (blocked.has(edge.to) || path.includes(edge.to)) continue;
      walk(edge.to, [...path, edge.to], [...edges, edge]);
      if (truncated) return;
    }
  };
  for (const source of sources) {
    walk(source, [source], []);
    if (truncated) break;
  }
  if (truncated)
    limitations.push(
      "Path or visit budget reached; unenumerated paths remain unknown.",
    );
  limitations.push(
    "Paths are candidates derived from the supplied graph, not proof of runtime reachability.",
  );
  return {
    status: truncated ? "truncated" : "complete",
    paths,
    visited,
    missingNodes,
    limitations,
  };
};
