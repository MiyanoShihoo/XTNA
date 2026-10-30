/**
 * Hermes bytecode disassembly (bytecode version 84).
 *
 * Uses the opcode table generated from the upstream `BytecodeList.def`
 * (v0.8.0). Each function body is decoded from its header offset and must end
 * exactly at `offset + bytecodeSize`; a stream that overruns, or an opcode
 * outside the table, marks that function undecoded instead of being guessed.
 */
import { err, ok, type Result } from "../../domain/result.js";
import {
  HERMES_OPCODES_V84,
  OPERAND_BYTES,
  type HermesOpcode,
} from "./HermesOpcodes.js";
import { readHermesTables, type HermesTables } from "./HermesBytecodeTables.js";

export interface HermesInstruction {
  readonly offset: number;
  readonly opcode: number;
  readonly name: string;
  readonly operands: readonly number[];
}

export interface HermesFunctionCode {
  readonly index: number;
  readonly name: string | undefined;
  readonly bytecodeOffset: number;
  readonly bytecodeSize: number;
  readonly instructions: readonly HermesInstruction[];
  readonly decoded: boolean;
  readonly reason?: string;
}

export interface HermesDisassembly {
  readonly tables: HermesTables;
  readonly functions: readonly HermesFunctionCode[];
  readonly decodedFunctions: number;
  readonly undecodedFunctions: readonly number[];
}

export interface HermesDisassemblyError {
  readonly code:
    | "not-hermes"
    | "malformed"
    | "unsupported-version"
    | "too-large";
  readonly message: string;
}

const MAX_INSTRUCTIONS = 200_000;

/**
 * Read one operand. Branch targets and immediate integers are signed: a jump
 * offset is relative to the jump instruction and may point backwards.
 */
const operandValue = (
  bytes: Uint8Array,
  view: DataView,
  offset: number,
  kind: HermesOpcode["operands"][number],
): number => {
  switch (kind) {
    case "Reg8":
    case "UInt8":
      return bytes[offset] ?? 0;
    case "Addr8":
      return view.getInt8(offset);
    case "UInt16":
      return view.getUint16(offset, true);
    case "UInt32":
    case "Reg32":
      return view.getUint32(offset, true);
    case "Addr32":
      return view.getInt32(offset, true);
    case "Imm32":
      return view.getInt32(offset, true);
    case "Double":
      return view.getFloat64(offset, true);
  }
};

/**
 * Disassemble every non-overflowed function body. Only bytecode version 84 is
 * decoded: other versions have different opcode maps and are refused.
 */
export function disassembleHermes(
  bytes: Uint8Array,
): Result<HermesDisassembly, HermesDisassemblyError> {
  const tables = readHermesTables(bytes);
  if (!tables.ok)
    return err({
      code: tables.error.code === "too-large" ? "too-large" : "malformed",
      message: tables.error.message,
    });
  if (tables.value.header.version !== 84)
    return err({
      code: "unsupported-version",
      message: `Bytecode version ${String(tables.value.header.version)} has no opcode table here; only version 84 is decoded.`,
    });
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const functions: HermesFunctionCode[] = [];
  const undecodedFunctions: number[] = [];
  let instructionBudget = MAX_INSTRUCTIONS;
  for (const fn of tables.value.functions) {
    const base = {
      index: fn.index,
      name: fn.name,
      bytecodeOffset: fn.bytecodeOffset,
      bytecodeSize: fn.bytecodeSize,
    };
    if (fn.overflowed || fn.bytecodeSize === 0) {
      functions.push({
        ...base,
        instructions: [],
        decoded: false,
        reason: "no decodable body",
      });
      undecodedFunctions.push(fn.index);
      continue;
    }
    const start = fn.bytecodeOffset;
    const end = start + fn.bytecodeSize;
    if (start < 0 || end > bytes.length) {
      functions.push({
        ...base,
        instructions: [],
        decoded: false,
        reason: "body outside the file",
      });
      undecodedFunctions.push(fn.index);
      continue;
    }
    const instructions: HermesInstruction[] = [];
    let cursor = start;
    let reason: string | undefined;
    while (cursor < end) {
      if (instructionBudget <= 0) {
        reason = "instruction budget exhausted";
        break;
      }
      const opcode = bytes[cursor] ?? 0;
      const entry = HERMES_OPCODES_V84[opcode];
      if (entry === undefined) {
        reason = `unknown opcode 0x${opcode.toString(16)}`;
        break;
      }
      let operandCursor = cursor + 1;
      const operands: number[] = [];
      let overrun = false;
      for (const kind of entry.operands) {
        const width = OPERAND_BYTES[kind];
        if (operandCursor + width > end) {
          overrun = true;
          break;
        }
        operands.push(operandValue(bytes, view, operandCursor, kind));
        operandCursor += width;
      }
      if (overrun) {
        reason = "operands run past the function body";
        break;
      }
      instructions.push({ offset: cursor, opcode, name: entry.name, operands });
      instructionBudget -= 1;
      cursor = operandCursor;
    }
    const decoded = reason === undefined && cursor === end;
    functions.push({
      ...base,
      instructions,
      decoded,
      ...(decoded
        ? {}
        : {
            reason:
              reason ?? "instruction stream does not end at the body boundary",
          }),
    });
    if (!decoded) undecodedFunctions.push(fn.index);
  }
  return ok({
    tables: tables.value,
    functions,
    decodedFunctions: functions.length - undecodedFunctions.length,
    undecodedFunctions,
  });
}
