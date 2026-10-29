import { describe, expect, it } from "vitest";

import {
  findHeapNodes,
  heapNodeCount,
  incomingReferenceCounts,
  summarizeHeap,
  type HeapSnapshotDocument,
} from "./HeapSnapshotQuery.js";

/**
 * Minimal but structurally faithful V8 heap snapshot: three nodes with a
 * fixed stride of seven fields, two edges from the first node, three strings.
 */
const snapshot: HeapSnapshotDocument = {
  snapshot: {
    meta: {
      node_fields: [
        "type",
        "name",
        "id",
        "self_size",
        "edge_count",
        "trace_node_id",
        "detachedness",
      ],
      node_types: [
        ["hidden", "array", "string", "object", "closure"],
        "string",
        "number",
        "number",
        "number",
        "number",
        "number",
      ],
      edge_fields: ["type", "name_or_index", "to_node"],
      edge_types: [
        ["context", "element", "property", "internal", "hidden"],
        "string_or_number",
        "node",
      ],
    },
    node_count: 3,
    edge_count: 2,
  },
  nodes: [3, 1, 1, 100, 2, 0, 0, 3, 1, 2, 50, 0, 0, 0, 4, 2, 3, 20, 0, 0, 0],
  edges: [2, 1, 7, 2, 2, 14],
  strings: ["", "Foo", "bar"],
};

describe("heap index", () => {
  it("counts nodes from the stride", () => {
    expect(heapNodeCount(snapshot)).toBe(3);
  });

  it("summarizes by name and type, largest total first", () => {
    const rows = summarizeHeap(snapshot, { minCount: 2 });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      name: "Foo",
      type: "object",
      count: 2,
      selfSize: 150,
      averageSize: 75,
      largestSize: 100,
    });
  });

  it("returns single instances when the minimum count allows it", () => {
    const rows = summarizeHeap(snapshot, { minCount: 1 });
    expect(rows.map((row) => row.name)).toEqual(["Foo", "bar"]);
  });
});

describe("node lookup", () => {
  it("finds instances by exact name, largest first", () => {
    const found = findHeapNodes(snapshot, "Foo");
    expect(found.map((node) => node.id)).toEqual([1, 2]);
    expect(found[0]?.selfSize).toBe(100);
  });

  it("returns nothing for an unknown name", () => {
    expect(findHeapNodes(snapshot, "Missing")).toEqual([]);
  });
});

describe("references", () => {
  it("counts incoming edges per node", () => {
    const counts = incomingReferenceCounts(snapshot);
    expect(counts.get(1)).toBe(1);
    expect(counts.get(2)).toBe(1);
    expect(counts.get(0)).toBeUndefined();
  });
});

describe("malformed input", () => {
  it("rejects a node array that does not match the stride", () => {
    expect(() =>
      heapNodeCount({
        ...snapshot,
        nodes: [3, 1, 1],
      }),
    ).toThrow(/not a multiple/u);
  });
});
