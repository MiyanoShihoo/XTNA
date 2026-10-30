import { describe, expect, it } from "vitest";

import { HERMES_HEADER_BYTES, HERMES_MAGIC } from "./HermesBytecodeHeader.js";
import { readHermesTables } from "./HermesBytecodeTables.js";

interface FunctionSpec {
  readonly nameId: number;
  readonly paramCount: number;
  readonly bytecodeSize: number;
  readonly frameSize: number;
}

const buildModule = (
  strings: readonly string[],
  functions: readonly FunctionSpec[],
  version = 96,
): Buffer => {
  const storage: Buffer[] = [];
  const entries: number[] = [];
  let offset = 0;
  for (const text of strings) {
    const bytes = Buffer.from(text, "utf8");
    entries.push((offset << 1) | (bytes.length << 24));
    storage.push(bytes);
    offset += bytes.length;
  }
  const stringStorage = Buffer.concat(storage);
  const stride = version >= 89 ? 12 : 16;
  const functionHeaders = Buffer.alloc(functions.length * stride);
  functions.forEach((spec, index) => {
    const base = index * stride;
    if (stride === 16) {
      functionHeaders.writeUInt32LE(spec.paramCount << 25, base);
      functionHeaders.writeUInt32LE(
        (spec.bytecodeSize & 0x7fff) | (spec.nameId << 15),
        base + 4,
      );
      functionHeaders.writeUInt32LE(spec.frameSize << 25, base + 8);
      functionHeaders.writeUInt8(0, base + 15);
      return;
    }
    functionHeaders.writeUInt32LE(
      (0 & 0x1ffffff) | (spec.paramCount << 25),
      base,
    );
    functionHeaders.writeUInt32LE(
      (spec.bytecodeSize & 0x3fff) | ((spec.nameId & 0xff) << 14),
      base + 4,
    );
    functionHeaders.writeUInt8(spec.frameSize, base + 8);
  });
  const kinds = Buffer.alloc(4);
  kinds.writeUInt32LE(strings.length, 0);
  const stringTable = Buffer.alloc(strings.length * 4);
  entries.forEach((entry, index) =>
    stringTable.writeUInt32LE(entry, index * 4),
  );
  const total =
    HERMES_HEADER_BYTES +
    functionHeaders.length +
    kinds.length +
    stringTable.length +
    stringStorage.length;
  const header = Buffer.alloc(HERMES_HEADER_BYTES);
  header.writeBigUInt64LE(HERMES_MAGIC, 0);
  header.writeUInt32LE(version, 8);
  header.writeUInt32LE(total, 32);
  header.writeUInt32LE(functions.length, 40);
  header.writeUInt32LE(1, 44);
  header.writeUInt32LE(0, 48);
  header.writeUInt32LE(strings.length, 52);
  header.writeUInt32LE(0, 56);
  header.writeUInt32LE(stringStorage.length, 60);
  return Buffer.concat([
    header,
    functionHeaders,
    kinds,
    stringTable,
    stringStorage,
  ]);
};

describe("hermes string and function tables", () => {
  it("reads strings and resolves function names", () => {
    const bytes = buildModule(
      ["a", "z", "password", "console"],
      [
        { nameId: 0, paramCount: 1, bytecodeSize: 10, frameSize: 16 },
        { nameId: 1, paramCount: 0, bytecodeSize: 4, frameSize: 8 },
      ],
    );
    const tables = readHermesTables(bytes);
    expect(tables.ok).toBe(true);
    if (!tables.ok) return;
    expect(tables.value.strings.map((entry) => entry.value)).toEqual([
      "a",
      "z",
      "password",
      "console",
    ]);
    expect(tables.value.functions).toEqual([
      {
        index: 0,
        name: "a",
        nameStringId: 0,
        paramCount: 1,
        bytecodeSize: 10,
        bytecodeOffset: 0,
        frameSize: 16,
        overflowed: false,
      },
      {
        index: 1,
        name: "z",
        nameStringId: 1,
        paramCount: 0,
        bytecodeSize: 4,
        bytecodeOffset: 0,
        frameSize: 8,
        overflowed: false,
      },
    ]);
    expect(tables.value.truncated).toBe(false);
  });

  it("rejects a file that is not Hermes", () => {
    const tables = readHermesTables(Buffer.alloc(HERMES_HEADER_BYTES, 7));
    expect(tables.ok).toBe(false);
    if (tables.ok) return;
    expect(tables.error.code).toBe("not-hermes");
  });
});

describe("legacy function headers", () => {
  it("reads the 16-byte v84 layout", () => {
    const bytes = buildModule(
      ["a", "z"],
      [
        { nameId: 0, paramCount: 2, bytecodeSize: 12, frameSize: 0 },
        { nameId: 1, paramCount: 0, bytecodeSize: 6, frameSize: 0 },
      ],
      84,
    );
    const tables = readHermesTables(bytes);
    expect(tables.ok).toBe(true);
    if (!tables.ok) return;
    expect(tables.value.functions.map((entry) => entry.name)).toEqual([
      "a",
      "z",
    ]);
    expect(tables.value.functions[0]?.paramCount).toBe(2);
    expect(tables.value.functions[0]?.bytecodeSize).toBe(12);
  });
});
