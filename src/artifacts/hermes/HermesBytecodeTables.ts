/**
 * Hermes string and function tables.
 *
 * Layout follows `BytecodeFileFields::populateFromBuffer` in
 * `include/hermes/BCGen/HBC/BytecodeFileFormat.h`: after the 128-byte header
 * come the small function headers (12 bytes each), the run-length string kinds
 * (4 bytes each), the identifier hashes, the small string table (4 bytes each)
 * and any overflow entries; the string storage follows.
 *
 * Names are resolved through the string table. A function whose header
 * overflowed is reported as `overflowed: true` instead of being guessed at.
 */
import { err, ok, type Result } from "../../domain/result.js";
import {
  HERMES_HEADER_BYTES,
  observeHermesBytecode,
  type HermesHeaderFacts,
} from "./HermesBytecodeHeader.js";

export interface HermesStringEntry {
  readonly id: number;
  readonly value: string;
  readonly utf16: boolean;
}

export interface HermesFunctionEntry {
  readonly index: number;
  /** Resolved from the string table; absent when the name id could not be read. */
  readonly name: string | undefined;
  readonly nameStringId: number;
  readonly paramCount: number;
  readonly bytecodeSize: number;
  /** Offset of the function body from the start of the file. */
  readonly bytecodeOffset: number;
  readonly frameSize: number;
  readonly overflowed: boolean;
}

export interface HermesTables {
  readonly header: HermesHeaderFacts;
  readonly strings: readonly HermesStringEntry[];
  readonly functions: readonly HermesFunctionEntry[];
  readonly truncated: boolean;
}

export interface HermesTablesError {
  readonly code: "not-hermes" | "malformed" | "too-large";
  readonly message: string;
}

const MAX_STRINGS = 20_000;
const MAX_FUNCTIONS = 5_000;
/**
 * v84 and earlier store a 16-byte FunctionHeader (offset, paramCount,
 * bytecodeSize, functionName). Later releases compact it into the 12-byte
 * SmallFuncHeader with bitfields. The switch is version-gated rather than
 * guessed per file.
 */
const LEGACY_FUNCTION_HEADER_BYTES = 16;
const SMALL_HEADER_BYTES = 12;
const SMALL_HEADER_VERSION = 89;
const STRING_KIND_BYTES = 4;
const SMALL_STRING_ENTRY_BYTES = 4;
const OVERFLOW_ENTRY_BYTES = 8;
const INVALID_LENGTH = 0xff;

interface Bounds {
  readonly bytes: Uint8Array;
  readonly view: DataView;
}

const sectionEnd = (
  start: number,
  count: number,
  stride: number,
  total: number,
): number | undefined => {
  if (!Number.isSafeInteger(count) || count < 0) return undefined;
  const end = start + count * stride;
  if (!Number.isSafeInteger(end) || end > total) return undefined;
  return end;
};

const decodeString = (
  bytes: Uint8Array,
  start: number,
  length: number,
  utf16: boolean,
): string => {
  const slice = bytes.subarray(start, start + length);
  if (!utf16) return Buffer.from(slice).toString("utf8");
  let text = "";
  for (let index = 0; index + 1 < slice.length; index += 2)
    text += String.fromCharCode(
      (slice[index] ?? 0) | ((slice[index + 1] ?? 0) << 8),
    );
  return text;
};

/** Read the string and function tables of a `.hbc` file. */
export function readHermesTables(
  bytes: Uint8Array,
): Result<HermesTables, HermesTablesError> {
  const observation = observeHermesBytecode(bytes);
  if (observation.state === "not-hermes")
    return err({ code: "not-hermes", message: "Not a Hermes bytecode file." });
  if (observation.state === "truncated")
    return err({
      code: "malformed",
      message: `File holds ${String(observation.availableBytes)} of the ${String(observation.neededBytes)} header bytes.`,
    });
  const header = observation.facts;
  if (header.functionCount > MAX_FUNCTIONS)
    return err({
      code: "too-large",
      message: `Module declares ${String(header.functionCount)} functions; the reader stops at ${String(MAX_FUNCTIONS)}.`,
    });
  if (header.stringCount + header.overflowStringCount > MAX_STRINGS)
    return err({
      code: "too-large",
      message: `Module declares ${String(header.stringCount + header.overflowStringCount)} strings; the reader stops at ${String(MAX_STRINGS)}.`,
    });
  const total = bytes.length;
  const bounds: Bounds = {
    bytes,
    view: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
  };
  let cursor = HERMES_HEADER_BYTES;
  const functionHeaderBytes =
    header.version >= SMALL_HEADER_VERSION
      ? SMALL_HEADER_BYTES
      : LEGACY_FUNCTION_HEADER_BYTES;
  const functionsEnd = sectionEnd(
    cursor,
    header.functionCount,
    functionHeaderBytes,
    total,
  );
  if (functionsEnd === undefined)
    return err({
      code: "malformed",
      message: "Function headers run past the file.",
    });
  const functionsStart = cursor;
  cursor = functionsEnd;

  const kindsEnd = sectionEnd(
    cursor,
    header.stringKindCount,
    STRING_KIND_BYTES,
    total,
  );
  if (kindsEnd === undefined)
    return err({
      code: "malformed",
      message: "String kinds run past the file.",
    });
  cursor = kindsEnd;

  const hashesEnd = sectionEnd(cursor, header.identifierCount, 4, total);
  if (hashesEnd === undefined)
    return err({
      code: "malformed",
      message: "Identifier hashes run past the file.",
    });
  cursor = hashesEnd;

  const stringsStart = cursor;
  const stringsEnd = sectionEnd(
    cursor,
    header.stringCount,
    SMALL_STRING_ENTRY_BYTES,
    total,
  );
  if (stringsEnd === undefined)
    return err({
      code: "malformed",
      message: "String table runs past the file.",
    });
  cursor = stringsEnd;

  const overflowStart = cursor;
  const overflowEnd = sectionEnd(
    cursor,
    header.overflowStringCount,
    OVERFLOW_ENTRY_BYTES,
    total,
  );
  if (overflowEnd === undefined)
    return err({
      code: "malformed",
      message: "Overflow string table runs past the file.",
    });
  cursor = overflowEnd;

  const storageStart = cursor;
  const storageEnd = sectionEnd(
    storageStart,
    header.stringStorageSize,
    1,
    total,
  );
  if (storageEnd === undefined)
    return err({
      code: "malformed",
      message: "String storage runs past the file.",
    });

  const strings: HermesStringEntry[] = [];
  for (let id = 0; id < header.stringCount; id += 1) {
    const entryOffset = stringsStart + id * SMALL_STRING_ENTRY_BYTES;
    const data = bounds.view.getUint32(entryOffset, true);
    const utf16 = (data & 1) === 1;
    let offset = (data >>> 1) & 0x7fffff;
    let length = (data >>> 24) & 0xff;
    if (length === INVALID_LENGTH) {
      if (offset >= header.overflowStringCount) {
        strings.push({ id, value: "", utf16 });
        continue;
      }
      const overflowOffset = overflowStart + offset * OVERFLOW_ENTRY_BYTES;
      offset = bounds.view.getUint32(overflowOffset, true);
      length = bounds.view.getUint32(overflowOffset + 4, true);
    }
    if (storageStart + offset + length > storageEnd) {
      strings.push({ id, value: "", utf16 });
      continue;
    }
    strings.push({
      id,
      value: decodeString(bytes, storageStart + offset, length, utf16),
      utf16,
    });
  }

  const byId = new Map(strings.map((entry) => [entry.id, entry.value]));
  const functions: HermesFunctionEntry[] = [];
  for (let index = 0; index < header.functionCount; index += 1) {
    const offset = functionsStart + index * functionHeaderBytes;
    if (functionHeaderBytes === LEGACY_FUNCTION_HEADER_BYTES) {
      // v76-v88 SmallFuncHeader: offset:25|paramCount:7, bytecodeSize:15|functionName:17,
      // infoOffset:25|frameSize:7, then three cache bytes and the flags byte.
      const word1 = bounds.view.getUint32(offset, true);
      const word2 = bounds.view.getUint32(offset + 4, true);
      const word3 = bounds.view.getUint32(offset + 8, true);
      const flags = bounds.view.getUint8(offset + 15);
      const overflowed = (flags & 0x20) !== 0;
      const nameStringId = (word2 >>> 15) & 0x1ffff;
      functions.push({
        index,
        name: overflowed ? undefined : byId.get(nameStringId),
        nameStringId,
        paramCount: (word1 >>> 25) & 0x7f,
        bytecodeSize: word2 & 0x7fff,
        bytecodeOffset: word1 & 0x1ffffff,
        frameSize: (word3 >>> 25) & 0x7f,
        overflowed,
      });
      continue;
    }
    const word1 = bounds.view.getUint32(offset, true);
    const word2 = bounds.view.getUint32(offset + 4, true);
    const flags = bounds.view.getUint8(offset + 11);
    const overflowed = ((flags >>> 5) & 1) === 1;
    const nameStringId = (word2 >>> 14) & 0xff;
    functions.push({
      index,
      name: overflowed ? undefined : byId.get(nameStringId),
      nameStringId,
      paramCount: (word1 >>> 25) & 0x1f,
      bytecodeSize: word2 & 0x3fff,
      bytecodeOffset: word1 & 0x1ffffff,
      frameSize: bounds.view.getUint8(offset + 8),
      overflowed,
    });
  }

  return ok({
    header,
    strings,
    functions,
    truncated:
      header.stringCount + header.overflowStringCount > strings.length ||
      header.functionCount > functions.length,
  });
}
