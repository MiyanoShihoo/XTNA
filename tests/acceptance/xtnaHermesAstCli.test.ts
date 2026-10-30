import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { expect, it } from "vitest";

import { HERMES_OPCODES_V84 } from "../../src/artifacts/hermes/HermesOpcodes.js";

const run = promisify(execFile);
const script = fileURLToPath(
  new URL("../../scripts/hermes-inspect.mjs", import.meta.url),
);

const MAGIC = 0x1f1903c103bc1fc6n;
const HEADER = 128;

const opcode = (name: string): number => {
  const index = HERMES_OPCODES_V84.findIndex((entry) => entry.name === name);
  if (index < 0) throw new Error(`missing opcode ${name}`);
  return index;
};

/** One function whose body loads 7 into r0 and returns it. */
const moduleWithBody = (): Buffer => {
  const strings = ["a"];
  const storage = Buffer.from("a", "utf8");
  const code = Buffer.from([opcode("LoadConstUInt8"), 0, 7, opcode("Ret"), 0]);
  const functions = Buffer.alloc(16);
  const kinds = Buffer.alloc(4);
  kinds.writeUInt32LE(1, 0);
  const table = Buffer.alloc(4);
  table.writeUInt32LE(1 << 24, 0);
  const bytecodeOffset =
    HEADER + functions.length + kinds.length + table.length + storage.length;
  functions.writeUInt32LE(bytecodeOffset & 0x1ffffff, 0);
  functions.writeUInt32LE(code.length & 0x7fff, 4);
  functions.writeUInt8(0, 15);
  const total = bytecodeOffset + code.length;
  const header = Buffer.alloc(HEADER);
  header.writeBigUInt64LE(MAGIC, 0);
  header.writeUInt32LE(84, 8);
  header.writeUInt32LE(total, 32);
  header.writeUInt32LE(1, 40);
  header.writeUInt32LE(1, 44);
  header.writeUInt32LE(0, 48);
  header.writeUInt32LE(strings.length, 52);
  header.writeUInt32LE(0, 56);
  header.writeUInt32LE(storage.length, 60);
  return Buffer.concat([header, functions, kinds, table, storage, code]);
};

it("prints recovered statements with --ast", async () => {
  const root = await mkdtemp(join(tmpdir(), "rea-hermes-ast-"));
  const bundle = join(root, "index.android.bundle");
  await writeFile(bundle, moduleWithBody());
  try {
    const text = await run(
      process.execPath,
      [script, "--in", bundle, "--ast"],
      {
        env: process.env,
      },
    );
    expect(text.stdout).toContain("ast: 1/1 functions structured");
    expect(text.stdout).toContain("return 7;");
    expect(text.stdout).toContain(
      "no try/catch, switch or cross-block data flow",
    );

    const json = await run(
      process.execPath,
      [script, "--in", bundle, "--ast", "--json"],
      { env: process.env },
    );
    const report = JSON.parse(json.stdout) as {
      ast: {
        structuredFunctions: number;
        functions: { statements: string[] }[];
      };
    };
    expect(report.ast.structuredFunctions).toBe(1);
    expect(report.ast.functions[0]?.statements.join("\n")).toContain(
      "return 7;",
    );
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5 });
  }
});
