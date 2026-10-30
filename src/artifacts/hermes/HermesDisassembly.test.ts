import { describe, expect, it } from "vitest";

import { disassembleHermes } from "./HermesDisassembly.js";
import { HERMES_HEADER_BYTES, HERMES_MAGIC } from "./HermesBytecodeHeader.js";
import { HERMES_OPCODES_V84 } from "./HermesOpcodes.js";

const opcode = (name: string): number => {
  const index = HERMES_OPCODES_V84.findIndex((entry) => entry.name === name);
  if (index < 0) throw new Error(`missing opcode ${name}`);
  return index;
};

const buildModule = (code: readonly number[], version = 84): Buffer => {
  const strings = ["a"];
  const storage = Buffer.from("a", "utf8");
  const functionHeader = Buffer.alloc(16);
  const functionHeaderCount = 1;
  const kinds = Buffer.alloc(4);
  kinds.writeUInt32LE(strings.length, 0);
  const stringTable = Buffer.alloc(4);
  stringTable.writeUInt32LE(1 << 24, 0);
  const bytecodeOffset =
    HERMES_HEADER_BYTES +
    functionHeaderCount * 16 +
    kinds.length +
    stringTable.length +
    storage.length;
  functionHeader.writeUInt32LE((bytecodeOffset & 0x1ffffff) | (0 << 25), 0);
  functionHeader.writeUInt32LE((code.length & 0x7fff) | (0 << 15), 4);
  functionHeader.writeUInt8(0, 15);
  const total = bytecodeOffset + code.length;
  const header = Buffer.alloc(HERMES_HEADER_BYTES);
  header.writeBigUInt64LE(HERMES_MAGIC, 0);
  header.writeUInt32LE(version, 8);
  header.writeUInt32LE(total, 32);
  header.writeUInt32LE(1, 40);
  header.writeUInt32LE(1, 44);
  header.writeUInt32LE(0, 48);
  header.writeUInt32LE(strings.length, 52);
  header.writeUInt32LE(0, 56);
  header.writeUInt32LE(storage.length, 60);
  return Buffer.concat([
    header,
    functionHeader,
    kinds,
    stringTable,
    storage,
    Buffer.from(code),
  ]);
};

describe("hermes disassembly", () => {
  it("decodes a small function and checks the body boundary", () => {
    const code = [opcode("LoadConstUInt8"), 1, 7, opcode("Ret"), 1];
    const result = disassembleHermes(buildModule(code));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.decodedFunctions).toBe(1);
    expect(result.value.functions[0]?.name).toBe("a");
    expect(result.value.functions[0]?.instructions).toEqual([
      {
        offset: expect.any(Number),
        opcode: code[0],
        name: "LoadConstUInt8",
        operands: [1, 7],
      },
      {
        offset: expect.any(Number),
        opcode: code[3],
        name: "Ret",
        operands: [1],
      },
    ]);
  });

  it("refuses a stream that runs past the body", () => {
    const code = [opcode("LoadConstUInt8"), 1];
    const result = disassembleHermes(buildModule(code));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.decodedFunctions).toBe(0);
    expect(result.value.functions[0]?.decoded).toBe(false);
    expect(result.value.functions[0]?.reason).toContain("operands run past");
  });

  it("refuses versions without an opcode table", () => {
    const result = disassembleHermes(buildModule([opcode("Ret"), 0], 96));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("unsupported-version");
  });
});
