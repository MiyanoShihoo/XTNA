import { describe, expect, it } from "vitest";

import {
  HERMES_DELTA_MAGIC,
  HERMES_HEADER_BYTES,
  HERMES_MAGIC,
  hermesVersionSupported,
  observeHermesBytecode,
} from "./HermesBytecodeHeader.js";

interface HeaderInput {
  readonly version?: number;
  readonly magic?: bigint;
  readonly fileLength?: number;
  readonly functionCount?: number;
  readonly stringCount?: number;
  readonly stringStorageSize?: number;
  readonly segmentID?: number;
}

const buildHeader = (input: HeaderInput = {}): Buffer => {
  const buffer = Buffer.alloc(HERMES_HEADER_BYTES);
  buffer.writeBigUInt64LE(input.magic ?? HERMES_MAGIC, 0);
  buffer.writeUInt32LE(input.version ?? 96, 8);
  buffer.fill(0xab, 12, 32);
  buffer.writeUInt32LE(input.fileLength ?? 4_096, 32);
  buffer.writeUInt32LE(0, 36);
  buffer.writeUInt32LE(input.functionCount ?? 12, 40);
  buffer.writeUInt32LE(3, 44);
  buffer.writeUInt32LE(40, 48);
  buffer.writeUInt32LE(input.stringCount ?? 900, 52);
  buffer.writeUInt32LE(7, 56);
  buffer.writeUInt32LE(input.stringStorageSize ?? 8_192, 60);
  buffer.writeUInt32LE(2, 64);
  buffer.writeUInt32LE(72, 72);
  buffer.writeUInt32LE(80, 80);
  buffer.writeUInt32LE(84, 84);
  buffer.writeUInt32LE(88, 88);
  buffer.writeUInt32LE(input.segmentID ?? 0, 96);
  buffer.writeUInt32LE(4, 100);
  buffer.writeUInt32LE(5, 104);
  buffer.writeUInt32LE(6, 108);
  return buffer;
};

describe("hermes bytecode header", () => {
  it("reads the 128-byte header of a modern bundle", () => {
    const observation = observeHermesBytecode(buildHeader());
    expect(observation.state).toBe("parsed");
    if (observation.state !== "parsed") return;
    expect(observation.facts).toEqual({
      version: 96,
      form: "execution",
      sourceHash: "ab".repeat(20),
      fileLength: 4_096,
      globalCodeIndex: 0,
      functionCount: 12,
      stringKindCount: 3,
      identifierCount: 40,
      stringCount: 900,
      overflowStringCount: 7,
      stringStorageSize: 8_192,
      bigIntCount: 2,
      regExpCount: 72,
      literalValueBufferSize: 80,
      objKeyBufferSize: 84,
      objShapeTableCount: 88,
      segmentID: 0,
      cjsModuleCount: 4,
      functionSourceCount: 5,
      debugInfoOffset: 6,
    });
  });

  it("keeps older versions readable", () => {
    const observation = observeHermesBytecode(buildHeader({ version: 59 }));
    expect(observation.state).toBe("parsed");
    if (observation.state !== "parsed") return;
    expect(observation.facts.version).toBe(59);
    expect(hermesVersionSupported(59)).toBe(true);
    expect(hermesVersionSupported(200)).toBe(false);
  });

  it("recognizes the delta form and refuses other magic", () => {
    const delta = observeHermesBytecode(
      buildHeader({ magic: HERMES_DELTA_MAGIC }),
    );
    expect(delta.state).toBe("parsed");
    if (delta.state !== "parsed") return;
    expect(delta.facts.form).toBe("delta");

    const foreign = observeHermesBytecode(buildHeader({ magic: 0x1234n }));
    expect(foreign).toEqual({
      state: "not-hermes",
      leadingBytes: "3412000000000000",
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
});
