/**
 * Query a V8 heap snapshot without loading it into an inspector session.
 *
 * A `.heapsnapshot` file is a JSON document with three parallel arrays:
 * `nodes` (fixed-stride records), `edges` (fixed-stride records) and `strings`.
 * This module indexes those arrays and answers the questions an investigation
 * actually asks: what dominates memory, how many instances of a constructor
 * exist, and which nodes reference a given node.
 */
export interface HeapSnapshotDocument {
  readonly snapshot: {
    readonly meta: {
      readonly node_fields: readonly string[];
      readonly node_types: readonly (readonly string[] | string)[];
      readonly edge_fields: readonly string[];
      readonly edge_types: readonly (readonly string[] | string)[];
    };
    readonly node_count: number;
    readonly edge_count: number;
  };
  readonly nodes: readonly number[];
  readonly edges: readonly number[];
  readonly strings: readonly string[];
}

export interface HeapNode {
  readonly index: number;
  readonly type: string;
  readonly name: string;
  readonly id: number;
  readonly selfSize: number;
  readonly edgeCount: number;
}

export interface HeapSummaryRow {
  readonly name: string;
  readonly type: string;
  readonly count: number;
  readonly selfSize: number;
  readonly averageSize: number;
  readonly largestSize: number;
}

export interface HeapSummaryOptions {
  /** Only rows with at least this many instances. Defaults to 2. */
  readonly minCount?: number;
  /** Row limit after sorting by total size. Defaults to 25. */
  readonly limit?: number;
}

interface Index {
  readonly stride: number;
  readonly typeIndex: number;
  readonly nameIndex: number;
  readonly idIndex: number;
  readonly selfSizeIndex: number;
  readonly edgeCountIndex: number;
  readonly nodeTypes: readonly string[];
  readonly nodes: readonly number[];
  readonly strings: readonly string[];
}

const tableOf = (
  fields: readonly string[],
): { index: (name: string) => number; stride: number } => ({
  index: (name: string) => {
    const index = fields.indexOf(name);
    if (index < 0) throw new Error(`heap snapshot meta is missing "${name}"`);
    return index;
  },
  stride: fields.length,
});

const buildIndex = (document: HeapSnapshotDocument): Index => {
  const meta = document.snapshot.meta;
  const nodes = tableOf(meta.node_fields);
  const nodeTypes = Array.isArray(meta.node_types[0])
    ? (meta.node_types[0] as readonly string[])
    : [];
  if (document.nodes.length % nodes.stride !== 0)
    throw new Error(
      `heap snapshot nodes length ${String(document.nodes.length)} is not a multiple of ${String(nodes.stride)}`,
    );
  return {
    stride: nodes.stride,
    typeIndex: nodes.index("type"),
    nameIndex: nodes.index("name"),
    idIndex: nodes.index("id"),
    selfSizeIndex: nodes.index("self_size"),
    edgeCountIndex: nodes.index("edge_count"),
    nodeTypes,
    nodes: document.nodes,
    strings: document.strings,
  };
};

const nodeAt = (index: Index, ordinal: number): HeapNode => {
  const offset = ordinal * index.stride;
  const typeCode = index.nodes[offset + index.typeIndex] ?? 0;
  const nameCode = index.nodes[offset + index.nameIndex] ?? 0;
  return {
    index: ordinal,
    type: index.nodeTypes[typeCode] ?? "unknown",
    name: index.strings[nameCode] ?? "",
    id: index.nodes[offset + index.idIndex] ?? 0,
    selfSize: index.nodes[offset + index.selfSizeIndex] ?? 0,
    edgeCount: index.nodes[offset + index.edgeCountIndex] ?? 0,
  };
};

/** Number of nodes in the snapshot. */
export function heapNodeCount(document: HeapSnapshotDocument): number {
  const index = buildIndex(document);
  return index.nodes.length / index.stride;
}

/** Iterate every node in document order. */
export function* heapNodes(
  document: HeapSnapshotDocument,
): Generator<HeapNode> {
  const index = buildIndex(document);
  const count = index.nodes.length / index.stride;
  for (let ordinal = 0; ordinal < count; ordinal += 1)
    yield nodeAt(index, ordinal);
}

/** Aggregate nodes by name and type, largest total size first. */
export function summarizeHeap(
  document: HeapSnapshotDocument,
  options: HeapSummaryOptions = {},
): HeapSummaryRow[] {
  const minCount = options.minCount ?? 2;
  const limit = options.limit ?? 25;
  const groups = new Map<
    string,
    {
      name: string;
      type: string;
      count: number;
      selfSize: number;
      largestSize: number;
    }
  >();
  for (const node of heapNodes(document)) {
    const key = `${node.type}\u0000${node.name}`;
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, {
        name: node.name,
        type: node.type,
        count: 1,
        selfSize: node.selfSize,
        largestSize: node.selfSize,
      });
      continue;
    }
    group.count += 1;
    group.selfSize += node.selfSize;
    group.largestSize = Math.max(group.largestSize, node.selfSize);
  }
  return [...groups.values()]
    .filter((group) => group.count >= minCount)
    .map((group) => ({
      name: group.name,
      type: group.type,
      count: group.count,
      selfSize: group.selfSize,
      averageSize: Math.round(group.selfSize / group.count),
      largestSize: group.largestSize,
    }))
    .sort(
      (left, right) =>
        right.selfSize - left.selfSize || right.count - left.count,
    )
    .slice(0, limit);
}

/** Nodes with an exact name, largest first. */
export function findHeapNodes(
  document: HeapSnapshotDocument,
  name: string,
  limit = 20,
): HeapNode[] {
  const found: HeapNode[] = [];
  for (const node of heapNodes(document)) {
    if (node.name !== name) continue;
    found.push(node);
  }
  return found
    .sort((left, right) => right.selfSize - left.selfSize || left.id - right.id)
    .slice(0, limit);
}

/** Count incoming edges per node, i.e. how many references point at it. */
export function incomingReferenceCounts(
  document: HeapSnapshotDocument,
): ReadonlyMap<number, number> {
  const nodeFields = document.snapshot.meta.node_fields;
  const edgeFields = document.snapshot.meta.edge_fields;
  const nodeStride = nodeFields.length;
  const edgeStride = edgeFields.length;
  const toOffset = edgeFields.indexOf("to_node");
  if (toOffset < 0) throw new Error('heap snapshot meta is missing "to_node"');
  const counts = new Map<number, number>();
  for (
    let offset = 0;
    offset + toOffset < document.edges.length;
    offset += edgeStride
  ) {
    const targetNode = document.edges[offset + toOffset] ?? 0;
    const ordinal = targetNode / nodeStride;
    counts.set(ordinal, (counts.get(ordinal) ?? 0) + 1);
  }
  return counts;
}
