import { z } from "zod";

import { toolContractMetadata } from "../toolEffects.js";
import type { ToolContract } from "../toolContractTypes.js";

const roleSchema = z.enum([
  "static-worker",
  "runtime-worker",
  "contract-worker",
]);
const taskSchema = z.strictObject({
  id: z.string().min(1).max(128),
  role: roleSchema,
  objective: z.string().min(1).max(2_000),
  dependencies: z.array(z.string().min(1).max(128)).max(16),
  status: z.enum(["running", "completed", "failed", "cancelled"]),
  evidence_ids: z.array(z.string().min(1).max(256)).max(64),
  summary: z.string().max(2_000).optional(),
  created_at: z.string().min(1),
  finished_at: z.string().min(1).optional(),
});
const snapshotSchema = z.strictObject({
  task: taskSchema,
  counts: z.strictObject({
    running: z.number().int().nonnegative(),
    completed: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    cancelled: z.number().int().nonnegative(),
  }),
  evidence_index: z.record(z.string(), z.array(z.string().min(1))),
});

export const subagentTaskStartInputSchema = z.strictObject({
  id: z.string().min(1).max(128),
  role: roleSchema,
  objective: z.string().min(1).max(2_000),
  dependencies: z.array(z.string().min(1).max(128)).max(16).optional(),
});
export const subagentTaskFinishInputSchema = z.strictObject({
  id: z.string().min(1).max(128),
  status: z.enum(["completed", "failed", "cancelled"]),
  evidence_ids: z.array(z.string().min(1).max(256)).max(64).optional(),
  summary: z.string().max(2_000).optional(),
});

export const SUBAGENT_START_CONTRACT = {
  name: "subagent_task_start",
  ...toolContractMetadata("subagent_task_start"),
  kind: "application",
  description:
    "Register one session-scoped sub-agent task with a role (static-worker, runtime-worker or contract-worker), an objective and optional completed-task dependencies. This is a role/ledger contract: it does not launch an LLM, process or remote agent. Independent tasks may run concurrently; a dependent cannot start until its named tasks complete.",
  inputSchema: subagentTaskStartInputSchema,
  outputSchema: snapshotSchema,
  examples: [
    {
      title: "Start a static worker",
      input: {
        id: "static-map",
        role: "static-worker",
        objective: "map JavaScript reachability",
      },
    },
  ],
} as const satisfies ToolContract;

export const SUBAGENT_FINISH_CONTRACT = {
  name: "subagent_task_finish",
  ...toolContractMetadata("subagent_task_finish"),
  kind: "application",
  description:
    "Finish a running sub-agent task with completed, failed or cancelled status. A completed task must name at least one supporting Evidence id; the returned snapshot includes the shared Evidence index. This contract does not launch or terminate an external worker.",
  inputSchema: subagentTaskFinishInputSchema,
  outputSchema: snapshotSchema,
  examples: [
    {
      title: "Finish a runtime worker",
      input: {
        id: "runtime-map",
        status: "completed",
        evidence_ids: ["ev_0123abcd"],
        summary: "observed reconnect path",
      },
    },
  ],
} as const satisfies ToolContract;
