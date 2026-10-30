/**
 * Hermes bytecode (`.hbc`) header recognition.
 *
 * The header is the 128-byte `BytecodeFileHeader` from
 * `include/hermes/BCGen/HBC/BytecodeFileFormat.h`: a 64-bit magic
 * (`0x1F1903C103BC1FC6`, "Hermes" in UTF-16BE truncated to eight bytes), the
 * bytecode version, a 20-byte source hash and the counters that size the tables
 * which follow.
 *
 * This module reads the header only. String and function tables live in
 * `HermesBytecodeTables.ts`.
 */

/** "Hermes" in ancient Greek, UTF-16BE, truncated to eight bytes. */
export const HERMES_MAGIC = 0x1f1903c103bc1fc6n;
/** Delta-prepped form: the bitwise complement of the execution magic. */
export const HERMES_DELTA_MAGIC = ~HERMES_MAGIC & 0xffffffffffffffffn;
export const HERMES_HEADER_BYTES = 128;

export const HERMES_MIN_VERSION = 50;
export const HERMES_MAX_VERSION = 120;

export interface HermesHeaderFacts {
  readonly version: number;
  /** `execution` is runnable; `delta` is prepared for diffing, not execution. */
  readonly form: "execution" | "delta";
  readonly sourceHash: string;
  readonly fileLength: number;
  readonly globalCodeIndex: number;
  readonly functionCount: number;
  readonly stringKindCount: number;
  readonly identifierCount: number;
  readonly stringCount: number;
  readonly overflowStringCount: number;
  readonly stringStorageSize: number;
  readonly bigIntCount: number;
  readonly regExpCount: number;
  readonly literalValueBufferSize: number;
  readonly objKeyBufferSize: number;
  readonly objShapeTableCount: number;
  readonly segmentID: number;
  readonly cjsModuleCount: number;
  readonly functionSourceCount: number;
  readonly debugInfoOffset: number;
}

export type HermesHeaderObservation =
  | { readonly state: "parsed"; readonly facts: HermesHeaderFacts }
  | { readonly state: "not-hermes"; readonly leadingBytes: string }
  | {
      readonly state: "truncated";
      readonly availableBytes: number;
      readonly neededBytes: number;
    };

const hex = (bytes: Uint8Array): string =>
  [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");

/**
 * Read the Hermes header. A file is Hermes only when the 64-bit magic matches
 * the execution or delta form; everything else is `not-hermes`.
 */
export function observeHermesBytecode(
  bytes: Uint8Array,
): HermesHeaderObservation {
  if (bytes.length < HERMES_HEADER_BYTES)
    return {
      state: "truncated",
      availableBytes: bytes.length,
      neededBytes: HERMES_HEADER_BYTES,
    };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = view.getBigUint64(0, true);
  const form =
    magic === HERMES_MAGIC
      ? ("execution" as const)
      : magic === HERMES_DELTA_MAGIC
        ? ("delta" as const)
        : undefined;
  if (form === undefined)
    return { state: "not-hermes", leadingBytes: hex(bytes.subarray(0, 8)) };
  const u32 = (offset: number): number => view.getUint32(offset, true);
  const version = u32(8);
  // v76-v88 headers carry array/object buffers and no bigint table; the
  // newer layout adds bigint and shape tables and moves the tail fields.
  const legacy = version < 89;
  return {
    state: "parsed",
    facts: {
      version,
      form,
      sourceHash: hex(bytes.subarray(12, 32)),
      fileLength: u32(32),
      globalCodeIndex: u32(36),
      functionCount: u32(40),
      stringKindCount: u32(44),
      identifierCount: u32(48),
      stringCount: u32(52),
      overflowStringCount: u32(56),
      stringStorageSize: u32(60),
      bigIntCount: legacy ? 0 : u32(64),
      regExpCount: u32(legacy ? 64 : 72),
      literalValueBufferSize: legacy ? u32(72) : u32(80),
      objKeyBufferSize: u32(legacy ? 76 : 84),
      objShapeTableCount: legacy ? 0 : u32(88),
      segmentID: legacy ? 0 : u32(96),
      cjsModuleCount: u32(legacy ? 88 : 100),
      functionSourceCount: legacy ? 0 : u32(104),
      debugInfoOffset: u32(legacy ? 92 : 108),
    },
  };
}

/** Whether the recorded version shares the known header layout. */
export function hermesVersionSupported(version: number): boolean {
  return version >= HERMES_MIN_VERSION && version <= HERMES_MAX_VERSION;
}
