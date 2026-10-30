import { parse } from "@babel/parser";
import type { Node } from "@babel/types";

/**
 * Statically link a WebAssembly module to its JavaScript glue.
 *
 * Only the import and export sections are decoded, and only the shapes the glue
 * can express statically are matched. Nothing is instantiated or executed: the
 * result is a candidate call graph with explicit unresolved entries.
 */
export interface WasmImport {
  readonly module: string;
  readonly name: string;
  readonly kind: "function" | "table" | "memory" | "global" | "unknown";
}

export interface WasmExport {
  readonly name: string;
  readonly kind: "function" | "table" | "memory" | "global" | "unknown";
}

export interface WasmFunction {
  /** Function index in the module's index space. */
  readonly index: number;
  readonly kind: "imported" | "defined";
  readonly typeIndex: number;
  /** Import module/name; both null for a defined function. */
  readonly module: string | null;
  readonly name: string | null;
  /** Export names that resolve to this function index. */
  readonly exports: readonly string[];
}

export interface WasmInterface {
  readonly imports: readonly WasmImport[];
  readonly exports: readonly WasmExport[];
  /** Function index space with imported functions before defined functions. */
  readonly functions: readonly WasmFunction[];
}

export interface GlueBinding {
  /** Module name used in the import object, e.g. "env". */
  readonly module: string;
  /** Imported name, e.g. "abort". */
  readonly name: string;
  /** JavaScript identifier or member path supplying it. */
  readonly provider: string;
  readonly line: number;
}

export interface GlueExportCall {
  /** Export name reached through `instance.exports.<name>` or `<ns>.exports.<name>`. */
  readonly name: string;
  readonly line: number;
  /** True when the access is immediately invoked. */
  readonly invoked: boolean;
}

export interface GlueFacts {
  readonly bindings: readonly GlueBinding[];
  readonly exportCalls: readonly GlueExportCall[];
  /** Line of the `WebAssembly.instantiate`/`Instance` call, when found. */
  readonly instantiationLine: number | undefined;
}

export interface BridgeEdge {
  readonly from: string;
  readonly to: string;
  readonly line: number;
}

export interface BridgeGraph {
  readonly jsToWasm: readonly BridgeEdge[];
  readonly wasmToJs: readonly BridgeEdge[];
  readonly unresolvedImports: readonly string[];
  readonly unusedExports: readonly string[];
  readonly instantiationLine: number | undefined;
}

const KIND_BY_CODE: Record<number, WasmImport["kind"]> = {
  0x00: "function",
  0x01: "table",
  0x02: "memory",
  0x03: "global",
};

class Reader {
  offset = 0;
  constructor(private readonly bytes: Uint8Array) {}
  byte(): number {
    const value = this.bytes[this.offset];
    if (value === undefined) throw new Error("unexpected end of wasm module");
    this.offset += 1;
    return value;
  }
  u32(): number {
    let result = 0;
    let shift = 0;
    for (;;) {
      const byte = this.byte();
      result |= (byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return result >>> 0;
      shift += 7;
      if (shift > 35) throw new Error("invalid LEB128 value");
    }
  }
  name(): string {
    const length = this.u32();
    const start = this.offset;
    this.offset += length;
    if (this.offset > this.bytes.length)
      throw new Error("wasm name extends past the end of the module");
    return new TextDecoder().decode(this.bytes.subarray(start, this.offset));
  }
  skip(length: number): void {
    this.offset += length;
    if (this.offset > this.bytes.length)
      throw new Error("wasm section extends past the end of the module");
  }
}

/** Decode the import and export sections of a WebAssembly binary. */
export function readWasmInterface(bytes: Uint8Array): WasmInterface {
  if (bytes.length < 8)
    throw new Error("wasm module is shorter than its header");
  const magic = [0x00, 0x61, 0x73, 0x6d];
  for (let index = 0; index < magic.length; index += 1)
    if (bytes[index] !== magic[index])
      throw new Error("not a wasm module (bad magic)");
  const reader = new Reader(bytes);
  reader.skip(8);
  const imports: WasmImport[] = [];
  const exports: WasmExport[] = [];
  const importedFunctions: {
    readonly module: string;
    readonly name: string;
    readonly typeIndex: number;
  }[] = [];
  const definedFunctionTypes: number[] = [];
  const functionExports: { readonly name: string; readonly index: number }[] =
    [];
  while (reader.offset < bytes.length) {
    const sectionId = reader.byte();
    const size = reader.u32();
    const end = reader.offset + size;
    if (end > bytes.length)
      throw new Error("wasm section length exceeds the module");
    if (sectionId === 2) {
      const count = reader.u32();
      for (let index = 0; index < count; index += 1) {
        const module = reader.name();
        const name = reader.name();
        const kindCode = reader.byte();
        const kind = KIND_BY_CODE[kindCode] ?? "unknown";
        if (kindCode === 0x00) {
          const typeIndex = reader.u32();
          importedFunctions.push({ module, name, typeIndex });
        } else if (kindCode === 0x01) reader.byte();
        else if (kindCode === 0x02) reader.u32();
        else if (kindCode === 0x03) {
          reader.byte();
          reader.byte();
        } else
          throw new Error(`unsupported wasm import kind ${String(kindCode)}`);
        imports.push({ module, name, kind });
      }
    } else if (sectionId === 3) {
      const count = reader.u32();
      for (let index = 0; index < count; index += 1)
        definedFunctionTypes.push(reader.u32());
    } else if (sectionId === 7) {
      const count = reader.u32();
      for (let index = 0; index < count; index += 1) {
        const name = reader.name();
        const kindCode = reader.byte();
        const exportIndex = reader.u32();
        if (kindCode === 0x00)
          functionExports.push({ name, index: exportIndex });
        exports.push({ name, kind: KIND_BY_CODE[kindCode] ?? "unknown" });
      }
    }
    reader.offset = end;
  }
  const exportNames = (index: number): string[] =>
    functionExports
      .filter((entry) => entry.index === index)
      .map((entry) => entry.name);
  const functions: WasmFunction[] = [
    ...importedFunctions.map((entry, index) => ({
      index,
      kind: "imported" as const,
      typeIndex: entry.typeIndex,
      module: entry.module,
      name: entry.name,
      exports: exportNames(index),
    })),
    ...definedFunctionTypes.map((typeIndex, index) => ({
      index: importedFunctions.length + index,
      kind: "defined" as const,
      typeIndex,
      module: null,
      name: null,
      exports: exportNames(importedFunctions.length + index),
    })),
  ];
  return { imports, exports, functions };
}

const memberPath = (node: Node): string | undefined => {
  if (node.type === "Identifier") return node.name;
  if (node.type === "ThisExpression") return "this";
  if (node.type === "MemberExpression") {
    const object = memberPath(node.object as Node);
    const property =
      node.computed === true
        ? node.property.type === "StringLiteral"
          ? node.property.value
          : undefined
        : node.property.type === "Identifier"
          ? node.property.name
          : undefined;
    return object === undefined || property === undefined
      ? undefined
      : `${object}.${property}`;
  }
  return undefined;
};

const lineOf = (node: Node): number =>
  typeof node.loc?.start.line === "number" ? node.loc.start.line : 0;

/** Read the import object and export calls out of a JavaScript glue file. */
export function analyzeGlue(source: string): GlueFacts {
  const ast = parse(source, {
    sourceType: "unambiguous",
    plugins: ["typescript", "jsx"],
    errorRecovery: true,
  });
  const bindings: GlueBinding[] = [];
  const exportCalls: GlueExportCall[] = [];
  const handled = new WeakSet<object>();
  const objectBindings = new Map<string, Node>();
  let instantiationLine: number | undefined;

  const visit = (node: Node): void => {
    if (
      node.type === "VariableDeclarator" &&
      node.id.type === "Identifier" &&
      node.init?.type === "ObjectExpression"
    )
      objectBindings.set(node.id.name, node.init);
    if (node.type === "CallExpression") {
      const callee = memberPath(node.callee as Node) ?? "";
      if (
        callee === "WebAssembly.instantiate" ||
        callee === "WebAssembly.instantiateStreaming" ||
        callee === "new WebAssembly.Instance"
      ) {
        instantiationLine ??= lineOf(node);
        const rawArgument = node.arguments[1] as Node | undefined;
        const argument =
          rawArgument?.type === "Identifier"
            ? objectBindings.get(rawArgument.name)
            : rawArgument;
        if (argument?.type === "ObjectExpression") {
          for (const property of argument.properties) {
            if (property.type !== "ObjectProperty") continue;
            const moduleName =
              property.key.type === "Identifier"
                ? property.key.name
                : property.key.type === "StringLiteral"
                  ? property.key.value
                  : undefined;
            if (moduleName === undefined) continue;
            if (property.value.type !== "ObjectExpression") continue;
            for (const nested of property.value.properties) {
              if (nested.type !== "ObjectProperty") continue;
              const name =
                nested.key.type === "Identifier"
                  ? nested.key.name
                  : nested.key.type === "StringLiteral"
                    ? nested.key.value
                    : undefined;
              const provider = memberPath(nested.value as Node);
              if (name === undefined || provider === undefined) continue;
              bindings.push({
                module: moduleName,
                name,
                provider,
                line: lineOf(nested),
              });
            }
          }
        }
      }
      const calleePath = memberPath(node.callee as Node);
      if (calleePath !== undefined) {
        const match = /\.exports\.([A-Za-z0-9_$]+)$/u.exec(calleePath);
        if (match?.[1] !== undefined) {
          exportCalls.push({
            name: match[1],
            line: lineOf(node),
            invoked: true,
          });
          handled.add(node.callee as object);
        }
      }
    }
    if (node.type === "MemberExpression" && !handled.has(node)) {
      const path = memberPath(node);
      const match =
        path === undefined ? null : /\.exports\.([A-Za-z0-9_$]+)$/u.exec(path);
      if (match?.[1] !== undefined)
        exportCalls.push({
          name: match[1],
          line: lineOf(node),
          invoked: false,
        });
    }
    for (const value of Object.values(
      node as unknown as Record<string, unknown>,
    )) {
      if (Array.isArray(value)) {
        for (const item of value)
          if (item !== null && typeof item === "object" && "type" in item)
            visit(item as Node);
        continue;
      }
      if (value !== null && typeof value === "object" && "type" in value)
        visit(value as Node);
    }
  };
  visit(ast.program as unknown as Node);
  return { bindings, exportCalls, instantiationLine };
}

/** Join the module interface with the glue facts into a bridge graph. */
export function buildBridgeGraph(
  wasm: WasmInterface,
  glue: GlueFacts,
): BridgeGraph {
  const exportedNames = new Set(wasm.exports.map((item) => item.name));
  const jsToWasm: BridgeEdge[] = [];
  const seen = new Set<string>();
  for (const call of glue.exportCalls) {
    if (!exportedNames.has(call.name)) continue;
    const key = `${call.name}\u0000${String(call.line)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    jsToWasm.push({ from: "js", to: call.name, line: call.line });
  }
  const bindingByKey = new Map(
    glue.bindings.map((binding) => [
      `${binding.module}.${binding.name}`,
      binding,
    ]),
  );
  const wasmToJs: BridgeEdge[] = [];
  const unresolvedImports: string[] = [];
  for (const item of wasm.imports) {
    const binding = bindingByKey.get(`${item.module}.${item.name}`);
    if (binding === undefined) {
      unresolvedImports.push(`${item.module}.${item.name}`);
      continue;
    }
    wasmToJs.push({
      from: item.name,
      to: binding.provider,
      line: binding.line,
    });
  }
  const called = new Set(glue.exportCalls.map((call) => call.name));
  return {
    jsToWasm,
    wasmToJs,
    unresolvedImports,
    unusedExports: wasm.exports
      .map((item) => item.name)
      .filter((name) => !called.has(name)),
    instantiationLine: glue.instantiationLine,
  };
}
