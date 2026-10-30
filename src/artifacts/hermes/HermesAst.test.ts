import { describe, expect, it } from "vitest";

import { buildHermesAst, renderHermesStatement } from "./HermesAst.js";
import { disassembleHermes } from "./HermesDisassembly.js";
import { HERMES_HEADER_BYTES, HERMES_MAGIC } from "./HermesBytecodeHeader.js";
import { HERMES_OPCODES_V84 } from "./HermesOpcodes.js";

const opcode = (name: string): number => {
  const index = HERMES_OPCODES_V84.findIndex((entry) => entry.name === name);
  if (index < 0) throw new Error(`missing opcode ${name}`);
  return index;
};

/** Opcode widths, used to compute offsets so jump deltas can be patched. */
const WIDTHS: Readonly<Record<string, number>> = {
  LoadConstUInt8: 3,
  LoadConstTrue: 2,
  LoadConstZero: 2,
  Ret: 2,
  PutById: 6,
  JmpFalse: 3,
  Jmp: 2,
  JNotLess: 4,
  JLess: 4,
  AddN: 4,
  SwitchImm: 18,
};

interface Emitted {
  readonly bytes: number[];
  readonly offsetOf: (name: string, occurrence?: number) => number;
}

const emit = (
  program: readonly (readonly [name: string, operands?: readonly number[]])[],
): Emitted => {
  const bytes: number[] = [];
  const offsets: { name: string; offset: number }[] = [];
  for (const [name, operands = []] of program) {
    offsets.push({ name, offset: bytes.length });
    bytes.push(opcode(name));
    const width = WIDTHS[name];
    if (width === undefined) throw new Error(`no width for ${name}`);
    const operandBytes = width - 1;
    if (
      operands.length !== operandBytes &&
      name !== "Jmp" &&
      name !== "JmpFalse"
    )
      throw new Error(`${name} expects ${String(operandBytes)} operand bytes`);
    for (const operand of operands) bytes.push(operand & 0xff);
  }
  return {
    bytes,
    offsetOf: (name, occurrence = 0) =>
      offsets.filter((entry) => entry.name === name)[occurrence]?.offset ?? -1,
  };
};

const buildModule = (code: readonly number[]): Buffer => {
  const strings = ["a"];
  const storage = Buffer.from("a", "utf8");
  const functionHeader = Buffer.alloc(16);
  const kinds = Buffer.alloc(4);
  kinds.writeUInt32LE(1, 0);
  const stringTable = Buffer.alloc(4);
  stringTable.writeUInt32LE(1 << 24, 0);
  const bytecodeOffset =
    HERMES_HEADER_BYTES +
    16 +
    kinds.length +
    stringTable.length +
    storage.length;
  functionHeader.writeUInt32LE(bytecodeOffset & 0x1ffffff, 0);
  functionHeader.writeUInt32LE(code.length & 0x7fff, 4);
  functionHeader.writeUInt8(0, 15);
  const total = bytecodeOffset + code.length;
  const header = Buffer.alloc(HERMES_HEADER_BYTES);
  header.writeBigUInt64LE(HERMES_MAGIC, 0);
  header.writeUInt32LE(84, 8);
  header.writeUInt32LE(total, 32);
  header.writeUInt32LE(1, 40);
  header.writeUInt32LE(1, 44);
  header.writeUInt32LE(0, 48);
  header.writeUInt32LE(strings.length, 52);
  header.writeUInt32LE(0, 56);
  header.writeUInt32LE(storage.length, 60);
  return Buffer.concat([
    header,
    functionHeader,
    kinds,
    stringTable,
    storage,
    Buffer.from(code),
  ]);
};

const astOf = (code: readonly number[]) => {
  const module = buildModule(code);
  const result = disassembleHermes(module);
  if (!result.ok) throw new Error(result.error.message);
  return {
    disassembly: result.value,
    ast: buildHermesAst(result.value, new Uint8Array(module)),
  };
};

describe("hermes ast", () => {
  it("recovers an if/else from a forward branch over an else arm", () => {
    const program = emit([
      ["LoadConstTrue", [1]],
      ["JmpFalse", [0, 1]],
      ["LoadConstUInt8", [2, 1]],
      ["LoadConstZero", [0]],
      ["PutById", [0, 2, 0, 0, 0]],
      ["Jmp", [0]],
      ["LoadConstUInt8", [2, 2]],
      ["LoadConstZero", [0]],
      ["PutById", [0, 2, 0, 0, 0]],
      ["Ret", [0]],
    ]);
    const jumpFalse = program.offsetOf("JmpFalse");
    const elseStart = program.offsetOf("LoadConstUInt8", 1);
    const thenJump = program.offsetOf("Jmp");
    const join = program.offsetOf("Ret");
    program.bytes[jumpFalse + 1] = (elseStart - jumpFalse) & 0xff;
    program.bytes[thenJump + 1] = (join - thenJump) & 0xff;

    const { ast } = astOf(program.bytes);
    const fn = ast.functions[0];
    expect(fn?.structured).toBe(true);
    const ifStatement = fn?.statements.find(
      (statement) => statement.kind === "if",
    );
    expect(ifStatement?.kind).toBe("if");
    if (ifStatement?.kind !== "if") return;
    expect(renderHermesStatement(ifStatement)).toContain("a = 1");
    expect(renderHermesStatement(ifStatement)).toContain("} else {");
    expect(renderHermesStatement(ifStatement)).toContain("a = 2");
  });

  it("recovers a while loop from a header branch plus a back edge", () => {
    const program = emit([
      ["LoadConstZero", [1]],
      ["LoadConstUInt8", [2, 3]],
      ["JNotLess", [0, 1, 2]],
      ["LoadConstUInt8", [0, 1]],
      ["PutById", [0, 0, 0, 0, 0]],
      ["AddN", [1, 1, 2]],
      ["JLess", [0, 1, 2]],
      ["Ret", [0]],
    ]);
    const header = program.offsetOf("JNotLess");
    const exit = program.offsetOf("Ret");
    const bodyStart = program.offsetOf("LoadConstUInt8", 0);
    const back = program.offsetOf("JLess");
    program.bytes[header + 1] = (exit - header) & 0xff;
    program.bytes[back + 1] = (bodyStart - back) & 0xff;

    const { ast } = astOf(program.bytes);
    const fn = ast.functions[0];
    expect(fn?.structured).toBe(true);
    const loop = fn?.statements.find((statement) => statement.kind === "while");
    expect(loop?.kind).toBe("while");
    if (loop?.kind !== "while") return;
    expect(renderHermesStatement(loop)).toContain("while (");
    expect(renderHermesStatement(loop)).toContain("a = 1");
  });

  it("reports an unrecognised switch as an unknown statement instead of guessing", () => {
    const program = emit([
      ["LoadConstZero", [1]],
      ["SwitchImm", [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]],
      ["Ret", [0]],
    ]);
    const switchAt = program.offsetOf("SwitchImm");
    const ret = program.offsetOf("Ret");
    // Default target is the third operand: a 4-byte Addr32 after reg + table.
    const delta = ret - switchAt;
    program.bytes[switchAt + 6] = delta & 0xff;
    program.bytes[switchAt + 7] = (delta >> 8) & 0xff;
    program.bytes[switchAt + 8] = (delta >> 16) & 0xff;
    program.bytes[switchAt + 9] = (delta >> 24) & 0xff;

    const { ast } = astOf(program.bytes);
    const fn = ast.functions[0];
    expect(fn?.structured).toBe(false);
    expect(
      fn?.statements.some((statement) => statement.kind === "unknown"),
    ).toBe(true);
    expect(ast.unstructuredFunctions).toEqual([0]);
  });

  it("keeps a straight-line body structured and names unresolved registers", () => {
    const program = emit([
      ["LoadConstUInt8", [0, 7]],
      ["Ret", [0]],
    ]);
    const { ast } = astOf(program.bytes);
    const fn = ast.functions[0];
    expect(fn?.structured).toBe(true);
    expect(
      fn?.statements.map((statement) => renderHermesStatement(statement)),
    ).toEqual(["return 7;"]);
  });
});

describe("hermes switch recovery", () => {
  it("reads the dispatch table, groups case values and keeps the default arm", () => {
    const table: number[] = [];
    const pushInt32 = (value: number) => {
      table.push(
        value & 0xff,
        (value >> 8) & 0xff,
        (value >> 16) & 0xff,
        (value >> 24) & 0xff,
      );
    };
    pushInt32(26);
    pushInt32(31);
    const program = [
      opcode("AsyncBreakCheck"),
      opcode("SwitchImm"),
      1,
      18,
      0,
      0,
      0,
      36,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      1,
      0,
      0,
      0,
      ...table,
      opcode("LoadConstUInt8"),
      0,
      10,
      opcode("Ret"),
      0,
      opcode("LoadConstUInt8"),
      0,
      20,
      opcode("Ret"),
      0,
      opcode("LoadConstUInt8"),
      0,
      30,
      opcode("Ret"),
      0,
    ];
    const { ast } = astOf(program);
    const fn = ast.functions[0];
    expect(fn?.structured).toBe(true);
    const statement = fn?.statements.find((entry) => entry.kind === "switch");
    expect(statement?.kind).toBe("switch");
    if (statement?.kind !== "switch") return;
    expect(statement.cases.map((entry) => entry.values)).toEqual([[0], [1]]);
    expect(
      statement.cases.map((entry) =>
        entry.body.map((body) => renderHermesStatement(body)),
      ),
    ).toEqual([["return 10;"], ["return 20;"]]);
    expect(
      statement.defaultBody.map((body) => renderHermesStatement(body)),
    ).toEqual(["return 30;"]);
    expect(renderHermesStatement(statement)).toContain("case 0:");
    expect(renderHermesStatement(statement)).toContain("default:");
  });
});
