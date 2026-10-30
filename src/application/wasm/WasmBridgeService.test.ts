import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it } from "vitest";

import { wasmBridgeResultSchema } from "../../contracts/wasm/wasmBridgeContracts.js";
import { inspectWasmBridge } from "./WasmBridgeService.js";

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
const moduleBytes = (): Uint8Array =>
  new Uint8Array([
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
    ...section(7, [
      ...leb(2),
      ...name("add"),
      0x00,
      ...leb(0),
      ...name("memory"),
      0x02,
      ...leb(0),
    ]),
  ]);

it("reads a local wasm/glue pair and returns an Evidence-backed bridge", async () => {
  const root = await mkdtemp(join(tmpdir(), "rea-wasm-bridge-"));
  const wasmPath = join(root, "module.wasm");
  const jsPath = join(root, "module.js");
  await writeFile(wasmPath, moduleBytes());
  await writeFile(
    jsPath,
    `const imports = { env: { abort: abortImpl } };
const { instance } = await WebAssembly.instantiate(bytes, imports);
instance.exports.add(1, 2);
`,
  );
  try {
    const result = await inspectWasmBridge({
      wasm_path: wasmPath,
      js_path: jsPath,
    });
    if (!result.ok) throw result.error;
    const report = wasmBridgeResultSchema.parse(result.value.normalized_result);
    expect(report.wasm.bytes).toBeGreaterThan(8);
    expect(report.imports).toEqual([
      { module: "env", name: "abort", kind: "function" },
    ]);
    expect(report.exports).toEqual([
      { name: "add", kind: "function" },
      { name: "memory", kind: "memory" },
    ]);
    expect(report.functions).toEqual([
      {
        index: 0,
        kind: "imported",
        type_index: 0,
        module: "env",
        name: "abort",
        exports: ["add"],
      },
    ]);
    expect(report.js_to_wasm).toEqual(
      expect.arrayContaining([{ from: "js", to: "add", line: 3 }]),
    );
    expect(report.wasm_to_js).toEqual(
      expect.arrayContaining([{ from: "abort", to: "abortImpl", line: 1 }]),
    );
  } finally {
    await rm(root, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 20,
    });
  }
});
