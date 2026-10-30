import { z } from "zod";

import { toolContractMetadata } from "../toolEffects.js";
import type { ToolContract } from "../toolContractTypes.js";

export const wasmBridgeInputSchema = z.strictObject({
  wasm_path: z.string().min(1),
  js_path: z.string().min(1),
});

const importSchema = z.strictObject({
  module: z.string(),
  name: z.string(),
  kind: z.enum(["function", "table", "memory", "global", "unknown"]),
});
const exportSchema = z.strictObject({
  name: z.string(),
  kind: z.enum(["function", "table", "memory", "global", "unknown"]),
});
const functionSchema = z.strictObject({
  index: z.number().int().nonnegative(),
  kind: z.enum(["imported", "defined"]),
  type_index: z.number().int().nonnegative(),
  module: z.string().nullable(),
  name: z.string().nullable(),
  exports: z.array(z.string()),
});
const edgeSchema = z.strictObject({
  from: z.string(),
  to: z.string(),
  line: z.number().int().positive(),
});

export const wasmBridgeResultSchema = z.strictObject({
  wasm: z.strictObject({
    path: z.string(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/u),
    bytes: z.number().int().nonnegative(),
  }),
  glue: z.strictObject({
    path: z.string(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/u),
    bytes: z.number().int().nonnegative(),
  }),
  imports: z.array(importSchema),
  exports: z.array(exportSchema),
  functions: z.array(functionSchema),
  js_to_wasm: z.array(edgeSchema),
  wasm_to_js: z.array(edgeSchema),
  unresolved_imports: z.array(z.string()),
  unused_exports: z.array(z.string()),
  instantiation_line: z.number().int().positive().nullable(),
  coverage: z.strictObject({
    wasm: z.literal("imports_exports_and_function_index"),
    glue: z.literal("static_literal_bindings"),
  }),
  limitations: z.array(z.string()),
});

export const WASM_BRIDGE_CONTRACT = {
  name: "wasm_bridge",
  ...toolContractMetadata("wasm_bridge"),
  kind: "application",
  description:
    "Statically link one local WebAssembly module to one local JavaScript glue file. Decode the wasm import/export/function sections and literal glue import-object bindings and `exports.<name>` accesses; return the function index space, candidate js→wasm and wasm→js edges, unresolved imports, unused exports and instantiation line. Nothing is instantiated or executed. This is a byte/structure candidate graph, not runtime reachability; intra-function call graphs and WAT decompilation are not included.",
  inputSchema: wasmBridgeInputSchema,
  outputSchema: wasmBridgeResultSchema,
  examples: [
    {
      title: "Link a wasm module to its generated glue",
      input: {
        wasm_path: "/artifacts/module.wasm",
        js_path: "/artifacts/module.js",
      },
    },
  ],
} as const satisfies ToolContract;
