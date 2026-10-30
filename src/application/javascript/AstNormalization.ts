import { parse } from "@babel/parser";
import type { Node } from "@babel/types";
import {
  isBinaryExpression,
  isBooleanLiteral,
  isConditionalExpression,
  isIfStatement,
  isLogicalExpression,
  isNullLiteral,
  isNumericLiteral,
  isStringLiteral,
  isUnaryExpression,
} from "@babel/types";

import { err, ok, type Result } from "../../domain/result.js";

export interface AstNormalizationStats {
  readonly foldedConstants: number;
  readonly removedBranches: number;
  readonly decodedStrings: number;
  readonly passes: number;
}

export interface AstNormalizationLimits {
  readonly maxSourceBytes: number;
  readonly maxOutputBytes: number;
  readonly maxPasses: number;
  readonly maxNodes: number;
  readonly maxObservations: number;
}

export interface AstNormalizationOptions {
  readonly maxSourceBytes?: number;
  readonly maxOutputBytes?: number;
  readonly maxPasses?: number;
  readonly maxNodes?: number;
  readonly maxObservations?: number;
  readonly sourceType?: "script" | "module" | "unambiguous";
}

export type AstNormalizationError =
  | {
      readonly code: "invalid_options";
      readonly message: string;
      readonly option: string;
    }
  | {
      readonly code: "source_too_large";
      readonly message: string;
      readonly actual: number;
      readonly limit: number;
    }
  | {
      readonly code: "parse_failed";
      readonly message: string;
      readonly diagnostics: readonly string[];
    }
  | {
      readonly code: "node_limit_exceeded";
      readonly message: string;
      readonly limit: number;
    }
  | {
      readonly code: "output_too_large";
      readonly message: string;
      readonly actual: number;
      readonly limit: number;
    };

export interface AstNormalizationObservation {
  readonly kind: "constant-folded" | "dead-branch-removed" | "string-decoded";
  readonly pass: number;
  readonly start: number;
  readonly end: number;
  readonly before: string;
  readonly after: string;
}

export interface AstNormalizationUnknown {
  readonly code: "pass-limit-reached" | "observations-truncated";
  readonly message: string;
  readonly omitted?: number;
}

export interface AstNormalizationResult {
  readonly transformed: string;
  readonly stats: AstNormalizationStats;
  readonly observations: readonly AstNormalizationObservation[];
  readonly unknowns: readonly AstNormalizationUnknown[];
  readonly coverage: "complete" | "partial";
  readonly limits: AstNormalizationLimits;
}

type Literal = string | number | boolean | null;
type ConstantBindings = ReadonlyMap<
  string,
  { readonly value: Literal; readonly declarationStart: number }
>;
type EditKind = AstNormalizationObservation["kind"];
interface Edit {
  readonly start: number;
  readonly end: number;
  readonly text: string;
  readonly kind: EditKind;
}
interface Visit {
  readonly node: Node;
  readonly visited: boolean;
}

const DEFAULT_LIMITS: AstNormalizationLimits = {
  maxSourceBytes: 4 * 1024 * 1024,
  maxOutputBytes: 8 * 1024 * 1024,
  maxPasses: 4,
  maxNodes: 200_000,
  maxObservations: 1_000,
};
const HARD_LIMITS: AstNormalizationLimits = {
  maxSourceBytes: 64 * 1024 * 1024,
  maxOutputBytes: 128 * 1024 * 1024,
  maxPasses: 16,
  maxNodes: 1_000_000,
  maxObservations: 10_000,
};

const resolveLimits = (
  options: AstNormalizationOptions,
): Result<AstNormalizationLimits, AstNormalizationError> => {
  const resolved = { ...DEFAULT_LIMITS };
  for (const key of Object.keys(
    DEFAULT_LIMITS,
  ) as (keyof AstNormalizationLimits)[]) {
    const value = options[key];
    if (value === undefined) continue;
    const minimum = key === "maxObservations" ? 0 : 1;
    if (
      !Number.isSafeInteger(value) ||
      value < minimum ||
      value > HARD_LIMITS[key]
    )
      return err({
        code: "invalid_options",
        option: key,
        message: `${key} must be an integer from ${minimum} through ${HARD_LIMITS[key]}.`,
      });
    resolved[key] = value;
  }
  if (resolved.maxOutputBytes < resolved.maxSourceBytes)
    return err({
      code: "invalid_options",
      option: "maxOutputBytes",
      message: "maxOutputBytes must be at least maxSourceBytes.",
    });
  return ok(resolved);
};

const childNodes = (node: Node): Node[] => {
  delete node.extra;
  const children: Node[] = [];
  for (const value of Object.values(
    node as unknown as Record<string, unknown>,
  )) {
    if (Array.isArray(value)) {
      for (const item of value)
        if (item !== null && typeof item === "object" && "type" in item)
          children.push(item as Node);
    } else if (value !== null && typeof value === "object" && "type" in value) {
      children.push(value as Node);
    }
  }
  return children;
};

const range = (node: Node): { start: number; end: number } | undefined =>
  typeof node.start === "number" && typeof node.end === "number"
    ? { start: node.start, end: node.end }
    : undefined;

/**
 * Collect top-level immutable literal bindings. A name is eligible only when it
 * is declared exactly once, is never a parameter, and is never assigned. This
 * stays conservative around scope and TDZ: references before the declaration
 * are not rewritten.
 */
const collectConstants = (program: Node): ConstantBindings => {
  const body = (program as unknown as { body?: readonly Node[] }).body ?? [];
  const candidates: {
    readonly name: string;
    readonly value: Literal;
    readonly declarationStart: number;
  }[] = [];
  for (const statement of body) {
    if (statement.type !== "VariableDeclaration" || statement.kind !== "const")
      continue;
    for (const declarator of statement.declarations) {
      if (declarator.id.type !== "Identifier" || declarator.init == null)
        continue;
      const value = literalOf(declarator.init);
      if (value !== undefined && typeof declarator.start === "number")
        candidates.push({
          name: declarator.id.name,
          value,
          declarationStart: declarator.start,
        });
    }
  }
  if (candidates.length === 0) return new Map();
  const declarationCounts = new Map<string, number>();
  const blocked = new Set<string>();
  const walk = (node: Node): void => {
    if (node.type === "VariableDeclaration")
      for (const declarator of node.declarations)
        if (declarator.id.type === "Identifier")
          declarationCounts.set(
            declarator.id.name,
            (declarationCounts.get(declarator.id.name) ?? 0) + 1,
          );
    if (
      (node.type === "FunctionDeclaration" ||
        node.type === "FunctionExpression" ||
        node.type === "ArrowFunctionExpression") &&
      Array.isArray(node.params)
    )
      for (const parameter of node.params)
        if (parameter.type === "Identifier") blocked.add(parameter.name);
    if (node.type === "FunctionDeclaration" && node.id != null)
      blocked.add(node.id.name);
    if (node.type === "ClassDeclaration" && node.id != null)
      blocked.add(node.id.name);
    if (node.type === "AssignmentExpression" && node.left.type === "Identifier")
      blocked.add(node.left.name);
    if (node.type === "UpdateExpression" && node.argument.type === "Identifier")
      blocked.add(node.argument.name);
    for (const child of childNodes(node)) walk(child);
  };
  walk(program);
  const bindings = new Map<
    string,
    { readonly value: Literal; readonly declarationStart: number }
  >();
  for (const candidate of candidates)
    if (
      declarationCounts.get(candidate.name) === 1 &&
      !blocked.has(candidate.name)
    )
      bindings.set(candidate.name, {
        value: candidate.value,
        declarationStart: candidate.declarationStart,
      });
  return bindings;
};

const literalOf = (
  node: Node,
  constants?: ConstantBindings,
): Literal | undefined => {
  if (node.type === "Identifier") {
    const binding = constants?.get(node.name);
    if (
      binding !== undefined &&
      typeof node.start === "number" &&
      node.start > binding.declarationStart
    )
      return binding.value;
    return undefined;
  }
  if (isNumericLiteral(node) || isStringLiteral(node) || isBooleanLiteral(node))
    return node.value;
  if (isNullLiteral(node)) return null;
  if (
    isUnaryExpression(node) &&
    (node.operator === "-" || node.operator === "+")
  )
    return isNumericLiteral(node.argument)
      ? node.operator === "-"
        ? -node.argument.value
        : node.argument.value
      : undefined;
  return undefined;
};

const renderLiteral = (value: Literal): string => {
  if (typeof value === "string") return JSON.stringify(value);
  if (value === null) return "null";
  if (typeof value === "number") {
    if (Object.is(value, -0)) return "-0";
    return String(value);
  }
  return String(value);
};

const isFiniteNumber = (value: Literal): boolean =>
  typeof value !== "number" || Number.isFinite(value);

// Literal-only dispatch keeps the ECMAScript operations explicit and auditable.
// oxlint-disable-next-line complexity
const arithmetic = (
  operator: string,
  left: Literal,
  right: Literal,
): Literal | undefined => {
  switch (operator) {
    case "+":
      return typeof left === "string" || typeof right === "string"
        ? String(left) + String(right)
        : Number(left) + Number(right);
    case "-":
      return Number(left) - Number(right);
    case "*":
      return Number(left) * Number(right);
    case "/":
      return Number(left) / Number(right);
    case "%":
      return Number(left) % Number(right);
    case "**":
      return Number(left) ** Number(right);
    case "<<":
      return Number(left) << Number(right);
    case ">>":
      return Number(left) >> Number(right);
    case ">>>":
      return Number(left) >>> Number(right);
    case "&":
      return Number(left) & Number(right);
    case "|":
      return Number(left) | Number(right);
    case "^":
      return Number(left) ^ Number(right);
    case "===":
      return left === right;
    case "!==":
      return left !== right;
    case "==":
      return left == right;
    case "!=":
      return left != right;
    case "<":
      return typeof left === "string" && typeof right === "string"
        ? left < right
        : Number(left) < Number(right);
    case "<=":
      return typeof left === "string" && typeof right === "string"
        ? left <= right
        : Number(left) <= Number(right);
    case ">":
      return typeof left === "string" && typeof right === "string"
        ? left > right
        : Number(left) > Number(right);
    case ">=":
      return typeof left === "string" && typeof right === "string"
        ? left >= right
        : Number(left) >= Number(right);
    default:
      return undefined;
  }
};

const foldUnary = (
  node: Node,
  constants?: ConstantBindings,
): Literal | undefined => {
  if (!isUnaryExpression(node)) return undefined;
  const value = literalOf(node.argument, constants);
  if (value === undefined) return undefined;
  switch (node.operator) {
    case "!":
      return !value;
    case "~":
      return ~Number(value);
    case "-":
      return -Number(value);
    case "+":
      return +Number(value);
    default:
      return undefined;
  }
};

// oxlint-disable-next-line complexity
const replacementFor = (
  source: string,
  node: Node,
  constants: ConstantBindings,
): Omit<Edit, "start" | "end"> | undefined => {
  const span = range(node);
  if (span === undefined) return undefined;
  if (isIfStatement(node)) {
    const test = literalOf(node.test, constants);
    if (test === undefined) return undefined;
    const chosen = test ? node.consequent : node.alternate;
    if (chosen === null || chosen === undefined)
      return { text: "", kind: "dead-branch-removed" };
    const selected = range(chosen);
    if (selected === undefined) return undefined;
    const text = source.slice(selected.start, selected.end);
    return {
      text: chosen.type === "BlockStatement" ? text : `{ ${text} }`,
      kind: "dead-branch-removed",
    };
  }
  if (isConditionalExpression(node)) {
    const test = literalOf(node.test, constants);
    if (test === undefined) return undefined;
    const chosen = range(test ? node.consequent : node.alternate);
    return chosen === undefined
      ? undefined
      : {
          text: source.slice(chosen.start, chosen.end),
          kind: "dead-branch-removed",
        };
  }
  if (isLogicalExpression(node)) {
    const left = literalOf(node.left, constants);
    if (left === undefined) return undefined;
    const right = range(node.right);
    if (right === undefined) return undefined;
    const takeRight =
      node.operator === "&&"
        ? Boolean(left)
        : node.operator === "||"
          ? !left
          : left === null;
    return {
      text: takeRight
        ? source.slice(right.start, right.end)
        : renderLiteral(left),
      kind: "dead-branch-removed",
    };
  }
  if (isBinaryExpression(node)) {
    const left = literalOf(node.left, constants);
    const right = literalOf(node.right, constants);
    if (left === undefined || right === undefined) return undefined;
    // A negative literal is not a valid unparenthesized ** left operand.
    if (
      node.operator === "**" &&
      typeof left === "number" &&
      (left < 0 || Object.is(left, -0))
    )
      return undefined;
    const value = arithmetic(node.operator, left, right);
    if (value !== undefined && !isFiniteNumber(value)) return undefined;
    return value === undefined
      ? undefined
      : {
          text: renderLiteral(value),
          kind: "constant-folded",
        };
  }
  const folded = foldUnary(node, constants);
  if (folded !== undefined)
    return { text: renderLiteral(folded), kind: "constant-folded" };
  if (isStringLiteral(node) && /\\/u.test(source.slice(span.start, span.end)))
    return { text: JSON.stringify(node.value), kind: "string-decoded" };
  return undefined;
};

const snippet = (text: string): string =>
  text.length <= 160 ? text : `${text.slice(0, 157)}...`;

/** Parse and rewrite source without invoking generated code or a JavaScript runtime. */
// oxlint-disable-next-line complexity
export function normalizeJavaScriptAst(
  source: string,
  options: AstNormalizationOptions = {},
): Result<AstNormalizationResult, AstNormalizationError> {
  const limitsResult = resolveLimits(options);
  if (!limitsResult.ok) return limitsResult;
  const limits = limitsResult.value;
  const sourceBytes = Buffer.byteLength(source, "utf8");
  if (sourceBytes > limits.maxSourceBytes)
    return err({
      code: "source_too_large",
      actual: sourceBytes,
      limit: limits.maxSourceBytes,
      message: `Source is ${sourceBytes} bytes; the limit is ${limits.maxSourceBytes}.`,
    });
  if (sourceBytes > limits.maxOutputBytes)
    return err({
      code: "output_too_large",
      actual: sourceBytes,
      limit: limits.maxOutputBytes,
      message: `Input exceeds the transformed-output limit of ${limits.maxOutputBytes} bytes.`,
    });

  let transformed = source;
  let foldedConstants = 0;
  let removedBranches = 0;
  let decodedStrings = 0;
  let passes = 0;
  let complete = true;
  const observations: AstNormalizationObservation[] = [];
  const pendingObservations: (Omit<AstNormalizationObservation, "before"> & {
    before: string;
  })[] = [];
  let omittedObservations = 0;

  for (let pass = 1; pass <= limits.maxPasses; pass += 1) {
    let ast: ReturnType<typeof parse>;
    try {
      ast = parse(transformed, {
        sourceType: options.sourceType ?? "unambiguous",
        plugins: ["jsx", "typescript"],
        errorRecovery: true,
      });
    } catch (cause) {
      return err({
        code: "parse_failed",
        message:
          cause instanceof Error ? cause.message : "JavaScript parsing failed.",
        diagnostics: [],
      });
    }
    if (ast.errors.length > 0)
      return err({
        code: "parse_failed",
        message:
          "Recovered parser errors make a semantics-preserving rewrite unavailable.",
        diagnostics: ast.errors.map((error) => error.message),
      });

    const constants = collectConstants(ast.program as unknown as Node);
    const edits: Edit[] = [];
    const touched = new Set<Node>();
    const stack: Visit[] = [
      { node: ast.program as unknown as Node, visited: false },
    ];
    let visitedNodes = 0;
    while (stack.length > 0) {
      const current = stack.pop() as Visit;
      if (!current.visited) {
        visitedNodes += 1;
        if (visitedNodes > limits.maxNodes)
          return err({
            code: "node_limit_exceeded",
            limit: limits.maxNodes,
            message: `The AST exceeds the ${limits.maxNodes}-node limit.`,
          });
        stack.push({ ...current, visited: true });
        const children = childNodes(current.node);
        for (let index = children.length - 1; index >= 0; index -= 1)
          stack.push({ node: children[index] as Node, visited: false });
        continue;
      }
      if (childNodes(current.node).some((child) => touched.has(child)))
        continue;
      const span = range(current.node);
      if (span === undefined) continue;
      const replacement = replacementFor(transformed, current.node, constants);
      if (
        replacement === undefined ||
        replacement.text === transformed.slice(span.start, span.end)
      )
        continue;
      edits.push({ ...span, ...replacement });
      touched.add(current.node);
    }

    if (edits.length === 0) break;
    for (const edit of edits)
      pendingObservations.push({
        kind: edit.kind,
        pass,
        start: edit.start,
        end: edit.end,
        before: snippet(transformed.slice(edit.start, edit.end)),
        after: snippet(edit.text),
      });
    edits.sort((left, right) => right.start - left.start);
    for (const edit of edits) {
      transformed =
        transformed.slice(0, edit.start) +
        edit.text +
        transformed.slice(edit.end);
      if (edit.kind === "constant-folded") foldedConstants += 1;
      else if (edit.kind === "dead-branch-removed") removedBranches += 1;
      else decodedStrings += 1;
    }
    passes = pass;
    const outputBytes = Buffer.byteLength(transformed, "utf8");
    if (outputBytes > limits.maxOutputBytes)
      return err({
        code: "output_too_large",
        actual: outputBytes,
        limit: limits.maxOutputBytes,
        message: `Transformed source is ${outputBytes} bytes; the limit is ${limits.maxOutputBytes}.`,
      });
    if (pass === limits.maxPasses) complete = false;
  }

  for (const observation of pendingObservations) {
    if (observations.length < limits.maxObservations)
      observations.push(observation);
    else omittedObservations += 1;
  }
  const unknowns: AstNormalizationUnknown[] = [];
  if (!complete)
    unknowns.push({
      code: "pass-limit-reached",
      message: `Rewriting stopped after ${limits.maxPasses} passes; additional folds may remain.`,
    });
  if (omittedObservations > 0)
    unknowns.push({
      code: "observations-truncated",
      omitted: omittedObservations,
      message: `${omittedObservations} rewrite observations exceeded the retention limit; all edits were applied.`,
    });
  return ok({
    transformed,
    stats: { foldedConstants, removedBranches, decodedStrings, passes },
    observations,
    unknowns,
    coverage: complete ? "complete" : "partial",
    limits,
  });
}
