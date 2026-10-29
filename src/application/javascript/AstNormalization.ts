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

/**
 * Conservative AST normalization for minified bundles.
 *
 * It rewrites a *copy* of the source: literal-only expressions are folded and
 * branches whose test is a literal are resolved. Every rule requires literal
 * operands, so identifiers, calls, getters and other effectful code are never
 * evaluated or reordered. Ranges come from the original parse, so untouched
 * text keeps its original bytes.
 */
export interface AstNormalizationStats {
  /** Expressions replaced by a literal value. */
  readonly foldedConstants: number;
  /** `if` / conditional branches collapsed because the test was a literal. */
  readonly removedBranches: number;
  /** Escaped string literals rewritten to their decoded value. */
  readonly decodedStrings: number;
  /** Passes needed to reach a fixed point. */
  readonly passes: number;
}

export interface AstNormalizationResult {
  readonly text: string;
  readonly stats: AstNormalizationStats;
}

export interface AstNormalizationOptions {
  /** Upper bound on rewrite passes. Defaults to 3. */
  readonly maxPasses?: number;
  /** Parsed as a module, a script, or inferred. Defaults to "unambiguous". */
  readonly sourceType?: "script" | "module" | "unambiguous";
}

type Literal = string | number | boolean | null;

/**
 * Collect `const` bindings whose initializer is a literal and whose name is
 * never written or shadowed anywhere in the file. Anything less provable stays
 * out: propagation must not change behaviour for a reassigned or captured name.
 */
const collectConstants = (program: Node): Map<string, Literal> => {
  const declarations = new Map<string, Literal[]>();
  const blocked = new Set<string>();
  const walk = (node: Node): void => {
    if (node.type === "VariableDeclaration" && node.kind === "const") {
      for (const declarator of node.declarations) {
        if (declarator.id.type !== "Identifier") continue;
        const init = declarator.init;
        const value =
          init === null || init === undefined ? undefined : literalOf(init);
        const list = declarations.get(declarator.id.name) ?? [];
        if (value === undefined) blocked.add(declarator.id.name);
        else list.push(value);
        declarations.set(declarator.id.name, list);
      }
    }
    if (node.type === "AssignmentExpression" && node.left.type === "Identifier")
      blocked.add(node.left.name);
    if (node.type === "UpdateExpression" && node.argument.type === "Identifier")
      blocked.add(node.argument.name);
    if (node.type === "VariableDeclarator" && node.id.type !== "Identifier")
      for (const name of Object.keys(node.id))
        if (name === "name")
          blocked.add((node.id as unknown as { name: string }).name);
    if (
      (node.type === "FunctionDeclaration" ||
        node.type === "FunctionExpression" ||
        node.type === "ArrowFunctionExpression") &&
      Array.isArray(node.params)
    )
      for (const parameter of node.params)
        if (parameter.type === "Identifier") blocked.add(parameter.name);
    for (const value of Object.values(
      node as unknown as Record<string, unknown>,
    )) {
      if (Array.isArray(value)) {
        for (const item of value)
          if (item !== null && typeof item === "object" && "type" in item)
            walk(item as Node);
        continue;
      }
      if (value !== null && typeof value === "object" && "type" in value)
        walk(value as Node);
    }
  };
  walk(program);
  const constants = new Map<string, Literal>();
  for (const [name, values] of declarations) {
    if (blocked.has(name) || values.length !== 1) continue;
    constants.set(name, values[0] as Literal);
  }
  return constants;
};

interface Edit {
  readonly start: number;
  readonly end: number;
  readonly text: string;
  readonly kind: "constant" | "branch" | "string";
}

const literalOf = (
  node: Node,
  constants?: ReadonlyMap<string, Literal>,
): Literal | undefined => {
  if (node.type === "Identifier" && constants !== undefined) {
    const resolved = constants.get(node.name);
    if (resolved !== undefined) return resolved;
  }
  if (isNumericLiteral(node)) return node.value;
  if (isStringLiteral(node)) return node.value;
  if (isBooleanLiteral(node)) return node.value;
  if (isNullLiteral(node)) return null;
  if (isUnaryExpression(node) && node.operator === "-")
    return isNumericLiteral(node.argument) ? -node.argument.value : undefined;
  if (isUnaryExpression(node) && node.operator === "+")
    return isNumericLiteral(node.argument) ? +node.argument.value : undefined;
  return undefined;
};

const renderLiteral = (value: Literal): string => {
  if (typeof value === "string") return JSON.stringify(value);
  if (value === null) return "null";
  if (typeof value === "number") {
    if (Number.isNaN(value)) return "NaN";
    if (value === Infinity) return "Infinity";
    if (value === -Infinity) return "-Infinity";
    if (Object.is(value, -0)) return "-0";
    return String(value);
  }
  return String(value);
};

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
    case "<": {
      if (typeof left === "string" && typeof right === "string")
        return left < right;
      return Number(left) < Number(right);
    }
    case "<=": {
      if (typeof left === "string" && typeof right === "string")
        return left <= right;
      return Number(left) <= Number(right);
    }
    case ">": {
      if (typeof left === "string" && typeof right === "string")
        return left > right;
      return Number(left) > Number(right);
    }
    case ">=": {
      if (typeof left === "string" && typeof right === "string")
        return left >= right;
      return Number(left) >= Number(right);
    }
    default:
      return undefined;
  }
};

const foldUnary = (
  node: Node,
  constants?: ReadonlyMap<string, Literal>,
): Literal | undefined => {
  if (!isUnaryExpression(node)) return undefined;
  if (node.operator === "void") return undefined;
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

const childNodes = (node: Node): Node[] => {
  const children: Node[] = [];
  for (const value of Object.values(
    node as unknown as Record<string, unknown>,
  )) {
    if (Array.isArray(value)) {
      for (const item of value)
        if (item !== null && typeof item === "object" && "type" in item)
          children.push(item as Node);
      continue;
    }
    if (value !== null && typeof value === "object" && "type" in value)
      children.push(value as Node);
  }
  return children;
};

const range = (node: Node): { start: number; end: number } | undefined =>
  typeof node.start === "number" && typeof node.end === "number"
    ? { start: node.start, end: node.end }
    : undefined;

const pushEdit = (edits: Edit[], edit: Edit): void => {
  for (const existing of edits)
    if (edit.start < existing.end && existing.start < edit.end) return;
  edits.push(edit);
};

/**
 * Rewrite one pass. Returns the new text and how many edits each rule made.
 * A node that contains a rewritten descendant is skipped, so ranges stay valid.
 */
const rewritePass = (
  source: string,
  options: AstNormalizationOptions,
): { text: string; edits: Edit[] } => {
  const ast = parse(source, {
    sourceType: options.sourceType ?? "unambiguous",
    plugins: ["jsx", "typescript"],
    errorRecovery: true,
    ranges: false,
  });
  const edits: Edit[] = [];
  const constants = collectConstants(ast.program as unknown as Node);
  const visit = (node: Node): void => {
    let touched = false;
    for (const child of childNodes(node)) {
      const before = edits.length;
      visit(child);
      if (edits.length !== before) touched = true;
    }
    if (touched) return;
    const span = range(node);
    if (span === undefined) return;

    if (isIfStatement(node)) {
      const test = literalOf(node.test, constants);
      if (test === undefined) return;
      const chosen = test ? node.consequent : node.alternate;
      if (chosen === undefined || chosen === null) {
        pushEdit(edits, { ...span, text: "", kind: "branch" });
        return;
      }
      const chosenSpan = range(chosen);
      if (chosenSpan === undefined) return;
      pushEdit(edits, {
        ...span,
        text: source.slice(chosenSpan.start, chosenSpan.end),
        kind: "branch",
      });
      return;
    }

    if (isConditionalExpression(node)) {
      const test = literalOf(node.test, constants);
      if (test === undefined) return;
      const chosen = test ? node.consequent : node.alternate;
      const chosenSpan = range(chosen);
      if (chosenSpan === undefined) return;
      pushEdit(edits, {
        ...span,
        text: source.slice(chosenSpan.start, chosenSpan.end),
        kind: "branch",
      });
      return;
    }

    if (isLogicalExpression(node)) {
      const left = literalOf(node.left, constants);
      if (left === undefined) return;
      const rightSpan = range(node.right);
      if (rightSpan === undefined) return;
      if (node.operator === "&&") {
        pushEdit(edits, {
          ...span,
          text: left
            ? source.slice(rightSpan.start, rightSpan.end)
            : renderLiteral(left),
          kind: left ? "branch" : "constant",
        });
        return;
      }
      if (node.operator === "||") {
        pushEdit(edits, {
          ...span,
          text: left
            ? renderLiteral(left)
            : source.slice(rightSpan.start, rightSpan.end),
          kind: left ? "constant" : "branch",
        });
        return;
      }
      if (node.operator === "??") {
        pushEdit(edits, {
          ...span,
          text:
            left === null || left === undefined
              ? source.slice(rightSpan.start, rightSpan.end)
              : renderLiteral(left),
          kind: "branch",
        });
        return;
      }
      return;
    }

    if (isBinaryExpression(node)) {
      const left = literalOf(node.left, constants);
      const right = literalOf(node.right, constants);
      if (left === undefined || right === undefined) return;
      const value = arithmetic(node.operator, left, right);
      if (value === undefined) return;
      pushEdit(edits, {
        ...span,
        text: renderLiteral(value),
        kind: "constant",
      });
      return;
    }

    const folded = foldUnary(node, constants);
    if (folded !== undefined) {
      pushEdit(edits, {
        ...span,
        text: renderLiteral(folded),
        kind: "constant",
      });
      return;
    }

    if (
      isStringLiteral(node) &&
      /\\/u.test(source.slice(span.start, span.end))
    ) {
      pushEdit(edits, {
        ...span,
        text: JSON.stringify(node.value),
        kind: "string",
      });
    }
  };
  visit(ast.program as unknown as Node);
  const ordered = [...edits].sort((a, b) => b.start - a.start);
  let text = source;
  for (const edit of ordered)
    text = text.slice(0, edit.start) + edit.text + text.slice(edit.end);
  return { text, edits };
};

/** Normalize minified JavaScript without evaluating anything at analysis time. */
export function normalizeJavaScriptAst(
  source: string,
  options: AstNormalizationOptions = {},
): AstNormalizationResult {
  const maxPasses = options.maxPasses ?? 3;
  let text = source;
  let foldedConstants = 0;
  let removedBranches = 0;
  let decodedStrings = 0;
  let passes = 0;
  for (let index = 0; index < maxPasses; index += 1) {
    let result: { text: string; edits: Edit[] };
    try {
      result = rewritePass(text, options);
    } catch {
      break;
    }
    if (result.edits.length === 0) break;
    passes += 1;
    text = result.text;
    for (const edit of result.edits) {
      if (edit.kind === "constant") foldedConstants += 1;
      else if (edit.kind === "branch") removedBranches += 1;
      else decodedStrings += 1;
    }
  }
  return {
    text,
    stats: { foldedConstants, removedBranches, decodedStrings, passes },
  };
}
