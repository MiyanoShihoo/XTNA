import { describe, expect, it } from "vitest";

import { fingerprintAlgorithms } from "./AlgorithmFingerprinting.js";

const bytes = (hex: string): Uint8Array =>
  new Uint8Array(
    hex.match(/.{2}/gu)?.map((pair) => Number.parseInt(pair, 16)) ?? [],
  );
const fingerprint = (source: Uint8Array) => {
  const result = fingerprintAlgorithms(source, { maxProtobufCandidates: 0 });
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
};

describe("algorithm and protocol fingerprinting", () => {
  it("detects Base64 alphabets with exact offsets and high confidence", () => {
    const alphabet = new TextEncoder().encode(
      "xxABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/",
    );
    const result = fingerprint(alphabet);
    expect(result.fingerprints).toHaveLength(1);
    expect(result.fingerprints[0]).toEqual(
      expect.objectContaining({
        algorithm: "base64",
        offset: 2,
        length: 64,
        confidence: "high",
      }),
    );
    expect(result.fingerprints[0]?.evidence[0]?.kind).toBe("byte-signature");
  });

  it("recognizes reflected CRC-32 and CRC-32C tables", () => {
    const result = fingerprint(
      bytes("00000000963007772c610eee00000000f26b8303e13b70f1"),
    );
    expect(
      result.fingerprints.filter((hit) => hit.algorithm === "crc32"),
    ).toHaveLength(2);
    expect(result.fingerprints.every((hit) => hit.confidence === "high")).toBe(
      true,
    );
  });

  it("distinguishes complete hash constants from shared MD5/SHA-1 state", () => {
    const result = fingerprint(
      bytes(
        "6a09e667bb67ae853c6ef372a54ff53a67452301efcdab8998badcfe103254765a827999",
      ),
    );
    expect(result.fingerprints.map((hit) => hit.algorithm)).toEqual([
      "sha256",
      "sha1",
    ]);
  });

  it("validates zlib headers instead of matching every 78 9c pair", () => {
    const result = fingerprint(bytes("00789c789dff"));
    const zlib = result.fingerprints.filter((hit) => hit.algorithm === "zlib");
    expect(zlib).toHaveLength(1);
    expect(zlib[0]).toEqual(
      expect.objectContaining({ offset: 1, confidence: "medium" }),
    );
    expect(zlib[0]?.evidence[0]?.kind).toBe("header-validation");
  });

  it("detects zstd magic with strong evidence", () => {
    expect(fingerprint(bytes("aa28b52ffdbb")).fingerprints[0]).toEqual(
      expect.objectContaining({
        algorithm: "zstd",
        offset: 1,
        confidence: "high",
      }),
    );
  });

  it("reports bounded protobuf wire structure as low confidence", () => {
    const result = fingerprintAlgorithms(bytes("08011203414243"));
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value.fingerprints).toHaveLength(1);
    expect(result.value.fingerprints[0]).toEqual(
      expect.objectContaining({
        algorithm: "protobuf",
        offset: 0,
        confidence: "low",
      }),
    );
    expect(result.value.fingerprints[0]?.evidence[0]?.kind).toBe(
      "wire-structure",
    );
  });

  it("rejects malformed protobuf wire data", () => {
    const result = fingerprintAlgorithms(bytes("080180"), {
      maxProtobufCandidates: 10,
    });
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value.fingerprints).toEqual([]);
  });

  it("returns typed errors for invalid bounds and oversized inputs", () => {
    expect(
      fingerprintAlgorithms(new Uint8Array(20), { maxSourceBytes: 16 }).ok,
    ).toBe(false);
    expect(
      fingerprintAlgorithms(new Uint8Array(), { maxFindings: -1 }).ok,
    ).toBe(false);
  });

  it("caps retained findings while retaining complete-scan coverage facts", () => {
    const result = fingerprintAlgorithms(bytes("28b52ffd28b52ffd"), {
      maxFindings: 1,
      maxProtobufCandidates: 0,
    });
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value.fingerprints).toHaveLength(1);
    expect(result.value.unknowns).toEqual([
      expect.objectContaining({ code: "findings-truncated", omitted: 1 }),
    ]);
    expect(result.value.examinedBytes).toBe(8);
  });
});
