import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { expect, it } from "vitest";

const run = promisify(execFile);
const script = fileURLToPath(
  new URL("../../scripts/hermes-inspect.mjs", import.meta.url),
);
const cacheRoot = fileURLToPath(new URL("../../.cache", import.meta.url));

const MAGIC = 0x1f1903c103bc1fc6n;
const HEADER = 128;

const moduleWithHandler = (): Buffer => {
  const storage = Buffer.from("a", "utf8");
  const functionHeader = Buffer.alloc(16);
  const kinds = Buffer.alloc(4);
  kinds.writeUInt32LE(1, 0);
  const stringTable = Buffer.alloc(4);
  stringTable.writeUInt32LE(1 << 24, 0);
  const bytecode = Buffer.from([0x6a, 1, 7, 0x58, 1, 0, 0, 0]);
  const bytecodeOffset = HEADER + 16 + 4 + 4 + storage.length;
  const tableOffset = Math.ceil((bytecodeOffset + bytecode.length) / 4) * 4;
  const table = Buffer.alloc(16);
  table.writeUInt32LE(1, 0);
  table.writeUInt32LE(0, 4);
  table.writeUInt32LE(5, 8);
  table.writeUInt32LE(5, 12);
  const padding = Buffer.alloc(
    tableOffset - (bytecodeOffset + bytecode.length),
  );
  functionHeader.writeUInt32LE(bytecodeOffset & 0x1ffffff, 0);
  functionHeader.writeUInt32LE(bytecode.length & 0x7fff, 4);
  functionHeader.writeUInt32LE(tableOffset & 0x1ffffff, 8);
  functionHeader.writeUInt8(0x08, 15);
  const total = tableOffset + table.length;
  const header = Buffer.alloc(HEADER);
  header.writeBigUInt64LE(MAGIC, 0);
  header.writeUInt32LE(84, 8);
  header.writeUInt32LE(total, 32);
  header.writeUInt32LE(1, 40);
  header.writeUInt32LE(1, 44);
  header.writeUInt32LE(0, 48);
  header.writeUInt32LE(1, 52);
  header.writeUInt32LE(0, 56);
  header.writeUInt32LE(storage.length, 60);
  return Buffer.concat([
    header,
    functionHeader,
    kinds,
    stringTable,
    storage,
    bytecode,
    padding,
    table,
  ]);
};

it("reports a parsed exception table with --exceptions", async () => {
  const root = await mkdtemp(join(cacheRoot, "hermes-exceptions-"));
  const bundle = join(root, "index.android.bundle");
  await writeFile(bundle, moduleWithHandler());
  try {
    const text = await run(
      process.execPath,
      [script, "--in", bundle, "--exceptions"],
      { env: process.env },
    );
    expect(text.stdout).toContain("exception tables: 1 parsed, 0 unknown");
    expect(text.stdout).toContain("[0,5) -> 5");

    const json = await run(
      process.execPath,
      [script, "--in", bundle, "--exceptions", "--json"],
      { env: process.env },
    );
    const report = JSON.parse(json.stdout) as {
      exceptions: {
        parsedFunctions: number;
        functions: { status: string; handlers: unknown[] }[];
      };
    };
    expect(report.exceptions.parsedFunctions).toBe(1);
    expect(report.exceptions.functions[0]?.handlers).toEqual([
      { start: 0, end: 5, target: 5 },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5 });
  }
});
