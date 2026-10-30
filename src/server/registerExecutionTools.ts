import { createHash } from "node:crypto";

import type { CallToolResult } from "@modelcontextprotocol/server";

import {
  RUN_PLAN_CONTRACT,
  runPlanInputSchema,
} from "../contracts/executionToolContracts.js";
import { TOOL_EFFECTS } from "../contracts/toolEffects.js";
import {
  executeReActDag,
  type PlanTask,
} from "../application/execution/ReActDagPlanner.js";
import { AnalysisInputError } from "../domain/analysisErrorCore.js";
import { jsonValueSchema, type JsonValue } from "../domain/jsonValue.js";
import { err, ok } from "../domain/result.js";
import type { EvidenceMcpServer } from "./EvidenceMcpServer.js";
import { toolRegistrationOptions } from "./toolRegistrationOptions.js";

const MAX_INLINE_TASK_OUTPUT_BYTES = 64 * 1024;
/** Explicit static-analysis surface; write and session-control tools stay out. */
const PLAN_READ_ONLY_TOOLS = new Set([
  "analyze_function",
  "binary_overview",
  "compare_artifacts",
  "compare_functions",
  "find_xrefs_to_name",
  "get_objc_classes",
  "get_objc_protocols",
  "inspect_analysis_settings",
  "list_documents",
  "list_names",
  "list_procedures",
  "list_segments",
  "list_strings",
  "search_bytes",
  "search_procedures",
  "search_strings",
  "trace_call_path",
]);
type PlanTaskInput = {
  readonly tool: string;
  readonly arguments: Readonly<Record<string, JsonValue>>;
};

const resultText = (result: CallToolResult): string =>
  result.content
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("\n");

const projectTaskOutput = (result: CallToolResult): JsonValue => {
  const raw =
    result.structuredContent ??
    (resultText(result).length === 0 ? null : resultText(result));
  const serialized = JSON.stringify(raw);
  const bytes = Buffer.byteLength(serialized, "utf8");
  if (bytes <= MAX_INLINE_TASK_OUTPUT_BYTES) {
    const parsed = jsonValueSchema.safeParse(raw);
    return parsed.success ? parsed.data : serialized;
  }
  return {
    truncated: true,
    bytes,
    digest: createHash("sha256").update(serialized).digest("hex"),
    preview: serialized.slice(0, MAX_INLINE_TASK_OUTPUT_BYTES),
  };
};

/** Register the bounded in-process plan executor. */
export const registerExecutionTools = (server: EvidenceMcpServer): void => {
  server.registerTool(
    RUN_PLAN_CONTRACT.name,
    toolRegistrationOptions(RUN_PLAN_CONTRACT),
    async (rawInput, context) => {
      const parsed = runPlanInputSchema.safeParse(rawInput);
      if (!parsed.success)
        return server.delivery.toCallToolResult(
          err(
            new AnalysisInputError("run_plan", {
              userMessage:
                "The plan does not match the run_plan input contract.",
            }),
          ),
          RUN_PLAN_CONTRACT,
        );

      for (const task of parsed.data.tasks) {
        if (!PLAN_READ_ONLY_TOOLS.has(task.tool))
          return server.delivery.toCallToolResult(
            err(
              new AnalysisInputError("run_plan", {
                userMessage: `The plan tool ${task.tool} is outside the read-only plan surface.`,
              }),
            ),
            RUN_PLAN_CONTRACT,
          );
        const effects = TOOL_EFFECTS[task.tool];
        if (effects === undefined)
          return server.delivery.toCallToolResult(
            err(
              new AnalysisInputError("run_plan", {
                userMessage: `The plan names an unregistered tool: ${task.tool}`,
              }),
            ),
            RUN_PLAN_CONTRACT,
          );
        if (
          effects.mutatesTarget ||
          effects.writesFilesystem ||
          effects.mayDiscardData ||
          effects.executesForeignCode ||
          effects.mutatesDevice ||
          effects.changesUiState
        )
          return server.delivery.toCallToolResult(
            err(
              new AnalysisInputError("run_plan", {
                userMessage: `The plan tool ${task.tool} has write, destructive, foreign-code, device or UI effects and cannot run in a read-only plan.`,
              }),
            ),
            RUN_PLAN_CONTRACT,
          );
      }

      const tasks: PlanTask<PlanTaskInput, JsonValue>[] = parsed.data.tasks.map(
        (task) => ({
          id: task.id,
          operation: task.tool,
          authority: "read-only",
          ...(task.dry_run ? { dryRun: true } : {}),
          dependencies: task.dependencies,
          input: { tool: task.tool, arguments: task.arguments },
          execute: async (selected, _dependencies, signal) => {
            const nested = await server.invokeRegisteredTool(
              selected.tool,
              selected.arguments,
              signal,
            );
            if (nested.isError === true)
              throw new Error(resultText(nested) || `${selected.tool} failed`);
            return projectTaskOutput(nested);
          },
        }),
      );
      const result = await executeReActDag(tasks, {
        maxConcurrency: parsed.data.max_concurrency,
        signal: context.mcpReq.signal,
      });
      const results: JsonValue[] = result.results.map((entry) => ({
        id: entry.id,
        status: entry.status,
        ...(entry.output === undefined
          ? {}
          : { output: entry.output as JsonValue }),
        ...(entry.error === undefined ? {} : { error: entry.error }),
      }));
      const projected: JsonValue = {
        status: result.status,
        max_concurrency: result.maxConcurrency,
        results,
      };
      return server.delivery.toCallToolResult(ok(projected), RUN_PLAN_CONTRACT);
    },
  );
};
