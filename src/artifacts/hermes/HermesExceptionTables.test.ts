import { describe, expect, it } from "vitest";

import { HERMES_HEADER_BYTES, HERMES_MAGIC } from "./HermesBytecodeHeader.js";
import { readHermesExceptionTables } from "./HermesExceptionTables.js";

interface Handler {
  readonly start: number;
  readonly end: number;
  readonly target: number;
}

const buildModule = (options: {
  readonly handlerFlag: boolean;
  readonly handlers: readonly Handler[];
  readonly version?: number;
}): Buffer => {
  const version = options.version ?? 84;
  const storage = Buffer.from("a", "utf8");
  const functionHeader = Buffer.alloc(16);
  const kinds = Buffer.alloc(4);
  kinds.writeUInt32LE(1, 0);
  const stringTable = Buffer.alloc(4);
  stringTable.writeUInt32LE(1 << 24, 0);
  const bytecode = Buffer.from([0x6a, 1, 7, 0x58, 1, 0, 0, 0]);
  const bytecodeOffset =
    HERMES_HEADER_BYTES +
    16 +
    kinds.length +
    stringTable.length +
    storage.length;
  const tableOffset = Math.ceil((bytecodeOffset + bytecode.length) / 4) * 4;
  const table = Buffer.alloc(4 + options.handlers.length * 12);
  table.writeUInt32LE(options.handlers.length, 0);
  options.handlers.forEach((handler, index) => {
    const base = 4 + index * 12;
    table.writeUInt32LE(handler.start, base);
    table.writeUInt32LE(handler.end, base + 4);
    table.writeUInt32LE(handler.target, base + 8);
  });
  const padding = Buffer.alloc(
    tableOffset - (bytecodeOffset + bytecode.length),
  );
  functionHeader.writeUInt32LE(bytecodeOffset & 0x1ffffff, 0);
  functionHeader.writeUInt32LE(bytecode.length & 0x7fff, 4);
  functionHeader.writeUInt32LE(tableOffset & 0x1ffffff, 8);
  functionHeader.writeUInt8(options.handlerFlag ? 0x08 : 0, 15);
  const total = tableOffset + table.length;
  const header = Buffer.alloc(HERMES_HEADER_BYTES);
  header.writeBigUInt64LE(HERMES_MAGIC, 0);
  header.writeUInt32LE(version, 8);
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

describe("hermes exception tables", () => {
  it("reads an aligned handler table through infoOffset", () => {
    const result = readHermesExceptionTables(
      buildModule({
        handlerFlag: true,
        handlers: [{ start: 0, end: 5, target: 5 }],
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.parsedFunctions).toBe(1);
    const fn = result.value.functions[0];
    expect(fn?.status).toBe("parsed");
    expect(fn?.handlers).toEqual([{ start: 0, end: 5, target: 5 }]);
  });

  it("reports absent when the flag is clear", () => {
    const result = readHermesExceptionTables(
      buildModule({ handlerFlag: false, handlers: [] }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.functions[0]?.status).toBe("absent");
    expect(result.value.parsedFunctions).toBe(0);
  });

  it("refuses a handler that leaves the function body", () => {
    const result = readHermesExceptionTables(
      buildModule({
        handlerFlag: true,
        handlers: [{ start: 0, end: 99, target: 5 }],
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.functions[0]?.status).toBe("unknown");
    expect(result.value.functions[0]?.reason).toContain("outside the function");
    expect(result.value.unknownFunctions).toEqual([0]);
  });

  it("refuses versions other than 84", () => {
    const result = readHermesExceptionTables(
      buildModule({ handlerFlag: false, handlers: [], version: 96 }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("malformed");
  });
});
