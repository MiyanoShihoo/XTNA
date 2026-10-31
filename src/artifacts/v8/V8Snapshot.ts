/**
 * Bounded inventory for V8 snapshot containers.
 *
 * V8 snapshots are version-specific serialized heaps. This module deliberately
 * does not pretend to deserialize them: it recognizes the Chromium context
 * snapshot header and the raw SnapshotData magic, then reports the header
 * fields, declared sections and byte coverage that can be observed without a
 * matching V8 build. Object graphs, string tables and code remain unknown.
 */

export const V8_SNAPSHOT_MAGIC_MASK = 0xffff0000;
export const V8_SNAPSHOT_MAGIC_PREFIX = 0xc0de0000;
export const V8_CONTEXT_HEADER_BYTES = 128;
export const V8_CONTEXT_MAGIC_OFFSET = 104;
export const V8_CONTEXT_OFFSET_TABLE_OFFSET = 80;
export const V8_CONTEXT_OFFSET_TABLE_ENTRIES = 6;

const VERSION_STRING_OFFSET = 16;
const VERSION_STRING_BYTES = 64;
const SECTION_HEADER_BYTES = 8;
const MAX_SECTIONS = V8_CONTEXT_OFFSET_TABLE_ENTRIES;

const isMagic = (value: number): boolean =>
  value >>> 16 === V8_SNAPSHOT_MAGIC_PREFIX >>> 16;

const hex32 = (value: number): string =>
  `0x${value.toString(16).toUpperCase().padStart(8, "0")}`;

const hex64 = (value: bigint): string =>
  `0x${value.toString(16).toUpperCase().padStart(16, "0")}`;

const readVersionString = (bytes: Buffer): string | undefined => {
  if (bytes.length < VERSION_STRING_OFFSET + VERSION_STRING_BYTES)
    return undefined;
  const raw = bytes.subarray(
    VERSION_STRING_OFFSET,
    VERSION_STRING_OFFSET + VERSION_STRING_BYTES,
  );
  const nul = raw.indexOf(0);
  const end = nul === -1 ? raw.length : nul;
  const value = raw.subarray(0, end).toString("ascii");
  return /^\d+\.\d+\.\d+(?:\.\d+)?$/u.test(value) ? value : undefined;
};

export interface V8SnapshotSection {
  readonly index: number;
  readonly offset: number;
  readonly magic: string;
  readonly payloadLength: number;
  readonly payloadStart: number;
  readonly declaredEnd: number;
  readonly observedEnd: number;
  readonly complete: boolean;
}

export interface V8SnapshotObservation {
  readonly state: "parsed" | "unrecognized";
  readonly kind?: "v8-context-snapshot" | "v8-snapshot-data";
  readonly formatVersion?: number;
  readonly flags?: number;
  readonly checksum?: string;
  readonly v8Version?: string;
  readonly magic?: string;
  readonly magicOffset?: number;
  readonly headerBytes?: number;
  readonly sections?: readonly V8SnapshotSection[];
  readonly payloadBytes?: number;
  readonly trailingBytes?: number;
  readonly coverage: {
    readonly bytesExamined: number;
    readonly fileBytes: number;
    readonly complete: boolean;
  };
  readonly unknowns: readonly string[];
  readonly limitations: readonly string[];
}

const baseCoverage = (bytes: Buffer, fileBytes: number) => ({
  bytesExamined: bytes.length,
  fileBytes,
  complete: bytes.length >= fileBytes,
});

const commonUnknowns = [
  "V8 snapshot payload semantics are version-specific and are not deserialized here.",
  "Section labels and object graph contents are not assigned by this inventory.",
  "The recorded checksum is not verified without the matching V8 version.",
  "String tables, code objects, external references and live isolate state remain unknown.",
] as const;

const commonLimitations = [
  "Bounded header and section inventory only; no heap deserialization.",
  "The context-snapshot header layout is recognized from observed V8 15.6.x containers.",
] as const;

const unrecognized = (
  bytes: Buffer,
  fileBytes: number,
): V8SnapshotObservation => ({
  state: "unrecognized",
  coverage: baseCoverage(bytes, fileBytes),
  unknowns: [
    "No recognized V8 context-snapshot or SnapshotData signature was found.",
  ],
  limitations: ["Unrecognized input is not guessed at."],
});

/**
 * Recognize and inventory a V8 snapshot. `bytes` may be a bounded prefix;
 * `fileBytes` preserves the real file length so coverage is not overstated.
 */
export function observeV8Snapshot(
  bytes: Buffer,
  fileBytes: number = bytes.length,
): V8SnapshotObservation {
  if (bytes.length < 4) return unrecognized(bytes, fileBytes);

  const first = bytes.readUInt32LE(0);
  if (isMagic(first)) {
    return {
      state: "parsed",
      kind: "v8-snapshot-data",
      magic: hex32(first),
      magicOffset: 0,
      headerBytes: 4,
      payloadBytes: Math.max(0, fileBytes - 4),
      coverage: baseCoverage(bytes, fileBytes),
      unknowns: [
        ...commonUnknowns,
        "The raw SnapshotData header word meanings are version-specific.",
      ],
      limitations: [
        ...commonLimitations,
        "Only the SnapshotData magic is reported; no raw payload decoding.",
      ],
    };
  }

  if (bytes.length < V8_CONTEXT_HEADER_BYTES)
    return unrecognized(bytes, fileBytes);

  const formatVersion = bytes.readUInt32LE(0);
  const flags = bytes.readUInt32LE(4);
  const version = readVersionString(bytes);
  const magic = bytes.readUInt32LE(V8_CONTEXT_MAGIC_OFFSET);
  if (version === undefined || !isMagic(magic))
    return unrecognized(bytes, fileBytes);

  const sections: V8SnapshotSection[] = [];
  let payloadBytes = 0;
  let lastObservedEnd = V8_CONTEXT_HEADER_BYTES;
  for (
    let index = 0;
    index < V8_CONTEXT_OFFSET_TABLE_ENTRIES &&
    V8_CONTEXT_OFFSET_TABLE_OFFSET + (index + 1) * 4 <= bytes.length;
    index += 1
  ) {
    const offset = bytes.readUInt32LE(
      V8_CONTEXT_OFFSET_TABLE_OFFSET + index * 4,
    );
    if (offset === 0) continue;
    if (offset + SECTION_HEADER_BYTES > bytes.length) continue;
    const sectionMagic = bytes.readUInt32LE(offset);
    if (!isMagic(sectionMagic)) continue;
    const payloadLength = bytes.readUInt32LE(offset + 4);
    const payloadStart = offset + SECTION_HEADER_BYTES;
    const declaredEnd = payloadStart + payloadLength;
    const observedEnd = Math.min(declaredEnd, bytes.length);
    const complete = declaredEnd <= bytes.length;
    sections.push({
      index,
      offset,
      magic: hex32(sectionMagic),
      payloadLength,
      payloadStart,
      declaredEnd,
      observedEnd,
      complete,
    });
    payloadBytes += payloadLength;
    lastObservedEnd = Math.max(lastObservedEnd, observedEnd);
  }

  const trailingBytes = Math.max(0, fileBytes - lastObservedEnd);
  return {
    state: "parsed",
    kind: "v8-context-snapshot",
    formatVersion,
    flags,
    checksum: hex64(bytes.readBigUInt64LE(8)),
    v8Version: version,
    magic: hex32(magic),
    magicOffset: V8_CONTEXT_MAGIC_OFFSET,
    headerBytes: V8_CONTEXT_HEADER_BYTES,
    sections,
    payloadBytes,
    trailingBytes,
    coverage: baseCoverage(bytes, fileBytes),
    unknowns: [
      ...commonUnknowns,
      "The offset table is reported as declared section offsets; their labels are not inferred.",
      ...(sections.some((section) => !section.complete)
        ? ["At least one declared section extends past the examined bytes."]
        : []),
    ],
    limitations: commonLimitations,
  };
}
