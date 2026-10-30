import { describe, expect, it } from "vitest";
import { queryPropertyGraph } from "./PropertyGraph.js";

const graph = {
  nodes: [
    { id: "a", kind: "source", evidenceIds: ["ev_a"] },
    { id: "b", kind: "flow" },
    { id: "clean", kind: "sanitizer" },
    { id: "c", kind: "sink" },
  ],
  edges: [
    { from: "a", to: "b", kind: "calls", evidenceIds: ["ev_ab"] },
    { from: "b", to: "c", kind: "writes" },
    { from: "a", to: "clean" },
    { from: "clean", to: "c" },
  ],
};

describe("property graph queries", () => {
  it("enumerates simple source-to-sink paths with provenance", () => {
    const result = queryPropertyGraph({
      graph,
      from: "source",
      to: "sink",
      sanitizers: ["sanitizer"],
    });
    expect(result.status).toBe("complete");
    expect(result.paths).toHaveLength(1);
    expect(result.paths[0]?.nodes).toEqual(["a", "b", "c"]);
    expect(result.paths[0]?.edges[0]?.evidenceIds).toEqual(["ev_ab"]);
  });

  it("supports reverse dependency traversal", () => {
    const result = queryPropertyGraph({
      graph,
      from: "sink",
      to: "source",
      direction: "backward",
    });
    expect(result.paths[0]?.nodes).toEqual(["c", "b", "a"]);
  });

  it("reports a bound instead of claiming exhaustive results", () => {
    const result = queryPropertyGraph({
      graph,
      from: "source",
      to: "sink",
      maxHops: 1,
    });
    expect(result.paths).toEqual([]);
    expect(result.limitations.join(" ")).toContain("not proof");
  });

  it("does not silently ignore unknown selectors or edges", () => {
    const result = queryPropertyGraph({
      graph: { nodes: [], edges: [{ from: "a", to: "b" }] },
      from: "a",
      to: "b",
    });
    expect(result.missingNodes).toEqual(["a", "b"]);
    expect(result.limitations.join(" ")).toContain("Unresolved edge");
  });
});
