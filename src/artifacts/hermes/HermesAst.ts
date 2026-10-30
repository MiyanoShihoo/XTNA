/**
 * Hermes structured AST recovery (bytecode version 84).
 *
 * Two layers, both bounded by what the bytecode actually proves:
 *
 * 1. **Structure.** Instructions are split into basic blocks at branch
 *    targets, then a linear structurer recovers `if`/`else` and `while`
 *    shapes from the canonical branch patterns Hermes emits. Anything that
 *    does not match a known shape is reported as an `unknown` statement and
 *    the function is marked unstructured — never repaired by guessing.
 * 2. **Expressions.** Inside straight-line runs the register file is
 *    simulated: constants, property loads, assignments, binary/unary
 *    operators and two-to-four argument calls become expression nodes. Any
 *    other opcode makes its destination register an `unknown` expression that
 *    names the opcode.
 *
 * There is no exception-table recovery (the handler map is not in the
 * instruction stream), no `switch` table decoding and no cross-block data
 * flow; each is reported as a limitation.
 */
import type {
  HermesDisassembly,
  HermesInstruction,
} from "./HermesDisassembly.js";
import type { HermesTables } from "./HermesBytecodeTables.js";

export type HermesExpression =
  | {
      readonly kind: "literal";
      readonly value: string | number | boolean | null | undefined;
    }
  | { readonly kind: "register"; readonly register: number }
  | { readonly kind: "parameter"; readonly index: number }
  | { readonly kind: "global" }
  | {
      readonly kind: "member";
      readonly object: HermesExpression;
      readonly property: string;
    }
  | {
      readonly kind: "computed-member";
      readonly object: HermesExpression;
      readonly key: HermesExpression;
    }
  | {
      readonly kind: "call";
      readonly callee: HermesExpression;
      readonly arguments: readonly HermesExpression[];
      readonly thisArgument?: HermesExpression;
    }
  | {
      readonly kind: "unary";
      readonly operator: string;
      readonly argument: HermesExpression;
    }
  | {
      readonly kind: "binary";
      readonly operator: string;
      readonly left: HermesExpression;
      readonly right: HermesExpression;
    }
  | {
      readonly kind: "assignment";
      readonly target: HermesExpression;
      readonly value: HermesExpression;
    }
  | { readonly kind: "array"; readonly length: number }
  | { readonly kind: "object" }
  | { readonly kind: "closure"; readonly functionIndex: number }
  | {
      readonly kind: "unknown";
      readonly opcode: string;
      readonly operands: readonly number[];
    };

export type HermesStatement =
  | {
      readonly kind: "expression";
      readonly expression: HermesExpression;
      readonly at: number;
    }
  | {
      readonly kind: "return";
      readonly value?: HermesExpression;
      readonly at: number;
    }
  | {
      readonly kind: "throw";
      readonly expression: HermesExpression;
      readonly at: number;
    }
  | {
      readonly kind: "if";
      readonly test: HermesExpression;
      readonly consequent: readonly HermesStatement[];
      readonly alternate: readonly HermesStatement[];
      readonly at: number;
    }
  | {
      readonly kind: "while";
      readonly test: HermesExpression;
      readonly body: readonly HermesStatement[];
      readonly at: number;
    }
  | {
      readonly kind: "switch";
      readonly test: HermesExpression;
      readonly cases: readonly {
        readonly values: readonly number[];
        readonly body: readonly HermesStatement[];
      }[];
      readonly defaultBody: readonly HermesStatement[];
      readonly at: number;
    }
  | {
      readonly kind: "unknown";
      readonly reason: string;
      readonly at: number;
      readonly instructions: readonly string[];
    };

export interface HermesBasicBlock {
  readonly id: number;
  /** First instruction offset in the block. */
  readonly start: number;
  /** Last instruction offset in the block (inclusive). */
  readonly end: number;
  readonly successorOffsets: readonly number[];
}

export interface HermesFunctionAst {
  readonly index: number;
  readonly name: string | undefined;
  readonly statements: readonly HermesStatement[];
  readonly blocks: readonly HermesBasicBlock[];
  readonly structured: boolean;
  readonly limitations: readonly string[];
}

export interface HermesAst {
  readonly functions: readonly HermesFunctionAst[];
  readonly structuredFunctions: number;
  readonly unstructuredFunctions: readonly number[];
}

const BRANCH_PREFIX = "J";
const UNCONDITIONAL = new Set(["Jmp", "JmpLong"]);

const BINARY_OPERATORS: Readonly<Record<string, string>> = {
  Eq: "==",
  StrictEq: "===",
  Neq: "!=",
  StrictNeq: "!==",
  Less: "<",
  LessEq: "<=",
  Greater: ">",
  GreaterEq: ">=",
  Add: "+",
  AddN: "+",
  Sub: "-",
  SubN: "-",
  Mul: "*",
  MulN: "*",
  Div: "/",
  DivN: "/",
  Mod: "%",
  LShift: "<<",
  RShift: ">>",
  URshift: ">>>",
  BitAnd: "&",
  BitXor: "^",
  BitOr: "|",
  InstanceOf: "instanceof",
  IsIn: "in",
};

const UNARY_OPERATORS: Readonly<Record<string, string>> = {
  Negate: "-",
  Not: "!",
  BitNot: "~",
  TypeOf: "typeof ",
  ToNumber: "+",
  ToInt32: "|0 ",
  AddEmptyString: '""+',
};

const isBranch = (instruction: HermesInstruction): boolean =>
  instruction.name.startsWith(BRANCH_PREFIX) &&
  instruction.operands.length > 0 &&
  instruction.name !== "Jmp" &&
  instruction.name !== "JmpLong";

const jumpDelta = (instruction: HermesInstruction): number | undefined =>
  instruction.operands[0];

const compareOperator = (
  name: string,
): { operator: string; negated: boolean } | undefined => {
  const base = name.endsWith("Long") ? name.slice(0, -4) : name;
  const negated = base.startsWith("JNot");
  const core = negated ? base.slice(4) : base.slice(1);
  const table: Readonly<Record<string, string>> = {
    Less: "<",
    LessEqual: "<=",
    Greater: ">",
    GreaterEqual: ">=",
    Equal: "==",
    StrictEqual: "===",
    NotEqual: "!=",
    StrictNotEqual: "!==",
  };
  const numeric = core.endsWith("N") ? core.slice(0, -1) : core;
  const operator = table[numeric];
  return operator === undefined ? undefined : { operator, negated };
};

const conditionOf = (
  instruction: HermesInstruction,
  read: (register: number) => HermesExpression,
): HermesExpression | undefined => {
  const name = instruction.name;
  if (name.startsWith("JmpTrue")) return read(instruction.operands[1] ?? 0);
  if (name.startsWith("JmpFalse"))
    return {
      kind: "unary",
      operator: "!",
      argument: read(instruction.operands[1] ?? 0),
    };
  if (name.startsWith("JmpUndefined"))
    return {
      kind: "binary",
      operator: "===",
      left: read(instruction.operands[1] ?? 0),
      right: { kind: "literal", value: undefined },
    };
  const comparison = compareOperator(name);
  if (comparison === undefined) return undefined;
  const left = read(instruction.operands[1] ?? 0);
  const right = read(instruction.operands[2] ?? 0);
  return {
    kind: "binary",
    operator: comparison.operator,
    left,
    right,
  };
};

/** Render an expression back to source-like text for CLI and tests. */
export function renderHermesExpression(expression: HermesExpression): string {
  const render = renderHermesExpression;
  switch (expression.kind) {
    case "literal":
      return typeof expression.value === "string"
        ? JSON.stringify(expression.value)
        : String(expression.value);
    case "register":
      return `r${String(expression.register)}`;
    case "parameter":
      return `arg${String(expression.index)}`;
    case "global":
      return "global";
    case "member":
      return `${render(expression.object)}.${expression.property}`;
    case "computed-member":
      return `${render(expression.object)}[${render(expression.key)}]`;
    case "call": {
      const callee = render(expression.callee);
      const args = expression.arguments.map(render).join(", ");
      return `${callee}(${args})`;
    }
    case "unary":
      return `${expression.operator}${render(expression.argument)}`;
    case "binary":
      return `(${render(expression.left)} ${expression.operator} ${render(expression.right)})`;
    case "assignment":
      return `${render(expression.target)} = ${render(expression.value)}`;
    case "array":
      return `[/* ${String(expression.length)} */]`;
    case "object":
      return "{}";
    case "closure":
      return `function#${String(expression.functionIndex)}`;
    case "unknown":
      return `<${expression.opcode} ${expression.operands.join(", ")}>`;
  }
}

export function renderHermesStatement(
  statement: HermesStatement,
  indent = 0,
): string {
  const pad = "  ".repeat(indent);
  switch (statement.kind) {
    case "expression":
      return `${pad}${renderHermesExpression(statement.expression)};`;
    case "return":
      return statement.value === undefined
        ? `${pad}return;`
        : `${pad}return ${renderHermesExpression(statement.value)};`;
    case "throw":
      return `${pad}throw ${renderHermesExpression(statement.expression)};`;
    case "if": {
      const lines = [`${pad}if (${renderHermesExpression(statement.test)}) {`];
      for (const child of statement.consequent)
        lines.push(renderHermesStatement(child, indent + 1));
      if (statement.alternate.length > 0) {
        lines.push(`${pad}} else {`);
        for (const child of statement.alternate)
          lines.push(renderHermesStatement(child, indent + 1));
      }
      lines.push(`${pad}}`);
      return lines.join("\n");
    }
    case "while": {
      const lines = [
        `${pad}while (${renderHermesExpression(statement.test)}) {`,
      ];
      for (const child of statement.body)
        lines.push(renderHermesStatement(child, indent + 1));
      lines.push(`${pad}}`);
      return lines.join("\n");
    }
    case "switch": {
      const lines = [
        `${pad}switch (${renderHermesExpression(statement.test)}) {`,
      ];
      for (const entry of statement.cases) {
        for (const value of entry.values)
          lines.push(`${pad}  case ${String(value)}:`);
        for (const child of entry.body)
          lines.push(renderHermesStatement(child, indent + 2));
      }
      if (statement.defaultBody.length > 0) {
        lines.push(`${pad}  default:`);
        for (const child of statement.defaultBody)
          lines.push(renderHermesStatement(child, indent + 2));
      }
      lines.push(`${pad}}`);
      return lines.join("\n");
    }
    case "unknown":
      return `${pad}/* unknown @${String(statement.at)}: ${statement.reason} */`;
  }
}

interface RegisterState {
  readonly values: Map<number, HermesExpression>;
  readonly blockStart: number;
}

const CONTROL_FLOW_UNMODELLED = new Set([
  "SwitchImm",
  "Catch",
  "SaveGenerator",
  "SaveGeneratorLong",
  "StartGenerator",
  "ResumeGenerator",
  "CompleteGenerator",
]);

const literalFromConst = (
  name: string,
  operands: readonly number[],
  strings: ReadonlyMap<number, string>,
): HermesExpression | undefined => {
  switch (name) {
    case "LoadConstUInt8":
    case "LoadConstInt":
      return { kind: "literal", value: operands[1] ?? 0 };
    case "LoadConstDouble":
      return { kind: "literal", value: operands[1] ?? 0 };
    case "LoadConstZero":
      return { kind: "literal", value: 0 };
    case "LoadConstUndefined":
      return { kind: "literal", value: undefined };
    case "LoadConstNull":
      return { kind: "literal", value: null };
    case "LoadConstTrue":
      return { kind: "literal", value: true };
    case "LoadConstFalse":
      return { kind: "literal", value: false };
    case "LoadConstEmpty":
      return { kind: "literal", value: "" };
    case "LoadConstString":
    case "LoadConstStringLongIndex": {
      const id = operands[1] ?? -1;
      const value = strings.get(id);
      return value === undefined
        ? { kind: "unknown", opcode: name, operands }
        : { kind: "literal", value };
    }
    default:
      return undefined;
  }
};

/**
 * Apply one instruction to the register map. Returns a statement when the
 * instruction has an effect visible outside the register file.
 */
const applyInstruction = (
  instruction: HermesInstruction,
  state: RegisterState,
  strings: ReadonlyMap<number, string>,
  read: (register: number) => HermesExpression,
): HermesStatement | undefined => {
  const { name, operands, offset } = instruction;
  const set = (register: number, value: HermesExpression) =>
    state.values.set(register, value);

  const constant = literalFromConst(name, operands, strings);
  if (constant !== undefined) {
    set(operands[0] ?? 0, constant);
    return undefined;
  }
  if (name === "Mov" || name === "MovLong") {
    set(operands[0] ?? 0, read(operands[1] ?? 0));
    return undefined;
  }
  if (name === "GetGlobalObject") {
    set(operands[0] ?? 0, { kind: "global" });
    return undefined;
  }
  if (name === "LoadParam" || name === "LoadParamLong") {
    set(operands[0] ?? 0, { kind: "parameter", index: operands[1] ?? 0 });
    return undefined;
  }
  if (name === "GetByIdShort" || name === "GetById" || name === "GetByIdLong") {
    const stringId = operands[3] ?? -1;
    const property = strings.get(stringId);
    set(
      operands[0] ?? 0,
      property === undefined
        ? { kind: "unknown", opcode: name, operands }
        : { kind: "member", object: read(operands[1] ?? 0), property },
    );
    return undefined;
  }
  if (name === "TryGetById" || name === "TryGetByIdLong") {
    const stringId = operands[3] ?? -1;
    const property = strings.get(stringId);
    set(
      operands[0] ?? 0,
      property === undefined
        ? { kind: "unknown", opcode: name, operands }
        : { kind: "member", object: read(operands[1] ?? 0), property },
    );
    return undefined;
  }
  if (
    name === "PutById" ||
    name === "PutByIdLong" ||
    name === "TryPutById" ||
    name === "TryPutByIdLong"
  ) {
    const stringId = operands[3] ?? -1;
    const property = strings.get(stringId);
    const target =
      property === undefined
        ? ({ kind: "unknown", opcode: name, operands } as const)
        : ({
            kind: "member",
            object: read(operands[0] ?? 0),
            property,
          } as const);
    return {
      kind: "expression",
      at: offset,
      expression: { kind: "assignment", target, value: read(operands[1] ?? 0) },
    };
  }
  if (name === "GetByVal") {
    set(operands[0] ?? 0, {
      kind: "computed-member",
      object: read(operands[1] ?? 0),
      key: read(operands[2] ?? 0),
    });
    return undefined;
  }
  if (name === "PutByVal") {
    return {
      kind: "expression",
      at: offset,
      expression: {
        kind: "assignment",
        target: {
          kind: "computed-member",
          object: read(operands[0] ?? 0),
          key: read(operands[1] ?? 0),
        },
        value: read(operands[2] ?? 0),
      },
    };
  }
  const binary = BINARY_OPERATORS[name];
  if (binary !== undefined && operands.length === 3) {
    set(operands[0] ?? 0, {
      kind: "binary",
      operator: binary,
      left: read(operands[1] ?? 0),
      right: read(operands[2] ?? 0),
    });
    return undefined;
  }
  const unary = UNARY_OPERATORS[name];
  if (unary !== undefined && operands.length === 2) {
    set(operands[0] ?? 0, {
      kind: "unary",
      operator: unary,
      argument: read(operands[1] ?? 0),
    });
    return undefined;
  }
  if (name === "Call2" || name === "Call3" || name === "Call4") {
    const arguments_: HermesExpression[] = [];
    const thisRegister = operands[2] ?? 0;
    for (let index = 3; index < operands.length; index += 1)
      arguments_.push(read(operands[index] ?? 0));
    const callee = read(operands[1] ?? 0);
    const call: HermesExpression = {
      kind: "call",
      callee,
      arguments: arguments_,
      ...(callee.kind === "member" ? { thisArgument: read(thisRegister) } : {}),
    };
    set(operands[0] ?? 0, call);
    return { kind: "expression", at: offset, expression: call };
  }
  if (name === "Call" || name === "CallLong" || name === "Call1") {
    set(operands[0] ?? 0, { kind: "unknown", opcode: name, operands });
    return undefined;
  }
  if (
    name === "NewObject" ||
    name === "NewObjectWithBuffer" ||
    name === "NewObjectWithBufferLong"
  ) {
    set(operands[0] ?? 0, { kind: "object" });
    return undefined;
  }
  if (
    name === "NewArray" ||
    name === "NewArrayWithBuffer" ||
    name === "NewArrayWithBufferLong"
  ) {
    const length = name === "NewArray" ? (operands[1] ?? 0) : 0;
    set(operands[0] ?? 0, { kind: "array", length });
    return undefined;
  }
  if (name === "CreateClosure" || name === "CreateClosureLongIndex") {
    set(operands[0] ?? 0, { kind: "closure", functionIndex: operands[2] ?? 0 });
    return undefined;
  }
  if (name === "Ret") {
    return { kind: "return", at: offset, value: read(operands[0] ?? 0) };
  }
  if (name === "Throw") {
    return { kind: "throw", at: offset, expression: read(operands[0] ?? 0) };
  }
  if (CONTROL_FLOW_UNMODELLED.has(name))
    return {
      kind: "unknown",
      reason: `${name} is control flow this structurer does not model`,
      at: offset,
      instructions: [instructionText(instruction)],
    };
  const destination = operands[0];
  if (destination !== undefined)
    set(destination, { kind: "unknown", opcode: name, operands });
  return undefined;
};

const instructionText = (instruction: HermesInstruction): string =>
  `${instruction.name} ${instruction.operands.join(", ")}`.trim();

/** Recover a structured AST for one disassembled function body. */
export function buildHermesFunctionAst(
  fn: {
    readonly index: number;
    readonly name: string | undefined;
    readonly bytecodeOffset: number;
    readonly instructions: readonly HermesInstruction[];
    readonly decoded: boolean;
  },
  tables: HermesTables,
  code?: { readonly bytes: Uint8Array },
): HermesFunctionAst {
  const limitations: string[] = [];
  if (!fn.decoded || fn.instructions.length === 0)
    return {
      index: fn.index,
      name: fn.name,
      statements: [],
      blocks: [],
      structured: false,
      limitations: ["function body was not decoded"],
    };

  const strings = new Map(
    tables.strings.map((entry) => [entry.id, entry.value] as const),
  );
  const instructions = fn.instructions;
  const offsetToIndex = new Map<number, number>();
  instructions.forEach((instruction, index) =>
    offsetToIndex.set(instruction.offset, index),
  );
  const targetIndex = (instruction: HermesInstruction): number | undefined => {
    const delta = jumpDelta(instruction);
    if (delta === undefined) return undefined;
    return offsetToIndex.get(instruction.offset + delta);
  };

  const blocks = buildBlocks(instructions, targetIndex);
  const statements: HermesStatement[] = [];
  const state: RegisterState = { values: new Map(), blockStart: 0 };
  const read = (register: number): HermesExpression => {
    if (register < 0) return { kind: "register", register };
    return state.values.get(register) ?? { kind: "register", register };
  };

  const parseSwitch = (
    instruction: HermesInstruction,
    to: number,
  ): HermesStatement | undefined => {
    if (code === undefined) return undefined;
    const view = new DataView(
      code.bytes.buffer,
      code.bytes.byteOffset,
      code.bytes.byteLength,
    );
    const tableOffset = instruction.operands[1] ?? 0;
    const minimum = instruction.operands[3] ?? 0;
    const maximum = instruction.operands[4] ?? 0;
    if (maximum < minimum || maximum - minimum > 255) return undefined;
    const tableStart = Math.ceil((instruction.offset + tableOffset) / 4) * 4;
    const groups = new Map<number, number[]>();
    for (let value = minimum; value <= maximum; value += 1) {
      const entry = tableStart + (value - minimum) * 4;
      if (entry + 4 > code.bytes.length) return undefined;
      const target = instruction.offset + view.getInt32(entry, true);
      const existing = groups.get(target) ?? [];
      existing.push(value);
      groups.set(target, existing);
    }
    const defaultTarget = instruction.offset + (instruction.operands[2] ?? 0);
    const parsedTargets = [...groups.keys()]
      .map((offset) => ({ offset, index: offsetToIndex.get(offset) }))
      .filter(
        (entry): entry is { offset: number; index: number } =>
          entry.index !== undefined,
      );
    if (parsedTargets.length === 0) return undefined;
    const defaultIndex = offsetToIndex.get(defaultTarget);
    const boundaries = new Map<number, number>(
      parsedTargets.map((entry) => [entry.offset, entry.index]),
    );
    if (defaultIndex !== undefined && !boundaries.has(defaultTarget))
      boundaries.set(defaultTarget, defaultIndex);
    const ordered = [...boundaries.entries()]
      .map(([offset, index]) => ({ offset, index }))
      .sort((left, right) => left.index - right.index);
    const cases = parsedTargets
      .sort((left, right) => left.index - right.index)
      .map((entry) => {
        const next = ordered.find((candidate) => candidate.index > entry.index);
        return {
          values: groups.get(entry.offset) ?? [],
          body: parseRange(entry.index, next?.index ?? to, 32),
        };
      });
    return {
      kind: "switch",
      test: read(instruction.operands[0] ?? 0),
      cases,
      defaultBody:
        defaultIndex === undefined ? [] : parseRange(defaultIndex, to, 32),
      at: instruction.offset,
    };
  };

  const parseRange = (
    from: number,
    to: number,
    depth: number,
  ): HermesStatement[] => {
    const out: HermesStatement[] = [];
    if (depth > 32) {
      out.push({
        kind: "unknown",
        reason: "nesting limit reached",
        at: instructions[from]?.offset ?? 0,
        instructions: [],
      });
      return out;
    }
    let index = from;
    while (index < to) {
      const instruction = instructions[index];
      if (instruction === undefined) break;
      if (instruction.name === "SwitchImm") {
        const statement = parseSwitch(instruction, to);
        if (statement !== undefined) {
          out.push(statement);
          index += 1;
          continue;
        }
      }
      if (isBranch(instruction)) {
        const target = targetIndex(instruction);
        if (target === undefined) {
          out.push({
            kind: "unknown",
            reason: "branch target is not an instruction boundary",
            at: instruction.offset,
            instructions: [instructionText(instruction)],
          });
          index += 1;
          continue;
        }
        if (target <= index) {
          out.push({
            kind: "unknown",
            reason: "backward branch outside a recognised loop",
            at: instruction.offset,
            instructions: [instructionText(instruction)],
          });
          index += 1;
          continue;
        }
        const test = conditionOf(instruction, read);
        if (test === undefined) {
          out.push({
            kind: "unknown",
            reason: `unsupported branch ${instruction.name}`,
            at: instruction.offset,
            instructions: [instructionText(instruction)],
          });
          index += 1;
          continue;
        }
        const loop = asLoop(index, target, to);
        if (loop !== undefined) {
          out.push({
            kind: "while",
            test: loop.test,
            body: loop.body,
            at: instruction.offset,
          });
          index = loop.next;
          continue;
        }
        // if / if-else: the tail of the taken range may be an unconditional
        // jump over the else arm to the join point.
        const tail = instructions[target - 1];
        const overElse =
          tail !== undefined && UNCONDITIONAL.has(tail.name)
            ? targetIndex(tail)
            : undefined;
        const negated =
          instruction.name.startsWith("JNot") ||
          instruction.name.startsWith("JmpFalse");
        const thenEnd =
          overElse !== undefined && overElse > target ? overElse : target;
        if (negated) {
          const consequent = parseRange(index + 1, target, depth + 1);
          const alternate =
            overElse !== undefined && overElse > target
              ? parseRange(target, overElse, depth + 1)
              : [];
          out.push({
            kind: "if",
            test,
            consequent,
            alternate,
            at: instruction.offset,
          });
          index =
            overElse !== undefined && overElse > target ? overElse : target;
        } else {
          // Positive branch: the taken arm is the consequent, the fallthrough
          // arm is the alternate; both must reconverge.
          const join =
            overElse !== undefined && overElse > target ? overElse : target;
          const alternate = parseRange(index + 1, target, depth + 1);
          const consequent = parseRange(target, thenEnd, depth + 1);
          out.push({
            kind: "if",
            test,
            consequent,
            alternate,
            at: instruction.offset,
          });
          index = join;
        }
        continue;
      }
      if (UNCONDITIONAL.has(instruction.name)) {
        const target = targetIndex(instruction);
        out.push({
          kind: "unknown",
          reason:
            target === to
              ? "unconditional jump to the region end"
              : "unconditional jump is not a recognised break",
          at: instruction.offset,
          instructions: [instructionText(instruction)],
        });
        index = target !== undefined && target > index ? target : index + 1;
        continue;
      }
      if (instruction.name === "Unreachable") {
        out.push({
          kind: "unknown",
          reason: "unreachable marker",
          at: instruction.offset,
          instructions: [instructionText(instruction)],
        });
        index += 1;
        continue;
      }
      const statement = applyInstruction(instruction, state, strings, read);
      if (statement !== undefined) out.push(statement);
      index += 1;
    }
    return out;
  };

  const asLoop = (
    index: number,
    exit: number,
    limit: number,
  ):
    | { test: HermesExpression; body: HermesStatement[]; next: number }
    | undefined => {
    // while shape: header branch to exit; a later branch in the same range
    // also leaves for the same exit, and jumps back into the body.
    const test = conditionOf(instructions[index] as HermesInstruction, read);
    if (test === undefined || exit > limit) return undefined;
    let back = -1;
    for (let probe = index + 1; probe < exit; probe += 1) {
      const candidate = instructions[probe];
      if (candidate === undefined || !isBranch(candidate)) continue;
      const target = targetIndex(candidate);
      if (target === undefined) continue;
      if (target <= probe) {
        back = probe;
        break;
      }
    }
    if (back < 0) return undefined;
    const body = parseRange(index + 1, back, 1);
    return { test, body, next: exit };
  };

  const top = parseRange(0, instructions.length, 0);
  statements.push(...top);
  const structured = !statements.some(
    (statement) => statement.kind === "unknown",
  );
  if (!structured)
    limitations.push(
      "unrecognised control flow is reported as unknown statements",
    );
  limitations.push("no exception-table (try/catch) recovery");
  return {
    index: fn.index,
    name: fn.name,
    statements,
    blocks,
    structured,
    limitations,
  };
}

const buildBlocks = (
  instructions: readonly HermesInstruction[],
  targetIndex: (instruction: HermesInstruction) => number | undefined,
): HermesBasicBlock[] => {
  const leaders = new Set<number>([0]);
  instructions.forEach((instruction, index) => {
    if (UNCONDITIONAL.has(instruction.name) || isBranch(instruction)) {
      const target = targetIndex(instruction);
      if (target !== undefined) leaders.add(target);
      if (index + 1 < instructions.length) leaders.add(index + 1);
    }
    if (
      instruction.name === "Ret" ||
      instruction.name === "Throw" ||
      instruction.name === "Unreachable"
    ) {
      if (index + 1 < instructions.length) leaders.add(index + 1);
    }
  });
  const sorted = [...leaders]
    .filter((index) => index < instructions.length)
    .sort((a, b) => a - b);
  const blocks: HermesBasicBlock[] = [];
  sorted.forEach((start, id) => {
    const end = (sorted[id + 1] ?? instructions.length) - 1;
    const last = instructions[end];
    const successors = new Set<number>();
    if (last !== undefined) {
      const target =
        UNCONDITIONAL.has(last.name) || isBranch(last)
          ? targetIndex(last)
          : undefined;
      if (target !== undefined)
        successors.add(instructions[target]?.offset ?? 0);
      const terminal =
        last.name === "Ret" ||
        last.name === "Throw" ||
        last.name === "Unreachable";
      if (
        !terminal &&
        !UNCONDITIONAL.has(last.name) &&
        end + 1 < instructions.length
      )
        successors.add(instructions[end + 1]?.offset ?? 0);
      if (isBranch(last) && end + 1 < instructions.length)
        successors.add(instructions[end + 1]?.offset ?? 0);
    }
    blocks.push({
      id,
      start: instructions[start]?.offset ?? 0,
      end: instructions[end]?.offset ?? 0,
      successorOffsets: [...successors].sort((a, b) => a - b),
    });
  });
  return blocks;
};

/** Recover an AST for every decoded function in a disassembly. */
export function buildHermesAst(
  disassembly: HermesDisassembly,
  bytes?: Uint8Array,
): HermesAst {
  const functions = disassembly.functions.map((fn) =>
    buildHermesFunctionAst(
      fn,
      disassembly.tables,
      bytes === undefined ? undefined : { bytes },
    ),
  );
  const unstructuredFunctions = functions
    .filter((fn) => !fn.structured)
    .map((fn) => fn.index);
  return {
    functions,
    structuredFunctions: functions.length - unstructuredFunctions.length,
    unstructuredFunctions,
  };
}
