import { err, ok, type Result } from "../../domain/result.js";

export type SubagentRole =
  | "static-worker"
  | "runtime-worker"
  | "contract-worker";
export type SubagentTaskStatus =
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export interface SubagentTask {
  readonly id: string;
  readonly role: SubagentRole;
  readonly objective: string;
  readonly dependencies: readonly string[];
  readonly status: SubagentTaskStatus;
  readonly evidenceIds: readonly string[];
  readonly summary?: string;
  readonly createdAt: string;
  readonly finishedAt?: string;
}

export type SubagentBoardError =
  | {
      readonly code: "invalid-task" | "unknown-task" | "invalid-transition";
      readonly message: string;
    }
  | {
      readonly code: "unsatisfied-dependency";
      readonly message: string;
      readonly dependency: string;
    }
  | {
      readonly code: "task-limit";
      readonly message: string;
      readonly limit: number;
    };

export interface SubagentTaskStart {
  readonly id: string;
  readonly role: SubagentRole;
  readonly objective: string;
  readonly dependencies?: readonly string[];
}

export interface SubagentTaskFinish {
  readonly id: string;
  readonly status: "completed" | "failed" | "cancelled";
  readonly evidenceIds?: readonly string[];
  readonly summary?: string;
}

const MAX_TASKS = 32;
const MAX_EVIDENCE_IDS = 64;

const invalid = (
  code: "invalid-task" | "unknown-task" | "invalid-transition",
  message: string,
): SubagentBoardError => ({ code, message });

/** Session-scoped role registry with dependency and evidence accounting. */
export class SubagentTaskBoard {
  readonly #tasks = new Map<string, SubagentTask>();

  start(input: SubagentTaskStart): Result<SubagentTask, SubagentBoardError> {
    if (input.id.trim().length === 0)
      return err(invalid("invalid-task", "Task id must be nonempty."));
    if (this.#tasks.has(input.id))
      return err(invalid("invalid-task", `Task already exists: ${input.id}`));
    if (this.#tasks.size >= MAX_TASKS)
      return err({
        code: "task-limit",
        message: `The task board holds at most ${String(MAX_TASKS)} tasks.`,
        limit: MAX_TASKS,
      });
    if (input.objective.trim().length === 0)
      return err(invalid("invalid-task", "Task objective must be nonempty."));
    const dependencies = [...new Set(input.dependencies ?? [])];
    for (const dependency of dependencies) {
      if (dependency === input.id)
        return err(invalid("invalid-task", "A task cannot depend on itself."));
      const task = this.#tasks.get(dependency);
      if (task === undefined)
        return err({
          code: "unsatisfied-dependency",
          message: `Unknown dependency: ${dependency}`,
          dependency,
        });
      if (task.status !== "completed")
        return err({
          code: "unsatisfied-dependency",
          message: `Dependency ${dependency} is not completed.`,
          dependency,
        });
    }
    const task: SubagentTask = {
      id: input.id,
      role: input.role,
      objective: input.objective,
      dependencies,
      status: "running",
      evidenceIds: [],
      createdAt: new Date().toISOString(),
    };
    this.#tasks.set(task.id, task);
    return ok(task);
  }

  finish(input: SubagentTaskFinish): Result<SubagentTask, SubagentBoardError> {
    const task = this.#tasks.get(input.id);
    if (task === undefined)
      return err(invalid("unknown-task", `Unknown task: ${input.id}`));
    if (task.status !== "running")
      return err(
        invalid(
          "invalid-transition",
          `Task ${input.id} is already ${task.status}.`,
        ),
      );
    const evidenceIds = [...new Set(input.evidenceIds ?? [])];
    if (input.status === "completed" && evidenceIds.length === 0)
      return err(
        invalid(
          "invalid-task",
          "A completed task must name at least one supporting Evidence id.",
        ),
      );
    if (evidenceIds.length > MAX_EVIDENCE_IDS)
      return err(
        invalid(
          "invalid-task",
          `A task may name at most ${String(MAX_EVIDENCE_IDS)} Evidence ids.`,
        ),
      );
    const next: SubagentTask = {
      ...task,
      status: input.status,
      evidenceIds,
      ...(input.summary === undefined ? {} : { summary: input.summary }),
      finishedAt: new Date().toISOString(),
    };
    this.#tasks.set(task.id, next);
    return ok(next);
  }

  list(): readonly SubagentTask[] {
    return [...this.#tasks.values()];
  }

  /** Evidence id → task ids, so a shared ledger can locate the claimants. */
  evidenceIndex(): Readonly<Record<string, readonly string[]>> {
    const index = new Map<string, string[]>();
    for (const task of this.#tasks.values())
      for (const evidenceId of task.evidenceIds) {
        const owners = index.get(evidenceId) ?? [];
        owners.push(task.id);
        index.set(evidenceId, owners);
      }
    return Object.fromEntries(
      [...index.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([evidenceId, owners]) => [evidenceId, [...owners].sort()]),
    );
  }
}
