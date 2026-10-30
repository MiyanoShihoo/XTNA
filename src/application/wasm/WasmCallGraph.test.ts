import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { readWasmCallGraph } from "./WasmCallGraph.js";

const uleb = (value: number): number[] => {
  const bytes: number[] = [];
  let rest = value;
  do {
    let byte = rest & 0x7f;
    rest >>>= 7;
    if (rest !== 0) byte |= 0x80;
    bytes.push(byte);
  } while (rest !== 0);
  return bytes;
};

const vec = (items: number[][]): number[] => [
  ...uleb(items.length),
  ...items.flat(),
];

const section = (id: number, body: number[]): number[] => [
  id,
  ...uleb(body.length),
  ...body,
];

const moduleWithBodies = (bodies: number[][]): Uint8Array =>
  Uint8Array.from([
    0x00,
    0x61,
    0x73,
    0x6d,
    0x01,
    0x00,
    0x00,
    0x00,
    ...section(1, [0x01, 0x60, 0x00, 0x00]),
    ...section(3, vec(bodies.map(() => [0x00]))),
    ...section(
      10,
      vec(bodies.map((body) => [...uleb(body.length + 1), 0x00, ...body])),
    ),
  ]);

const body = (instructions: number[]): number[] => [...instructions, 0x0b];

describe("wasm call graph", () => {
  it("reads direct call edges from function bodies", () => {
    const bytes = moduleWithBodies([
      body([0x10, 0x01, 0x10, 0x02]),
      body([0x10, 0x02]),
      body([]),
    ]);
    const graph = readWasmCallGraph(bytes);
    expect(graph.ok).toBe(true);
    if (!graph.ok) return;
    expect(graph.value.functions.map((fact) => fact.index)).toEqual([0, 1, 2]);
    expect(graph.value.edges).toEqual([
      { from: 0, to: 1, kind: "direct" },
      { from: 0, to: 2, kind: "direct" },
      { from: 1, to: 2, kind: "direct" },
    ]);
    expect(graph.value.undecodedFunctions).toEqual([]);
    expect(graph.value.functions[0]?.callSites).toBe(2);
  });

  it("records call_indirect without inventing a target", () => {
    const bytes = moduleWithBodies([
      body([0x41, 0x00, 0x11, 0x00, 0x00]),
      body([]),
    ]);
    const graph = readWasmCallGraph(bytes);
    expect(graph.ok).toBe(true);
    if (!graph.ok) return;
    expect(graph.value.edges).toEqual([
      { from: 0, to: null, kind: "indirect", typeIndex: 0 },
    ]);
  });

  it("decodes SIMD instructions with their immediates", () => {
    const constV128 = [0xfd, 0x0c, ...new Array<number>(16).fill(0)];
    const lane = [0xfd, 0x15, 0x00];
    const bytes = moduleWithBodies([
      body([...constV128, ...lane, 0x10, 0x01]),
      body([]),
    ]);
    const graph = readWasmCallGraph(bytes);
    expect(graph.ok).toBe(true);
    if (!graph.ok) return;
    expect(graph.value.undecodedFunctions).toEqual([]);
    expect(graph.value.edges).toEqual([{ from: 0, to: 1, kind: "direct" }]);
  });

  it("marks a function undecoded when an unknown opcode stops the decoder", () => {
    const bytes = moduleWithBodies([body([0x10, 0x01, 0xfe, 0x00]), body([])]);
    const graph = readWasmCallGraph(bytes);
    expect(graph.ok).toBe(true);
    if (!graph.ok) return;
    expect(graph.value.undecodedFunctions).toEqual([0]);
    expect(graph.value.functions[0]?.undecoded).toBe(true);
    expect(graph.value.functions[0]?.undecodedAt).toBe("0xfe/0");
    expect(graph.value.edges).toHaveLength(1);
  });

  it("rejects a file that is not wasm", () => {
    const result = readWasmCallGraph(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("not-wasm");
  });

  it("reads a real module without inventing edges", () => {
    const path = join(
      process.cwd(),
      "node_modules",
      "source-map",
      "lib",
      "mappings.wasm",
    );
    const graph = readWasmCallGraph(readFileSync(path));
    expect(graph.ok).toBe(true);
    if (!graph.ok) return;
    expect(graph.value.functions.length).toBeGreaterThan(10);
    for (const edge of graph.value.edges) {
      expect(edge.from).toBeGreaterThanOrEqual(0);
      expect(edge.to === null || edge.to >= 0).toBe(true);
    }
  });
});

describe("simd coverage", () => {
  it("fully decodes a SIMD-heavy real module", () => {
    const path = join(
      process.cwd(),
      "node_modules",
      "playwright-core",
      "lib",
      "webp_codec.wasm",
    );
    const graph = readWasmCallGraph(readFileSync(path));
    expect(graph.ok).toBe(true);
    if (!graph.ok) return;
    expect(graph.value.functions.length).toBeGreaterThan(600);
    expect(graph.value.undecodedFunctions).toEqual([]);
    expect(graph.value.edges.length).toBeGreaterThan(2_000);
  });
});
