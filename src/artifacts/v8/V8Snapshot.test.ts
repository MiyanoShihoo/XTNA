import { describe, expect, it } from "vitest";

import {
  observeV8Snapshot,
  V8_CONTEXT_HEADER_BYTES,
  V8_CONTEXT_MAGIC_OFFSET,
  V8_CONTEXT_OFFSET_TABLE_OFFSET,
} from "./V8Snapshot.js";

const magic = 0xc0de06d6;

const section = (payload: Buffer): Buffer => {
  const header = Buffer.alloc(8);
  header.writeUInt32LE(magic, 0);
  header.writeUInt32LE(payload.length, 4);
  return Buffer.concat([header, payload]);
};

const contextSnapshot = (payloads: Buffer[]): Buffer => {
  const header = Buffer.alloc(V8_CONTEXT_HEADER_BYTES);
  header.writeUInt32LE(3, 0);
  header.writeUInt32LE(1, 4);
  header.writeBigUInt64LE(0x1122334455667788n, 8);
  header.write("15.6.75", 16, "ascii");
  header.writeUInt32LE(magic, V8_CONTEXT_MAGIC_OFFSET);

  const bodies = payloads.map(section);
  let offset = V8_CONTEXT_HEADER_BYTES;
  for (const [index, body] of bodies.entries()) {
    header.writeUInt32LE(offset, V8_CONTEXT_OFFSET_TABLE_OFFSET + index * 4);
    offset += body.length;
  }
  return Buffer.concat([header, ...bodies]);
};

describe("V8 snapshot inventory", () => {
  it("recognizes the context-snapshot header and declared sections", () => {
    const bytes = contextSnapshot([
      Buffer.from("first-section"),
      Buffer.from("second-section"),
    ]);
    const observation = observeV8Snapshot(bytes);
    expect(observation.state).toBe("parsed");
    expect(observation.kind).toBe("v8-context-snapshot");
    expect(observation.formatVersion).toBe(3);
    expect(observation.flags).toBe(1);
    expect(observation.v8Version).toBe("15.6.75");
    expect(observation.magic).toBe("0xC0DE06D6");
    expect(observation.magicOffset).toBe(V8_CONTEXT_MAGIC_OFFSET);
    expect(observation.sections).toHaveLength(2);
    expect(observation.sections?.[0]).toMatchObject({
      payloadStart: V8_CONTEXT_HEADER_BYTES + 8,
      payloadLength: "first-section".length,
      complete: true,
    });
    expect(observation.sections?.[1]).toMatchObject({
      payloadLength: "second-section".length,
      complete: true,
    });
    expect(observation.payloadBytes).toBe(
      "first-section".length + "second-section".length,
    );
    expect(observation.coverage.complete).toBe(true);
  });

  it("reports a declared section that extends past the examined bytes", () => {
    const body = Buffer.concat([
      Buffer.from([0xd6, 0x06, 0xde, 0xc0]),
      Buffer.from([0x40, 0x00, 0x00, 0x00]),
      Buffer.from("short"),
    ]);
    const header = Buffer.alloc(V8_CONTEXT_HEADER_BYTES);
    header.writeUInt32LE(3, 0);
    header.write("15.6.75", 16, "ascii");
    header.writeUInt32LE(magic, V8_CONTEXT_MAGIC_OFFSET);
    header.writeUInt32LE(
      V8_CONTEXT_HEADER_BYTES,
      V8_CONTEXT_OFFSET_TABLE_OFFSET,
    );
    const observation = observeV8Snapshot(Buffer.concat([header, body]));
    expect(observation.state).toBe("parsed");
    expect(observation.sections?.[0]?.complete).toBe(false);
    expect(observation.unknowns.join(" ")).toContain(
      "extends past the examined bytes",
    );
  });

  it("recognizes a raw SnapshotData magic without claiming a heap", () => {
    const bytes = Buffer.alloc(32);
    bytes.writeUInt32LE(magic, 0);
    const observation = observeV8Snapshot(bytes);
    expect(observation.state).toBe("parsed");
    expect(observation.kind).toBe("v8-snapshot-data");
    expect(observation.magicOffset).toBe(0);
    expect(observation.limitations.join(" ")).toContain(
      "no raw payload decoding",
    );
  });

  it("does not guess at an unrelated file", () => {
    const observation = observeV8Snapshot(Buffer.from("not a v8 snapshot"));
    expect(observation.state).toBe("unrecognized");
    expect(observation.coverage.complete).toBe(true);
  });

  it("preserves file coverage when only a prefix was examined", () => {
    const bytes = contextSnapshot([Buffer.from("x")]).subarray(0, 128);
    const observation = observeV8Snapshot(bytes, 4096);
    expect(observation.state).toBe("parsed");
    expect(observation.coverage.bytesExamined).toBe(128);
    expect(observation.coverage.fileBytes).toBe(4096);
    expect(observation.coverage.complete).toBe(false);
  });
});
