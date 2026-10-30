/**
 * Hermes bytecode (`.hbc`) header recognition.
 *
 * React Native ships precompiled Hermes bytecode inside `index.android.bundle`
 * and standalone `.hbc` files. The format opens with a fixed 60-byte prefix that
 * has stayed stable across Hermes releases: magic, bytecode version, a 20-byte
 * source hash, then counters for the function and string tables.
 *
 * This module reads only that prefix. It reports what the header states and
 * refuses to guess at tables whose layouts changed between releases — the
 * string table, function table and any AST extraction are explicitly out of
 * scope here.
 */

export const HERMES_BYTECODE_MAGIC = 0xc61fbc3f;
export const HERMES_HEADER_BYTES = 60;

/** Versions whose shared 60-byte prefix is known to match this layout. */
export const HERMES_MIN_VERSION = 50;
export const HERMES_MAX_VERSION = 120;

export interface HermesHeaderFacts {
  /** Bytecode version recorded in the file. */
  readonly version: number;
  /** Hex of the 20-byte SHA-1 source hash. */
  readonly sourceHash: string;
  /** Total bytecode length the header declares. */
  readonly fileLength: number;
  /** Index of the global code function in the function table. */
  readonly globalCodeIndex: number;
  /** Number of functions in the function table. */
  readonly functionCount: number;
  /** Number of distinct string kinds. */
  readonly stringKindCount: number;
  /** Number of identifier strings. */
  readonly identifierCount: number;
  /** Number of strings in the small-string table. */
  readonly stringCount: number;
  /** Number of strings that overflowed the small-string table. */
  readonly overflowStringCount: number;
  /** Byte length of the string storage area. */
  readonly stringStorageSize: number;
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
 * Read the Hermes header prefix.
 *
 * A file is Hermes only when the magic matches; everything else is reported as
 * `not-hermes` rather than being reinterpreted. A matching magic with a version
 * outside the known range still returns the facts it can read, so a caller can
 * show the version instead of discarding the file.
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
  const magic = view.getUint32(0, true);
  if (magic !== HERMES_BYTECODE_MAGIC)
    return { state: "not-hermes", leadingBytes: hex(bytes.subarray(0, 4)) };
  return {
    state: "parsed",
    facts: {
      version: view.getUint32(4, true),
      sourceHash: hex(bytes.subarray(8, 28)),
      fileLength: view.getUint32(28, true),
      globalCodeIndex: view.getUint32(32, true),
      functionCount: view.getUint32(36, true),
      stringKindCount: view.getUint32(40, true),
      identifierCount: view.getUint32(44, true),
      stringCount: view.getUint32(48, true),
      overflowStringCount: view.getUint32(52, true),
      stringStorageSize: view.getUint32(56, true),
    },
  };
}

/** Whether the recorded version shares the known header layout. */
export function hermesVersionSupported(version: number): boolean {
  return version >= HERMES_MIN_VERSION && version <= HERMES_MAX_VERSION;
}
