import {
  SUBAGENT_FINISH_CONTRACT,
  SUBAGENT_START_CONTRACT,
  subagentTaskFinishInputSchema,
  subagentTaskStartInputSchema,
} from "../contracts/execution/subagentToolContracts.js";
import {
  SubagentTaskBoard,
  type SubagentTask,
} from "../application/execution/SubagentTaskBoard.js";
import { AnalysisInputError } from "../domain/analysisErrorCore.js";
import type { JsonValue } from "../domain/jsonValue.js";
import { err, ok } from "../domain/result.js";
import type { EvidenceMcpServer } from "./EvidenceMcpServer.js";
import { toolRegistrationOptions } from "./toolRegistrationOptions.js";

const taskJson = (task: SubagentTask): JsonValue => ({
  id: task.id,
  role: task.role,
  objective: task.objective,
  dependencies: [...task.dependencies],
  status: task.status,
  evidence_ids: [...task.evidenceIds],
  ...(task.summary === undefined ? {} : { summary: task.summary }),
  created_at: task.createdAt,
  ...(task.finishedAt === undefined ? {} : { finished_at: task.finishedAt }),
});

const snapshot = (board: SubagentTaskBoard, task: SubagentTask): JsonValue => {
  const counts = {
    running: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
  };
  for (const entry of board.list()) counts[entry.status] += 1;
  return {
    task: taskJson(task),
    counts,
    evidence_index: board.evidenceIndex() as JsonValue,
  };
};

/** Register session-scoped role/task contracts; no external worker is launched. */
export const registerSubagentTools = (server: EvidenceMcpServer): void => {
  const board = new SubagentTaskBoard();
  server.registerTool(
    SUBAGENT_START_CONTRACT.name,
    toolRegistrationOptions(SUBAGENT_START_CONTRACT),
    async (rawInput) => {
      const parsed = subagentTaskStartInputSchema.safeParse(rawInput);
      if (!parsed.success)
        return server.delivery.toCallToolResult(
          err(
            new AnalysisInputError("subagent_task_start", {
              userMessage:
                "The task does not match the subagent start contract.",
            }),
          ),
          SUBAGENT_START_CONTRACT,
        );
      const started = board.start({
        id: parsed.data.id,
        role: parsed.data.role,
        objective: parsed.data.objective,
        ...(parsed.data.dependencies === undefined
          ? {}
          : { dependencies: parsed.data.dependencies }),
      });
      return started.ok
        ? server.delivery.toCallToolResult(
            ok(snapshot(board, started.value)),
            SUBAGENT_START_CONTRACT,
          )
        : server.delivery.toCallToolResult(
            err(
              new AnalysisInputError("subagent_task_start", {
                userMessage: started.error.message,
              }),
            ),
            SUBAGENT_START_CONTRACT,
          );
    },
  );
  server.registerTool(
    SUBAGENT_FINISH_CONTRACT.name,
    toolRegistrationOptions(SUBAGENT_FINISH_CONTRACT),
    async (rawInput) => {
      const parsed = subagentTaskFinishInputSchema.safeParse(rawInput);
      if (!parsed.success)
        return server.delivery.toCallToolResult(
          err(
            new AnalysisInputError("subagent_task_finish", {
              userMessage:
                "The task does not match the subagent finish contract.",
            }),
          ),
          SUBAGENT_FINISH_CONTRACT,
        );
      const finished = board.finish({
        id: parsed.data.id,
        status: parsed.data.status,
        ...(parsed.data.evidence_ids === undefined
          ? {}
          : { evidenceIds: parsed.data.evidence_ids }),
        ...(parsed.data.summary === undefined
          ? {}
          : { summary: parsed.data.summary }),
      });
      return finished.ok
        ? server.delivery.toCallToolResult(
            ok(snapshot(board, finished.value)),
            SUBAGENT_FINISH_CONTRACT,
          )
        : server.delivery.toCallToolResult(
            err(
              new AnalysisInputError("subagent_task_finish", {
                userMessage: finished.error.message,
              }),
            ),
            SUBAGENT_FINISH_CONTRACT,
          );
    },
  );
};
