import { describe, expect, it } from "vitest";

import { buildHermesAst, renderHermesStatement } from "./HermesAst.js";
import { disassembleHermes } from "./HermesDisassembly.js";
import { readHermesExceptionTables } from "./HermesExceptionTables.js";
import { HERMES_HEADER_BYTES, HERMES_MAGIC } from "./HermesBytecodeHeader.js";
import { HERMES_OPCODES_V84 } from "./HermesOpcodes.js";

const opcode = (name: string): number => {
  const index = HERMES_OPCODES_V84.findIndex((entry) => entry.name === name);
  if (index < 0) throw new Error(`missing opcode ${name}`);
  return index;
};

const moduleWithTry = (): Buffer => {
  const storage = Buffer.from("a", "utf8");
  const functionHeader = Buffer.alloc(16);
  const kinds = Buffer.alloc(4);
  kinds.writeUInt32LE(1, 0);
  const stringTable = Buffer.alloc(4);
  stringTable.writeUInt32LE(1 << 24, 0);
  // protected: LoadConstUInt8 r0,7 ; Throw r0
  // handler:   Catch r1 ; Ret r1
  const bytecode = Buffer.from([
    opcode("LoadConstUInt8"),
    0,
    7,
    opcode("Throw"),
    0,
    opcode("Catch"),
    1,
    opcode("Ret"),
    1,
  ]);
  const bytecodeOffset = HERMES_HEADER_BYTES + 16 + 4 + 4 + storage.length;
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
  const header = Buffer.alloc(HERMES_HEADER_BYTES);
  header.writeBigUInt64LE(HERMES_MAGIC, 0);
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

describe("hermes try/catch structuring", () => {
  it("wraps the protected range and parses the handler arm", () => {
    const module = moduleWithTry();
    const bytes = new Uint8Array(module);
    const disassembly = disassembleHermes(bytes);
    expect(disassembly.ok).toBe(true);
    if (!disassembly.ok) return;
    const exceptions = readHermesExceptionTables(bytes);
    expect(exceptions.ok).toBe(true);
    if (!exceptions.ok) return;
    const ast = buildHermesAst(disassembly.value, bytes, exceptions.value);
    const fn = ast.functions[0];
    const statement = fn?.statements.find((entry) => entry.kind === "try");
    expect(statement?.kind).toBe("try");
    if (statement?.kind !== "try") return;
    expect(renderHermesStatement(statement)).toContain("try {");
    expect(renderHermesStatement(statement)).toContain("throw 7;");
    expect(renderHermesStatement(statement)).toContain("} catch {");
    // The caught value is carried by `Catch`, which the expression layer names.
    expect(renderHermesStatement(statement)).toContain("return <Catch 1>;");
    expect(fn?.structured).toBe(true);
    expect(fn?.limitations.join(" ")).toContain("try/catch recovered");
  });
});
