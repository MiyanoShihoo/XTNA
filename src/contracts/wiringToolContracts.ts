import { z } from "zod";

import { jsonValueSchema } from "../domain/jsonValue.js";
import { toolContractMetadata } from "./toolEffects.js";
import type { ToolContract } from "./toolContractTypes.js";

export const openApiFromCaptureInputSchema = z.strictObject({
  capture_path: z.string().min(1),
  title: z.string().min(1).optional(),
  version: z.string().min(1).optional(),
  server_url: z.string().min(1).optional(),
  with_synthesis: z.boolean().optional(),
});

export const openApiFromCaptureOutputSchema = z.strictObject({
  openapi: z.literal("3.1.0"),
  paths: z.number().int().nonnegative(),
  operations: z.number().int().nonnegative(),
  synthesis: z.boolean(),
  document: jsonValueSchema,
});

export const hypothesisBoardInspectInputSchema = z.strictObject({
  store_path: z.string().min(1),
  id: z.string().min(1).optional(),
  evidence: z.string().min(1).optional(),
});

export const hypothesisBoardInspectOutputSchema = z.strictObject({
  schema: z.literal("xtna.hypothesis-board/1"),
  records: z.array(jsonValueSchema),
});

/** Typed contracts that expose local artefacts through the same builders the CLIs use. */
export const WIRING_TOOL_CONTRACTS = [
  {
    name: "openapi_from_capture",
    ...toolContractMetadata("openapi_from_capture"),
    kind: "application",
    description:
      "Build an OpenAPI 3.1 document from a recorded HAR capture with the typed schema-synthesis contract. Schemas come from per-pointer evidence; with_synthesis attaches the complete result (dialect, sample count, evidence, ambiguities, enum candidates) per operation. Reads one local capture; it does not replay requests or contact the recorded server.",
    inputSchema: openApiFromCaptureInputSchema,
    outputSchema: openApiFromCaptureOutputSchema,
    examples: [
      {
        title: "Infer a spec with synthesis evidence",
        input: { capture_path: "capture.har", with_synthesis: true },
      },
    ],
  },
  {
    name: "hypothesis_board_inspect",
    ...toolContractMetadata("hypothesis_board_inspect"),
    kind: "application",
    description:
      "Read a typed hypothesis board store and return validated records, optionally filtered by hypothesis id or evidence id. Read-only: it never creates, transitions or deletes a claim; use the hypothesis:board CLI for writes. An invalid record refuses the whole store instead of returning partial state.",
    inputSchema: hypothesisBoardInspectInputSchema,
    outputSchema: hypothesisBoardInspectOutputSchema,
    examples: [
      {
        title: "Read one claim",
        input: { store_path: "board.json", id: "h1" },
      },
    ],
  },
] as const satisfies readonly ToolContract[];
