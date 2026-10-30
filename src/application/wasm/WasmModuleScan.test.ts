import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { scanWasmDirectory } from "./WasmModuleScan.js";

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

const section = (id: number, body: number[]): number[] => [
  id,
  ...uleb(body.length),
  ...body,
];

const wasmModule = (): Buffer => {
  const bodies = [[0x10, 0x01], []];
  return Buffer.from([
    0x00,
    0x61,
    0x73,
    0x6d,
    0x01,
    0x00,
    0x00,
    0x00,
    ...section(1, [0x01, 0x60, 0x00, 0x00]),
    ...section(3, [0x02, 0x00, 0x00]),
    ...section(10, [
      0x02,
      ...bodies.flatMap((body) => [
        ...uleb(body.length + 2),
        0x00,
        ...body,
        0x0b,
      ]),
    ]),
  ]);
};

describe("wasm module scan", () => {
  it("finds modules by magic and skips other files", async () => {
    const root = await mkdtemp(join(tmpdir(), "xtna-wasm-scan-"));
    try {
      await writeFile(join(root, "a.wasm"), wasmModule());
      await writeFile(join(root, "renamed.bin"), wasmModule());
      await writeFile(join(root, "notes.txt"), "not a module");
      const report = await scanWasmDirectory(root);
      expect(report.modules).toHaveLength(2);
      expect(report.modules.map((module) => module.edges)).toEqual([1, 1]);
      expect(report.skippedNonWasm).toBe(1);
      expect(report.truncated).toBe(false);
      expect(report.limitations).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("walks nested directories", async () => {
    const root = await mkdtemp(join(tmpdir(), "xtna-wasm-scan-"));
    try {
      const nested = join(root, "a", "b");
      await mkdir(nested, { recursive: true });
      await writeFile(join(nested, "deep.wasm"), wasmModule());
      const report = await scanWasmDirectory(root);
      expect(report.modules.map((module) => module.path)).toEqual([
        join(nested, "deep.wasm"),
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("stops at the file cap and says so", async () => {
    const root = await mkdtemp(join(tmpdir(), "xtna-wasm-scan-"));
    try {
      await writeFile(join(root, "a.wasm"), wasmModule());
      await writeFile(join(root, "b.wasm"), wasmModule());
      const report = await scanWasmDirectory(root, { maxFiles: 1 });
      expect(report.modules).toHaveLength(1);
      expect(report.truncated).toBe(true);
      expect(report.limitations.join(" ")).toContain("Stopped after 1 files");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("skips a module above the per-file byte cap", async () => {
    const root = await mkdtemp(join(tmpdir(), "xtna-wasm-scan-"));
    try {
      await writeFile(join(root, "big.wasm"), wasmModule());
      const report = await scanWasmDirectory(root, { maxModuleBytes: 8 });
      expect(report.modules).toEqual([]);
      expect(report.limitations.join(" ")).toContain("per-file cap");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
