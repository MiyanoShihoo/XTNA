import { describe, expect, it } from "vitest";

import {
  analyzeGlue,
  buildBridgeGraph,
  readWasmInterface,
} from "./WasmBridgeGraph.js";

const leb = (value: number): number[] => {
  const out: number[] = [];
  let current = value;
  do {
    let byte = current & 0x7f;
    current >>>= 7;
    if (current !== 0) byte |= 0x80;
    out.push(byte);
  } while (current !== 0);
  return out;
};

const name = (text: string): number[] => {
  const bytes = [...new TextEncoder().encode(text)];
  return [...leb(bytes.length), ...bytes];
};

const section = (id: number, payload: number[]): number[] => [
  id,
  ...leb(payload.length),
  ...payload,
];

/** Build the smallest module our reader needs: one import and two exports. */
const moduleBytes = (): Uint8Array => {
  const imports = [
    ...leb(1),
    ...name("env"),
    ...name("abort"),
    0x00,
    ...leb(0),
  ];
  const exports = [
    ...leb(2),
    ...name("add"),
    0x00,
    ...leb(0),
    ...name("memory"),
    0x02,
    ...leb(0),
  ];
  return new Uint8Array([
    0x00,
    0x61,
    0x73,
    0x6d,
    0x01,
    0x00,
    0x00,
    0x00,
    ...section(2, imports),
    ...section(7, exports),
  ]);
};

describe("wasm interface", () => {
  it("decodes import and export sections", () => {
    const wasm = readWasmInterface(moduleBytes());
    expect(wasm.imports).toEqual([
      { module: "env", name: "abort", kind: "function" },
    ]);
    expect(wasm.exports).toEqual([
      { name: "add", kind: "function" },
      { name: "memory", kind: "memory" },
    ]);
  });

  it("maps imported and defined function indices to export names", () => {
    const bytes = new Uint8Array([
      0x00,
      0x61,
      0x73,
      0x6d,
      0x01,
      0x00,
      0x00,
      0x00,
      ...section(2, [
        ...leb(1),
        ...name("env"),
        ...name("abort"),
        0x00,
        ...leb(0),
      ]),
      ...section(3, [...leb(1), ...leb(0)]),
      ...section(7, [...leb(1), ...name("run"), 0x00, ...leb(1)]),
    ]);
    expect(readWasmInterface(bytes).functions).toEqual([
      {
        index: 0,
        kind: "imported",
        typeIndex: 0,
        module: "env",
        name: "abort",
        exports: [],
      },
      {
        index: 1,
        kind: "defined",
        typeIndex: 0,
        module: null,
        name: null,
        exports: ["run"],
      },
    ]);
  });

  it("rejects a file without the wasm magic", () => {
    expect(() =>
      readWasmInterface(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])),
    ).toThrow(/bad magic/u);
  });
});

describe("glue analysis", () => {
  const glue = `
const imports = { env: { abort: abortImpl } };
const { instance } = await WebAssembly.instantiate(bytes, imports);
instance.exports.add(1, 2);
const memory = instance.exports.memory;
`;

  it("finds the import bindings and instantiation site", () => {
    const facts = analyzeGlue(glue);
    expect(facts.bindings).toEqual([
      { module: "env", name: "abort", provider: "abortImpl", line: 2 },
    ]);
    expect(facts.instantiationLine).toBe(3);
  });

  it("records export calls and plain export reads", () => {
    const facts = analyzeGlue(glue);
    expect(facts.exportCalls).toEqual(
      expect.arrayContaining([
        { name: "add", line: 4, invoked: true },
        { name: "memory", line: 5, invoked: false },
      ]),
    );
    expect(
      facts.exportCalls.filter((call) => call.name === "add"),
    ).toHaveLength(1);
  });
});

describe("bridge graph", () => {
  const wasm = readWasmInterface(moduleBytes());

  it("links JS calls to exports and wasm imports to JS providers", () => {
    const graph = buildBridgeGraph(
      wasm,
      analyzeGlue(`
const imports = { env: { abort: abortImpl } };
WebAssembly.instantiate(bytes, imports);
instance.exports.add(1, 2);
`),
    );
    expect(graph.jsToWasm).toEqual([{ from: "js", to: "add", line: 4 }]);
    expect(graph.wasmToJs).toEqual([
      { from: "abort", to: "abortImpl", line: 2 },
    ]);
    expect(graph.unresolvedImports).toEqual([]);
  });

  it("reports imports the glue never supplies", () => {
    const graph = buildBridgeGraph(
      wasm,
      analyzeGlue("WebAssembly.instantiate(bytes, {});"),
    );
    expect(graph.unresolvedImports).toEqual(["env.abort"]);
    expect(graph.wasmToJs).toEqual([]);
  });

  it("reports exports nothing reaches", () => {
    const graph = buildBridgeGraph(
      wasm,
      analyzeGlue(`
WebAssembly.instantiate(bytes, { env: { abort: abortImpl } });
instance.exports.add();
`),
    );
    expect(graph.unusedExports).toEqual(["memory"]);
  });
});
