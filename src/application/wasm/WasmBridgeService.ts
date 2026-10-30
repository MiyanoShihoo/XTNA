import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import {
  wasmBridgeInputSchema,
  wasmBridgeResultSchema,
} from "../../contracts/wasm/wasmBridgeContracts.js";
import type { Evidence } from "../../domain/evidence.js";
import { createEvidence } from "../../domain/evidence.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import { AnalysisInputError } from "../../domain/analysisErrorCore.js";
import { err, ok, type Result } from "../../domain/result.js";
import { parseAnalysisInput } from "../AnalysisInput.js";
import type { ExecutionOptions } from "../AnalysisProvider.js";
import {
  analyzeGlue,
  buildBridgeGraph,
  readWasmInterface,
} from "./WasmBridgeGraph.js";

const OPERATION = "wasm_bridge";
const PROVIDER = {
  id: "wasm-bridge-static",
  name: "WASM bridge static analyzer",
  version: null,
} as const;
const MAX_WASM_BYTES = 64 * 1024 * 1024;
const MAX_GLUE_BYTES = 8 * 1024 * 1024;

const inputFailure = (message: string): AnalysisInputError =>
  new AnalysisInputError(OPERATION, { userMessage: message });

/** Decode a local wasm/glue pair without executing either file. */
export const inspectWasmBridge = async (
  rawInput: unknown,
  options?: ExecutionOptions,
): Promise<Result<Evidence, AnalysisError>> => {
  const parsed = parseAnalysisInput(
    OPERATION,
    rawInput,
    wasmBridgeInputSchema,
    options?.signal,
  );
  if (!parsed.ok) return parsed;
  const { wasm_path: wasmPath, js_path: jsPath } = parsed.value;
  const [wasmBytes, glueBytes] = await Promise.all([
    readFile(wasmPath).catch((cause: unknown) => cause),
    readFile(jsPath).catch((cause: unknown) => cause),
  ]);
  if (!(wasmBytes instanceof Buffer))
    return err(inputFailure(`The WASM file could not be read: ${wasmPath}`));
  if (!(glueBytes instanceof Buffer))
    return err(
      inputFailure(`The JavaScript glue could not be read: ${jsPath}`),
    );
  if (wasmBytes.byteLength > MAX_WASM_BYTES)
    return err(
      inputFailure(
        `The WASM file is ${String(wasmBytes.byteLength)} bytes; the limit is ${String(MAX_WASM_BYTES)}.`,
      ),
    );
  if (glueBytes.byteLength > MAX_GLUE_BYTES)
    return err(
      inputFailure(
        `The JavaScript glue is ${String(glueBytes.byteLength)} bytes; the limit is ${String(MAX_GLUE_BYTES)}.`,
      ),
    );
  options?.signal?.throwIfAborted();

  let wasm;
  try {
    wasm = readWasmInterface(
      new Uint8Array(
        wasmBytes.buffer,
        wasmBytes.byteOffset,
        wasmBytes.byteLength,
      ),
    );
  } catch (cause: unknown) {
    return err(
      new AnalysisInputError(OPERATION, {
        cause,
        userMessage: "The selected file is not a supported WebAssembly module.",
      }),
    );
  }
  let glue;
  try {
    glue = analyzeGlue(glueBytes.toString("utf8").replace(/^\uFEFF/u, ""));
  } catch (cause: unknown) {
    return err(
      new AnalysisInputError(OPERATION, {
        cause,
        userMessage: "The selected JavaScript glue could not be parsed.",
      }),
    );
  }
  const graph = buildBridgeGraph(wasm, glue);
  const report = wasmBridgeResultSchema.parse({
    wasm: {
      path: wasmPath,
      sha256: createHash("sha256").update(wasmBytes).digest("hex"),
      bytes: wasmBytes.byteLength,
    },
    glue: {
      path: jsPath,
      sha256: createHash("sha256").update(glueBytes).digest("hex"),
      bytes: glueBytes.byteLength,
    },
    imports: wasm.imports,
    exports: wasm.exports,
    js_to_wasm: graph.jsToWasm,
    wasm_to_js: graph.wasmToJs,
    unresolved_imports: graph.unresolvedImports,
    unused_exports: graph.unusedExports,
    instantiation_line: graph.instantiationLine ?? null,
    coverage: {
      wasm: "imports_and_exports",
      glue: "static_literal_bindings",
    },
    limitations: [
      "Static import/export and literal glue matching only; no wasm instantiation or runtime reachability.",
      "Internal function-index mapping and WAT decompilation are not part of this bridge report.",
    ],
  });
  const evidence = createEvidence(undefined, PROVIDER, {
    operation: OPERATION,
    predicateType: "rea.wasm-bridge",
    parameters: { wasm_path: wasmPath, js_path: jsPath },
    result: report,
    confidence: "derived",
    authority: "analyst-inference",
    limitations: report.limitations,
  });
  return ok(evidence);
};
