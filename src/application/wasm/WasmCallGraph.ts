/**
 * Intra-module call graph for WebAssembly.
 *
 * Decodes the function body section far enough to find `call` and
 * `call_indirect` sites and the function index each one targets. Every other
 * instruction's operands are skipped with an explicit opcode table; an opcode
 * the table does not know (SIMD, atomics, future proposals) marks the whole
 * function undecoded instead of guessing where the next instruction starts.
 *
 * This is a static structural reading of the module. It does not execute the
 * module, resolve `call_indirect` targets, or claim that any edge is reachable
 * at runtime.
 */
import { err, ok, type Result } from "../../domain/result.js";

export interface WasmFunctionFact {
  readonly index: number;
  readonly name: string | undefined;
  readonly imported: boolean;
  /** Number of decoded call sites inside this function. */
  readonly callSites: number;
  /** True when an unknown opcode stopped decoding for this function. */
  readonly undecoded: boolean;
  /** Opcode that stopped decoding, e.g. `0xfd/0x2d`; absent when decoded. */
  readonly undecodedAt: string | undefined;
}

export interface WasmCallEdge {
  readonly from: number;
  /** `null` for `call_indirect`, whose target depends on the table at runtime. */
  readonly to: number | null;
  readonly kind: "direct" | "indirect";
  /** Type index of the `call_indirect` site, when present. */
  readonly typeIndex?: number;
}

export interface WasmCallGraph {
  readonly functions: readonly WasmFunctionFact[];
  readonly edges: readonly WasmCallEdge[];
  readonly importedFunctions: number;
  readonly undecodedFunctions: readonly number[];
  readonly truncated: boolean;
}

export interface WasmCallGraphError {
  readonly code: "not-wasm" | "malformed" | "too-large";
  readonly message: string;
}

const MAX_FUNCTIONS = 5_000;
const MAX_EDGES = 20_000;

class Reader {
  readonly bytes: Uint8Array;
  offset = 0;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
  }

  get remaining(): number {
    return this.bytes.length - this.offset;
  }

  byte(): number {
    if (this.remaining < 1) throw new Error("truncated byte");
    return this.bytes[this.offset++] ?? 0;
  }

  uleb(): number {
    let result = 0;
    let shift = 0;
    for (;;) {
      const byte = this.byte();
      result += (byte & 0x7f) * 2 ** shift;
      if ((byte & 0x80) === 0) break;
      shift += 7;
      if (shift > 70) throw new Error("uleb overflow");
    }
    return result;
  }

  sleb(): number {
    let result = 0;
    let shift = 0;
    let byte = 0;
    do {
      byte = this.byte();
      result += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (shift > 70) throw new Error("sleb overflow");
    } while ((byte & 0x80) !== 0);
    return result;
  }

  skip(count: number): void {
    if (count < 0 || this.remaining < count) throw new Error("truncated skip");
    this.offset += count;
  }

  sub(count: number): Reader {
    if (count < 0 || this.remaining < count)
      throw new Error("truncated section");
    const view = new Reader(
      this.bytes.subarray(this.offset, this.offset + count),
    );
    this.offset += count;
    return view;
  }
}

interface Section {
  readonly id: number;
  readonly body: Reader;
}

const sectionsOf = (reader: Reader): Section[] => {
  const magic =
    reader.byte() |
    (reader.byte() << 8) |
    (reader.byte() << 16) |
    (reader.byte() << 24);
  if (magic !== 0x6d736100) throw new Error("bad magic");
  reader.skip(4);
  const sections: Section[] = [];
  while (reader.remaining > 0) {
    const id = reader.byte();
    const size = reader.uleb();
    sections.push({ id, body: reader.sub(size) });
  }
  return sections;
};

/** Import entries are skipped; only function imports change the index space. */
const countFunctionImports = (body: Reader): number => {
  const total = body.uleb();
  let functions = 0;
  for (let index = 0; index < total; index += 1) {
    const moduleLength = body.uleb();
    body.skip(moduleLength);
    const fieldLength = body.uleb();
    body.skip(fieldLength);
    const kind = body.byte();
    if (kind === 0x00) {
      body.uleb();
      functions += 1;
    } else if (kind === 0x01) {
      body.byte();
      const limits = body.byte();
      body.uleb();
      if ((limits & 0x01) !== 0) body.uleb();
    } else if (kind === 0x02) {
      const limits = body.byte();
      body.uleb();
      if ((limits & 0x01) !== 0) body.uleb();
    } else if (kind === 0x03) {
      body.byte();
      body.byte();
    } else throw new Error("unknown import kind");
  }
  return functions;
};

const exportNames = (body: Reader): Map<number, string> => {
  const names = new Map<number, string>();
  const total = body.uleb();
  for (let index = 0; index < total; index += 1) {
    const length = body.uleb();
    const name = Buffer.from(
      body.bytes.subarray(body.offset, body.offset + length),
    ).toString("utf8");
    body.skip(length);
    const kind = body.byte();
    const target = body.uleb();
    if (kind === 0x00) names.set(target, name);
  }
  return names;
};

/**
 * Operand kinds for the opcodes whose bodies this decoder skips. `call` and
 * `call_indirect` are handled separately because they produce edges.
 */
type Operand =
  | "none"
  | "blocktype"
  | "u32"
  | "u32x2"
  | "br_table"
  | "memarg"
  | "byte"
  | "i32"
  | "i64"
  | "f32"
  | "f64"
  | "vec"
  | "ref"
  | "bytes16"
  | "memarg_lane";

const CORE_OPERANDS = new Map<number, Operand>([
  [0x00, "none"],
  [0x01, "none"],
  [0x02, "blocktype"],
  [0x03, "blocktype"],
  [0x04, "blocktype"],
  [0x05, "none"],
  [0x0b, "none"],
  [0x0c, "u32"],
  [0x0d, "u32"],
  [0x0e, "br_table"],
  [0x0f, "none"],
  [0x12, "u32"],
  [0x13, "u32x2"],
  [0x1a, "none"],
  [0x1b, "none"],
  [0x1c, "vec"],
  [0x20, "u32"],
  [0x21, "u32"],
  [0x22, "u32"],
  [0x23, "u32"],
  [0x24, "u32"],
  [0x25, "u32"],
  [0x26, "u32"],
  [0x3f, "byte"],
  [0x40, "byte"],
  [0x41, "i32"],
  [0x42, "i64"],
  [0x43, "f32"],
  [0x44, "f64"],
  [0xd0, "ref"],
  [0xd1, "none"],
  [0xd2, "u32"],
]);

for (let opcode = 0x28; opcode <= 0x3e; opcode += 1)
  CORE_OPERANDS.set(opcode, "memarg");
for (let opcode = 0x45; opcode <= 0xc4; opcode += 1)
  if (!CORE_OPERANDS.has(opcode)) CORE_OPERANDS.set(opcode, "none");

const skipOperand = (reader: Reader, operand: Operand): void => {
  switch (operand) {
    case "none":
      return;
    case "blocktype": {
      const byte = reader.byte();
      // 0x40 (empty) and value types fit in one byte; a type index is signed LEB.
      if ((byte & 0x80) !== 0) {
        reader.sleb();
      }
      return;
    }
    case "u32":
      reader.uleb();
      return;
    case "u32x2":
      reader.uleb();
      reader.uleb();
      return;
    case "br_table": {
      const count = reader.uleb();
      for (let index = 0; index <= count; index += 1) reader.uleb();
      return;
    }
    case "memarg":
      reader.uleb();
      reader.uleb();
      return;
    case "byte":
      reader.byte();
      return;
    case "i32":
      reader.sleb();
      return;
    case "i64":
      reader.sleb();
      return;
    case "f32":
      reader.skip(4);
      return;
    case "f64":
      reader.skip(8);
      return;
    case "vec": {
      const count = reader.uleb();
      for (let index = 0; index < count; index += 1) reader.byte();
      return;
    }
    case "ref": {
      const type = reader.byte();
      if (type === 0x63 || type === 0x64) reader.sleb();
      return;
    }
    case "bytes16":
      reader.skip(16);
      return;
    case "memarg_lane":
      reader.uleb();
      reader.uleb();
      reader.byte();
      return;
  }
};

/**
 * SIMD sub-opcodes whose immediates are unambiguous. Anything outside this table
 * (including 0x2D and above) stops the function as undecoded; the body-length
 * check below rejects a skip that landed on the wrong boundary.
 */
const PREFIX_FD: Record<number, Operand> = {};
for (let sub = 0x00; sub <= 0x0b; sub += 1) PREFIX_FD[sub] = "memarg";
PREFIX_FD[0x0c] = "bytes16";
PREFIX_FD[0x0d] = "bytes16";
for (let sub = 0x0e; sub <= 0x14; sub += 1) PREFIX_FD[sub] = "none";
for (let sub = 0x15; sub <= 0x22; sub += 1) PREFIX_FD[sub] = "byte";
for (let sub = 0x23; sub <= 0x53; sub += 1) PREFIX_FD[sub] = "none";
for (let sub = 0x54; sub <= 0x5b; sub += 1) PREFIX_FD[sub] = "memarg_lane";
PREFIX_FD[0x5c] = "memarg";
PREFIX_FD[0x5d] = "memarg";
for (let sub = 0x5e; sub <= 0xff; sub += 1) PREFIX_FD[sub] = "none";

const PREFIX_FC: Record<number, Operand | "unknown"> = {
  0: "none",
  1: "none",
  2: "none",
  3: "none",
  4: "none",
  5: "none",
  6: "none",
  7: "none",
  8: "u32x2",
  9: "u32",
  10: "u32x2",
  11: "u32",
  12: "u32x2",
  13: "u32",
  14: "u32x2",
  15: "u32",
  16: "u32",
  17: "u32",
};

interface DecodedBody {
  readonly edges: readonly WasmCallEdge[];
  readonly undecoded: boolean;
  readonly undecodedAt?: string;
}

const decodeBody = (
  body: Reader,
  functionIndex: number,
  budget: { edges: number },
): DecodedBody => {
  const edges: WasmCallEdge[] = [];
  const localGroups = body.uleb();
  for (let index = 0; index < localGroups; index += 1) {
    body.uleb();
    body.byte();
  }
  let depth = 0;
  while (body.remaining > 0) {
    const opcode = body.byte();
    if (opcode === 0x10 || opcode === 0x12) {
      const target = body.uleb();
      if (budget.edges < MAX_EDGES) {
        edges.push({ from: functionIndex, to: target, kind: "direct" });
        budget.edges += 1;
      }
      continue;
    }
    if (opcode === 0x11 || opcode === 0x13) {
      const typeIndex = body.uleb();
      body.uleb();
      if (budget.edges < MAX_EDGES) {
        edges.push({
          from: functionIndex,
          to: null,
          kind: "indirect",
          typeIndex,
        });
        budget.edges += 1;
      }
      continue;
    }
    if (opcode === 0x02 || opcode === 0x03 || opcode === 0x04) {
      skipOperand(body, "blocktype");
      depth += 1;
      continue;
    }
    if (opcode === 0x0b) {
      if (depth === 0) break;
      depth -= 1;
      continue;
    }
    if (opcode === 0xfc) {
      const sub = body.uleb();
      const operand = PREFIX_FC[sub];
      if (operand === undefined || operand === "unknown")
        return {
          edges,
          undecoded: true,
          undecodedAt: `0xfc/${sub.toString(16)}`,
        };
      skipOperand(body, operand);
      continue;
    }
    if (opcode === 0xfd) {
      const sub = body.uleb();
      const operand = PREFIX_FD[sub];
      if (operand === undefined)
        return {
          edges,
          undecoded: true,
          undecodedAt: `0xfd/${sub.toString(16)}`,
        };
      skipOperand(body, operand);
      continue;
    }
    if (opcode === 0xfe)
      return {
        edges,
        undecoded: true,
        undecodedAt: `0xfe/${body.uleb().toString(16)}`,
      };
    const operand = CORE_OPERANDS.get(opcode);
    if (operand === undefined)
      return {
        edges,
        undecoded: true,
        undecodedAt: `0x${opcode.toString(16)}`,
      };
    skipOperand(body, operand);
  }
  if (body.remaining !== 0)
    return { edges, undecoded: true, undecodedAt: "body-length-mismatch" };
  return { edges, undecoded: false };
};

/** Read the module's function index space and every decoded call edge. */
export function readWasmCallGraph(
  bytes: Uint8Array,
): Result<WasmCallGraph, WasmCallGraphError> {
  if (bytes.length < 8)
    return err({
      code: "not-wasm",
      message: "File is shorter than a wasm header.",
    });
  const reader = new Reader(bytes);
  let sections: Section[];
  try {
    sections = sectionsOf(reader);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return err({
      code: message === "bad magic" ? "not-wasm" : "malformed",
      message: `Cannot read wasm sections: ${message}`,
    });
  }
  let importedFunctions = 0;
  let declaredFunctions = 0;
  const names = new Map<number, string>();
  let code: Section | undefined;
  try {
    for (const section of sections) {
      if (section.id === 1) {
        const count = section.body.uleb();
        for (let index = 0; index < count; index += 1) {
          section.body.byte();
          const params = section.body.uleb();
          for (let param = 0; param < params; param += 1) section.body.byte();
          const results = section.body.uleb();
          for (let result = 0; result < results; result += 1)
            section.body.byte();
        }
      } else if (section.id === 2) {
        importedFunctions = countFunctionImports(section.body);
      } else if (section.id === 3) {
        declaredFunctions = section.body.uleb();
      } else if (section.id === 7) {
        for (const [index, name] of exportNames(section.body))
          names.set(index, name);
      } else if (section.id === 10) {
        code = section;
      }
    }
  } catch (error) {
    return err({
      code: "malformed",
      message: `Cannot read wasm tables: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
  const total = importedFunctions + declaredFunctions;
  if (total > MAX_FUNCTIONS)
    return err({
      code: "too-large",
      message: `Module declares ${String(total)} functions; the decoder stops at ${String(MAX_FUNCTIONS)}.`,
    });
  if (code === undefined)
    return ok({
      functions: [],
      edges: [],
      importedFunctions,
      undecodedFunctions: [],
      truncated: false,
    });
  const functions: WasmFunctionFact[] = [];
  const edges: WasmCallEdge[] = [];
  const undecodedFunctions: number[] = [];
  let bodyOffset = 0;
  const budget = { edges: 0 };
  try {
    const bodies = code.body.uleb();
    for (let index = 0; index < bodies; index += 1) {
      const size = code.body.uleb();
      const body = code.body.sub(size);
      const functionIndex = importedFunctions + index;
      bodyOffset = body.offset;
      const decoded = decodeBody(body, functionIndex, budget);
      edges.push(...decoded.edges);
      if (decoded.undecoded) undecodedFunctions.push(functionIndex);
      functions.push({
        index: functionIndex,
        name: names.get(functionIndex),
        imported: false,
        callSites: decoded.edges.length,
        undecoded: decoded.undecoded,
        undecodedAt: decoded.undecodedAt,
      });
    }
  } catch (error) {
    return err({
      code: "malformed",
      message: `Cannot decode a function body near byte ${String(bodyOffset)}: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
  return ok({
    functions,
    edges,
    importedFunctions,
    undecodedFunctions,
    truncated: budget.edges >= MAX_EDGES,
  });
}
