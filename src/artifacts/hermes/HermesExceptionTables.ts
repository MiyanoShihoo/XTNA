/**
 * Hermes exception-handler tables (bytecode version 84).
 *
 * `FunctionHeader.infoOffset` is an absolute file offset to an aligned
 * `ExceptionHandlerTableHeader { count }` followed by `count` entries of
 * `HBCExceptionHandlerInfo { start, end, target }`, all relative to the
 * function's bytecode start (proven from `BCProviderFromBuffer::
 * getExceptionTableAndDebugOffsets` in Hermes v0.11.0). A table is only
 * reported when every entry fits inside the function and the file; otherwise
 * the function is `unknown` instead of partially trusted.
 */
import { err, ok, type Result } from "../../domain/result.js";
import { HERMES_HEADER_BYTES } from "./HermesBytecodeHeader.js";
import { readHermesTables } from "./HermesBytecodeTables.js";

export interface HermesExceptionHandler {
  readonly start: number;
  readonly end: number;
  readonly target: number;
}

export interface HermesFunctionExceptions {
  readonly index: number;
  readonly name: string | undefined;
  readonly status: "absent" | "parsed" | "unknown";
  readonly infoOffset: number;
  readonly handlers: readonly HermesExceptionHandler[];
  readonly reason?: string;
}

export interface HermesExceptionTables {
  readonly functions: readonly HermesFunctionExceptions[];
  readonly parsedFunctions: number;
  readonly unknownFunctions: readonly number[];
}

export interface HermesExceptionTablesError {
  readonly code: "not-hermes" | "malformed" | "too-large";
  readonly message: string;
}

const MAX_HANDLERS = 1_024;
const LEGACY_FUNCTION_HEADER_BYTES = 16;
const SMALL_HEADER_VERSION = 89;
const FLAG_HAS_EXCEPTION_HANDLER = 0x08;
const FLAG_OVERFLOWED = 0x20;

const align4 = (value: number): number => Math.ceil(value / 4) * 4;

/** Read the exception-handler table of every non-overflowed v84 function. */
export function readHermesExceptionTables(
  bytes: Uint8Array,
): Result<HermesExceptionTables, HermesExceptionTablesError> {
  const tables = readHermesTables(bytes);
  if (!tables.ok)
    return err({
      code: tables.error.code,
      message: tables.error.message,
    });
  if (tables.value.header.version !== 84)
    return err({
      code: "malformed",
      message: `Exception tables are read for bytecode version 84 only; this file is ${String(tables.value.header.version)}.`,
    });
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const functions: HermesFunctionExceptions[] = [];
  const unknownFunctions: number[] = [];
  let parsedFunctions = 0;
  const functionHeaderBytes =
    tables.value.header.version >= SMALL_HEADER_VERSION
      ? 12
      : LEGACY_FUNCTION_HEADER_BYTES;
  for (const fn of tables.value.functions) {
    const headerOffset = HERMES_HEADER_BYTES + fn.index * functionHeaderBytes;
    const word3 = view.getUint32(headerOffset + 8, true);
    const flags = view.getUint8(headerOffset + 15);
    const infoOffset = word3 & 0x1ffffff;
    if (fn.overflowed || (flags & FLAG_OVERFLOWED) !== 0) {
      functions.push({
        index: fn.index,
        name: fn.name,
        status: "unknown",
        infoOffset,
        handlers: [],
        reason: "overflowed function header",
      });
      unknownFunctions.push(fn.index);
      continue;
    }
    if ((flags & FLAG_HAS_EXCEPTION_HANDLER) === 0) {
      functions.push({
        index: fn.index,
        name: fn.name,
        status: "absent",
        infoOffset,
        handlers: [],
      });
      continue;
    }
    const tableStart = align4(infoOffset);
    if (tableStart + 4 > bytes.length) {
      functions.push({
        index: fn.index,
        name: fn.name,
        status: "unknown",
        infoOffset,
        handlers: [],
        reason: "exception table header is outside the file",
      });
      unknownFunctions.push(fn.index);
      continue;
    }
    const count = view.getUint32(tableStart, true);
    if (count > MAX_HANDLERS || tableStart + 4 + count * 12 > bytes.length) {
      functions.push({
        index: fn.index,
        name: fn.name,
        status: "unknown",
        infoOffset,
        handlers: [],
        reason: `exception table with ${String(count)} entries does not fit the file`,
      });
      unknownFunctions.push(fn.index);
      continue;
    }
    const handlers: HermesExceptionHandler[] = [];
    let valid = true;
    for (let index = 0; index < count; index += 1) {
      const entry = tableStart + 4 + index * 12;
      const start = view.getUint32(entry, true);
      const end = view.getUint32(entry + 4, true);
      const target = view.getUint32(entry + 8, true);
      if (start >= end || end > fn.bytecodeSize || target > fn.bytecodeSize) {
        valid = false;
        break;
      }
      handlers.push({ start, end, target });
    }
    if (!valid) {
      functions.push({
        index: fn.index,
        name: fn.name,
        status: "unknown",
        infoOffset,
        handlers: [],
        reason: "an exception entry falls outside the function body",
      });
      unknownFunctions.push(fn.index);
      continue;
    }
    functions.push({
      index: fn.index,
      name: fn.name,
      status: "parsed",
      infoOffset,
      handlers,
    });
    parsedFunctions += 1;
  }
  return ok({ functions, parsedFunctions, unknownFunctions });
}
