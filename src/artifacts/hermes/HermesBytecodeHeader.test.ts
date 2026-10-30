import { describe, expect, it } from "vitest";

import {
  HERMES_BYTECODE_MAGIC,
  HERMES_HEADER_BYTES,
  observeHermesBytecode,
  hermesVersionSupported,
} from "./HermesBytecodeHeader.js";

interface HeaderInput {
  readonly version?: number;
  readonly sourceHash?: number;
  readonly fileLength?: number;
  readonly globalCodeIndex?: number;
  readonly functionCount?: number;
  readonly stringKindCount?: number;
  readonly identifierCount?: number;
  readonly stringCount?: number;
  readonly overflowStringCount?: number;
  readonly stringStorageSize?: number;
  readonly magic?: number;
}

const buildHeader = (input: HeaderInput = {}): Buffer => {
  const buffer = Buffer.alloc(HERMES_HEADER_BYTES);
  buffer.writeUInt32LE(input.magic ?? HERMES_BYTECODE_MAGIC, 0);
  buffer.writeUInt32LE(input.version ?? 96, 4);
  buffer.fill(input.sourceHash ?? 0xab, 8, 28);
  buffer.writeUInt32LE(input.fileLength ?? 4_096, 28);
  buffer.writeUInt32LE(input.globalCodeIndex ?? 0, 32);
  buffer.writeUInt32LE(input.functionCount ?? 12, 36);
  buffer.writeUInt32LE(input.stringKindCount ?? 3, 40);
  buffer.writeUInt32LE(input.identifierCount ?? 40, 44);
  buffer.writeUInt32LE(input.stringCount ?? 900, 48);
  buffer.writeUInt32LE(input.overflowStringCount ?? 7, 52);
  buffer.writeUInt32LE(input.stringStorageSize ?? 8_192, 56);
  return buffer;
};

describe("hermes bytecode header", () => {
  it("reads the 60-byte prefix of a modern bundle", () => {
    const observation = observeHermesBytecode(buildHeader());
    expect(observation).toEqual({
      state: "parsed",
      facts: {
        version: 96,
        sourceHash: "ab".repeat(20),
        fileLength: 4_096,
        globalCodeIndex: 0,
        functionCount: 12,
        stringKindCount: 3,
        identifierCount: 40,
        stringCount: 900,
        overflowStringCount: 7,
        stringStorageSize: 8_192,
      },
    });
  });

  it("keeps older versions readable", () => {
    const observation = observeHermesBytecode(
      buildHeader({ version: 59, functionCount: 3 }),
    );
    expect(observation.state).toBe("parsed");
    if (observation.state !== "parsed") return;
    expect(observation.facts.version).toBe(59);
    expect(observation.facts.functionCount).toBe(3);
  });

  it("refuses a file with a different magic", () => {
    const bytes = buildHeader({ magic: 0x12345678 });
    expect(observeHermesBytecode(bytes)).toEqual({
      state: "not-hermes",
      leadingBytes: "78563412",
    });
  });

  it("reports a truncated prefix instead of guessing", () => {
    const bytes = buildHeader().subarray(0, HERMES_HEADER_BYTES - 1);
    expect(observeHermesBytecode(bytes)).toEqual({
      state: "truncated",
      availableBytes: HERMES_HEADER_BYTES - 1,
      neededBytes: HERMES_HEADER_BYTES,
    });
  });

  it("flags versions outside the known range", () => {
    const observation = observeHermesBytecode(buildHeader({ version: 200 }));
    expect(observation.state).toBe("parsed");
    if (observation.state !== "parsed") return;
    expect(hermesVersionSupported(observation.facts.version)).toBe(false);
    expect(hermesVersionSupported(96)).toBe(true);
  });
});
