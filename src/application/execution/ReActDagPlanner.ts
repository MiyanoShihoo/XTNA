import {
  authorizeCommand,
  type CommandRequest,
} from "../../domain/execution/CommandAuthority.js";

export interface PlanTask<
  Input = unknown,
  Output = unknown,
> extends CommandRequest {
  readonly id: string;
  readonly dependencies?: readonly string[];
  readonly input: Input;
  readonly execute: (
    input: Input,
    dependencies: Readonly<Record<string, unknown>>,
    signal: AbortSignal,
  ) => Promise<Output>;
}

export interface TaskResult {
  readonly id: string;
  readonly status: "completed" | "failed" | "blocked" | "skipped" | "cancelled";
  readonly output?: unknown;
  readonly error?: string;
}

export interface PlanResult {
  readonly status: "completed" | "partial" | "cancelled";
  readonly results: readonly TaskResult[];
  readonly maxConcurrency: number;
}

const failure = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

/** Bounded dependency scheduling; failed dependencies never run their dependents. */
export const executeReActDag = async (
  tasks: readonly PlanTask<any, any>[],
  {
    maxConcurrency = 4,
    signal = new AbortController().signal,
  }: { maxConcurrency?: number; signal?: AbortSignal } = {},
): Promise<PlanResult> => {
  if (
    !Number.isInteger(maxConcurrency) ||
    maxConcurrency < 1 ||
    maxConcurrency > 64
  )
    throw new RangeError("maxConcurrency must be an integer from 1 to 64");
  const definitions = new Map(tasks.map((task) => [task.id, task]));
  if (definitions.size !== tasks.length)
    throw new TypeError("Task identifiers must be unique");
  for (const task of tasks) {
    if (task.id.length === 0)
      throw new TypeError("Task identifiers must be nonempty");
    for (const dependency of task.dependencies ?? []) {
      if (dependency === task.id)
        throw new TypeError(`Task cannot depend on itself: ${dependency}`);
      if (!definitions.has(dependency))
        throw new TypeError(`Unknown dependency: ${dependency}`);
    }
  }
  const pending = new Map(tasks.map((task) => [task.id, task]));
  const running = new Set<Promise<void>>();
  const results = new Map<string, TaskResult>();
  const runningIds = new Set<string>();
  let cancelled = signal.aborted;
  const abort = () => {
    cancelled = true;
  };
  signal.addEventListener("abort", abort, { once: true });
  const record = (result: TaskResult) => {
    results.set(result.id, result);
    pending.delete(result.id);
  };
  try {
    while (pending.size > 0 || running.size > 0) {
      if (cancelled) {
        for (const task of pending.values())
          record({
            id: task.id,
            status: "cancelled",
            error: "Execution cancelled before task start.",
          });
        await Promise.allSettled(running);
        break;
      }
      let ready = 0;
      for (const task of pending.values()) {
        if (running.size >= maxConcurrency) break;
        const dependencies = task.dependencies ?? [];
        if (dependencies.some((id) => pending.has(id) || runningIds.has(id)))
          continue;
        const failed = dependencies
          .map((id) => results.get(id))
          .find((result) => result?.status !== "completed");
        if (failed) {
          record({
            id: task.id,
            status: "skipped",
            error: `Dependency ${failed.id} did not complete.`,
          });
          ready += 1;
          continue;
        }
        const decision = authorizeCommand(task);
        if (!decision.allowed) {
          record({ id: task.id, status: "blocked", error: decision.reason });
          ready += 1;
          continue;
        }
        if (!decision.executed) {
          record({
            id: task.id,
            status: "completed",
            output: {
              dryRun: true,
              operation: task.operation,
              authority: task.authority,
            },
          });
          ready += 1;
          continue;
        }
        pending.delete(task.id);
        runningIds.add(task.id);
        ready += 1;
        const dependencyOutputs = Object.freeze(
          Object.fromEntries(
            dependencies.map((id) => [id, results.get(id)?.output]),
          ),
        );
        const execution = Promise.resolve()
          .then(() => task.execute(task.input, dependencyOutputs, signal))
          .then(
            (output) => {
              results.set(task.id, {
                id: task.id,
                status: "completed",
                output,
              });
            },
            (cause: unknown) => {
              results.set(task.id, {
                id: task.id,
                status: signal.aborted ? "cancelled" : "failed",
                error: failure(cause),
              });
            },
          )
          .finally(() => {
            running.delete(execution);
            runningIds.delete(task.id);
          });
        running.add(execution);
      }
      if (running.size > 0) await Promise.race(running);
      else if (ready === 0 && pending.size > 0) {
        for (const task of pending.values())
          record({
            id: task.id,
            status: "blocked",
            error: "Dependency cycle prevents scheduling.",
          });
      }
    }
  } finally {
    signal.removeEventListener("abort", abort);
  }
  return {
    status: cancelled
      ? "cancelled"
      : [...results.values()].some(({ status }) => status !== "completed")
        ? "partial"
        : "completed",
    results: tasks
      .map(({ id }) => results.get(id))
      .filter((result): result is TaskResult => result !== undefined),
    maxConcurrency,
  };
};
