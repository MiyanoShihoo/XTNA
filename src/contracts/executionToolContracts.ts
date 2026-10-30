import { z } from "zod";

import { jsonValueSchema } from "../domain/jsonValue.js";
import { toolContractMetadata } from "./toolEffects.js";
import type { ToolContract } from "./toolContractTypes.js";

const planTaskSchema = z.strictObject({
  id: z.string().min(1).max(128),
  tool: z.string().min(1).max(128),
  arguments: z.record(z.string(), jsonValueSchema),
  dependencies: z.array(z.string().min(1).max(128)).max(64).default([]),
  dry_run: z.boolean().default(false),
});

export const runPlanInputSchema = z.strictObject({
  max_concurrency: z.number().int().min(1).max(8).default(4),
  tasks: z.array(planTaskSchema).min(1).max(64),
});

export const runPlanTaskResultSchema = z.strictObject({
  id: z.string().min(1),
  status: z.enum(["completed", "failed", "blocked", "skipped", "cancelled"]),
  output: jsonValueSchema.optional(),
  output_digest: z
    .string()
    .regex(/^[a-f0-9]{64}$/u)
    .optional(),
  output_truncated: z.boolean().optional(),
  error: z.string().optional(),
});

export const runPlanResultSchema = z.strictObject({
  status: z.enum(["completed", "partial", "cancelled"]),
  max_concurrency: z.number().int().min(1).max(8),
  results: z.array(runPlanTaskResultSchema),
});

export const RUN_PLAN_CONTRACT = {
  name: "run_plan",
  ...toolContractMetadata("run_plan"),
  kind: "application",
  description:
    "Run a bounded dependency-aware plan of read-only, already-registered analysis tools. Tasks declare a tool name, JSON arguments and optional dependencies; independent tasks run concurrently up to max_concurrency. Only tools on the static-analysis surface, without target mutation, filesystem writes, foreign-code execution, device mutation or discardable state, are admitted. Each task output is retained as a bounded JSON projection with its SHA-256 digest; a plan never invokes itself or a write/destructive tool.",
  inputSchema: runPlanInputSchema,
  outputSchema: runPlanResultSchema,
  examples: [
    {
      title: "Read names and strings concurrently",
      input: {
        max_concurrency: 2,
        tasks: [
          { id: "names", tool: "list_names", arguments: {} },
          { id: "strings", tool: "list_strings", arguments: {} },
          {
            id: "summary",
            tool: "search_strings",
            arguments: { pattern: "password" },
            dependencies: ["names", "strings"],
          },
        ],
      },
    },
  ],
} as const satisfies ToolContract;
