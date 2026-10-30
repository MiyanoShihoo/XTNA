/**
 * In-process worker scheduler for role-separated sub-agent work.
 *
 * The scheduler owns the part of sub-agent orchestration that can be verified
 * locally: dependency waves, bounded retries, delivery of a cancellation signal
 * to running workers, and blocking of everything downstream of a failed task.
 *
 * It does not launch OS processes or LLM sessions. A worker is a caller-supplied
 * async function; spawning real workers (or wiring this to an MCP surface) stays
 * outside this module and is reported as an open gap.
 */
import type { Result } from "../../domain/result.js";
import { err, ok } from "../../domain/result.js";

export type WorkerRole = "static-worker" | "runtime-worker" | "contract-worker";

export interface WorkerTaskSpec {
  readonly id: string;
  readonly role: WorkerRole;
  readonly objective: string;
  readonly dependencies?: readonly string[];
}

export interface WorkerTaskInput {
  readonly id: string;
  readonly role: WorkerRole;
  readonly objective: string;
  readonly attempt: number;
}

export interface WorkerReport {
  readonly evidenceIds?: readonly string[];
  readonly summary?: string;
}

/** A worker either resolves a report or throws; throwing is a failed attempt. */
export type WorkerHandler = (
  task: WorkerTaskInput,
  context: { readonly signal: AbortSignal },
) => Promise<WorkerReport>;

export type WorkerTaskStatus = "completed" | "failed" | "blocked" | "cancelled";

export interface WorkerTaskResult {
  readonly id: string;
  readonly role: WorkerRole;
  readonly status: WorkerTaskStatus;
  readonly attempts: number;
  readonly evidenceIds: readonly string[];
  readonly summary?: string;
  readonly reason?: string;
}

export interface WorkerRunReport {
  readonly waves: readonly (readonly string[])[];
  readonly tasks: readonly WorkerTaskResult[];
  readonly cancelled: readonly string[];
  readonly startedAt: string;
  readonly finishedAt: string;
}

export type WorkerPlanError =
  | { readonly code: "empty-plan"; readonly message: string }
  | {
      readonly code: "duplicate-task";
      readonly message: string;
      readonly task: string;
    }
  | {
      readonly code: "unknown-dependency";
      readonly message: string;
      readonly task: string;
      readonly dependency: string;
    }
  | {
      readonly code: "dependency-cycle";
      readonly message: string;
      readonly tasks: readonly string[];
    }
  | {
      readonly code: "task-limit";
      readonly message: string;
      readonly limit: number;
    }
  | {
      readonly code: "self-dependency";
      readonly message: string;
      readonly task: string;
    };

export interface WorkerRunOptions {
  readonly handlers: Partial<Record<WorkerRole, WorkerHandler>>;
  /** Attempts per task, including the first. Defaults to 2. */
  readonly maxAttempts?: number;
  /** Per-attempt wall clock. Defaults to 15000 ms. */
  readonly timeoutMs?: number;
  /** Delivers cancellation to running workers and stops scheduling new ones. */
  readonly signal?: AbortSignal;
}

const MAX_TASKS = 32;
const MAX_EVIDENCE_IDS = 64;

const duplicate = (task: string): WorkerPlanError => ({
  code: "duplicate-task",
  message: `Duplicate task id: ${task}`,
  task,
});

/** Group tasks into dependency waves; rejects cycles and unknown dependencies. */
export function planWaves(
  tasks: readonly WorkerTaskSpec[],
): Result<readonly (readonly string[])[], WorkerPlanError> {
  if (tasks.length === 0)
    return err({
      code: "empty-plan",
      message: "A worker plan needs at least one task.",
    });
  if (tasks.length > MAX_TASKS)
    return err({
      code: "task-limit",
      message: `A worker plan holds at most ${String(MAX_TASKS)} tasks.`,
      limit: MAX_TASKS,
    });
  const byId = new Map<string, WorkerTaskSpec>();
  for (const task of tasks) {
    if (byId.has(task.id)) return err(duplicate(task.id));
    byId.set(task.id, task);
  }
  const pending = new Map<string, Set<string>>();
  for (const task of tasks) {
    const dependencies = new Set(task.dependencies ?? []);
    if (dependencies.has(task.id))
      return err({
        code: "self-dependency",
        message: `Task ${task.id} depends on itself.`,
        task: task.id,
      });
    for (const dependency of dependencies)
      if (!byId.has(dependency))
        return err({
          code: "unknown-dependency",
          message: `Task ${task.id} depends on unknown ${dependency}.`,
          task: task.id,
          dependency,
        });
    pending.set(task.id, dependencies);
  }
  const waves: string[][] = [];
  const resolved = new Set<string>();
  while (resolved.size < tasks.length) {
    const wave = tasks
      .filter((task) => !resolved.has(task.id))
      .filter((task) =>
        [...(pending.get(task.id) ?? [])].every((dependency) =>
          resolved.has(dependency),
        ),
      )
      .map((task) => task.id);
    if (wave.length === 0) {
      const remaining = tasks
        .filter((task) => !resolved.has(task.id))
        .map((task) => task.id)
        .sort();
      return err({
        code: "dependency-cycle",
        message: `Dependency cycle among: ${remaining.join(", ")}`,
        tasks: remaining,
      });
    }
    for (const id of wave) resolved.add(id);
    waves.push(wave.sort());
  }
  return ok(waves);
}

class AttemptAborted extends Error {
  readonly cancelled: boolean;

  constructor(cancelled: boolean, message: string) {
    super(message);
    this.cancelled = cancelled;
  }
}

const bounded = (values: readonly string[] | undefined): readonly string[] =>
  values === undefined ? [] : [...new Set(values)].slice(0, MAX_EVIDENCE_IDS);

interface AttemptInput {
  readonly task: WorkerTaskSpec;
  readonly handler: WorkerHandler;
  readonly attempt: number;
  readonly timeoutMs: number;
  readonly outer: AbortSignal | undefined;
}

const attemptOnce = async (input: AttemptInput): Promise<WorkerReport> => {
  const { task, handler, attempt, timeoutMs, outer } = input;
  const controller = new AbortController();
  const abort = (cancelled: boolean, message: string): void => {
    controller.abort(new AttemptAborted(cancelled, message));
  };
  const onOuterAbort = (): void =>
    abort(true, `Cancellation delivered to ${task.id}.`);
  outer?.addEventListener("abort", onOuterAbort, { once: true });
  const timer = setTimeout(
    () => abort(false, `Attempt ${String(attempt)} timed out.`),
    timeoutMs,
  );
  const aborted = new Promise<never>((_resolve, reject) => {
    controller.signal.addEventListener(
      "abort",
      () =>
        reject(
          controller.signal.reason instanceof AttemptAborted
            ? controller.signal.reason
            : new AttemptAborted(false, "Attempt aborted."),
        ),
      { once: true },
    );
  });
  try {
    return await Promise.race([
      handler(
        {
          id: task.id,
          role: task.role,
          objective: task.objective,
          attempt,
        },
        { signal: controller.signal },
      ),
      aborted,
    ]);
  } finally {
    clearTimeout(timer);
    outer?.removeEventListener("abort", onOuterAbort);
  }
};

const runTask = async (
  task: WorkerTaskSpec,
  options: Required<
    Pick<WorkerRunOptions, "handlers" | "maxAttempts" | "timeoutMs">
  > & {
    readonly signal?: AbortSignal;
  },
): Promise<WorkerTaskResult> => {
  const base = { id: task.id, role: task.role } as const;
  if (options.signal?.aborted === true)
    return {
      ...base,
      status: "cancelled",
      attempts: 0,
      evidenceIds: [],
      reason: "Cancelled before start.",
    };
  const handler = options.handlers[task.role];
  if (handler === undefined)
    return {
      ...base,
      status: "blocked",
      attempts: 0,
      evidenceIds: [],
      reason: `No handler registered for ${task.role}.`,
    };
  let lastReason = "";
  for (let attempt = 1; attempt <= options.maxAttempts; attempt += 1) {
    try {
      const report = await attemptOnce({
        task,
        handler,
        attempt,
        timeoutMs: options.timeoutMs,
        outer: options.signal,
      });
      return {
        ...base,
        status: "completed",
        attempts: attempt,
        evidenceIds: bounded(report.evidenceIds),
        ...(report.summary === undefined ? {} : { summary: report.summary }),
      };
    } catch (error) {
      if (error instanceof AttemptAborted && error.cancelled)
        return {
          ...base,
          status: "cancelled",
          attempts: attempt,
          evidenceIds: [],
          reason: error.message,
        };
      lastReason = error instanceof Error ? error.message : String(error);
    }
  }
  return {
    ...base,
    status: "failed",
    attempts: options.maxAttempts,
    evidenceIds: [],
    reason: lastReason,
  };
};

const markPendingCancelled = (
  waves: readonly (readonly string[])[],
  current: number,
  byId: ReadonlyMap<string, WorkerTaskSpec>,
  results: Map<string, WorkerTaskResult>,
): void => {
  for (const waveId of waves.slice(current + 1).flat()) {
    if (results.has(waveId)) continue;
    const task = byId.get(waveId);
    if (task === undefined) continue;
    results.set(waveId, {
      id: waveId,
      role: task.role,
      status: "cancelled",
      attempts: 0,
      evidenceIds: [],
      reason: "Cancelled before its wave started.",
    });
  }
};

/**
 * Execute a plan: run each dependency wave, retry a failing task up to the
 * attempt budget, block every transitive dependent of a failed task, and
 * deliver cancellation to whatever is already running when the signal fires.
 */
export async function runWorkerPlan(
  tasks: readonly WorkerTaskSpec[],
  options: WorkerRunOptions,
): Promise<Result<WorkerRunReport, WorkerPlanError>> {
  const planned = planWaves(tasks);
  if (!planned.ok) return planned;
  const waves = planned.value;
  const settings = {
    handlers: options.handlers,
    maxAttempts: Math.max(1, options.maxAttempts ?? 2),
    timeoutMs: Math.max(1, options.timeoutMs ?? 15_000),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  };
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const results = new Map<string, WorkerTaskResult>();
  const startedAt = new Date().toISOString();
  const blockedBy = (taskId: string): string | undefined => {
    for (const dependency of byId.get(taskId)?.dependencies ?? []) {
      const result = results.get(dependency);
      if (result === undefined) continue;
      if (result.status === "failed" || result.status === "blocked")
        return dependency;
      if (result.status === "cancelled") return dependency;
    }
    return undefined;
  };
  for (const wave of waves) {
    const runnable: WorkerTaskSpec[] = [];
    for (const id of wave) {
      const task = byId.get(id);
      if (task === undefined) continue;
      const dependency = blockedBy(id);
      if (dependency === undefined) {
        runnable.push(task);
        continue;
      }
      const upstream = results.get(dependency);
      results.set(id, {
        id,
        role: task.role,
        status: upstream?.status === "cancelled" ? "cancelled" : "blocked",
        attempts: 0,
        evidenceIds: [],
        reason: `Upstream ${dependency} is ${upstream?.status ?? "unavailable"}.`,
      });
    }
    const settled = await Promise.all(
      runnable.map((task) => runTask(task, settings)),
    );
    for (const result of settled) results.set(result.id, result);
    if (settings.signal?.aborted === true)
      markPendingCancelled(waves, waves.indexOf(wave), byId, results);
  }
  const ordered = tasks.map(
    (task) =>
      results.get(task.id) ?? {
        id: task.id,
        role: task.role,
        status: "blocked" as const,
        attempts: 0,
        evidenceIds: [],
        reason: "Task never ran.",
      },
  );
  return ok({
    waves,
    tasks: ordered,
    cancelled: ordered
      .filter((task) => task.status === "cancelled")
      .map((task) => task.id),
    startedAt,
    finishedAt: new Date().toISOString(),
  });
}

export interface ReplanOptions {
  /** Role to retry a failed task with; an absent mapping drops the branch. */
  readonly retryRole?: Partial<Record<WorkerRole, WorkerRole>>;
}

export interface ReplanResult {
  readonly tasks: readonly WorkerTaskSpec[];
  /** Completed tasks carried into the new plan unchanged. */
  readonly carried: readonly string[];
  /** Failed tasks re-queued under their original id plus `:retry`. */
  readonly retried: readonly string[];
  /** Tasks that no longer have a path to completion. */
  readonly dropped: readonly string[];
}

/**
 * Build the next plan from a finished run: completed work is kept, a failed
 * task is re-queued under a fallback role when the caller supplied one, and
 * every dependent is rewired to the retry. Branches with no fallback role are
 * dropped instead of being retried forever.
 */
export function replanAfterFailure(
  tasks: readonly WorkerTaskSpec[],
  report: WorkerRunReport,
  options: ReplanOptions = {},
): ReplanResult {
  const resultById = new Map(report.tasks.map((task) => [task.id, task]));
  const carried: string[] = [];
  const retried: string[] = [];
  const replacement = new Map<string, string | undefined>();
  for (const task of tasks) {
    const result = resultById.get(task.id);
    if (result?.status === "completed") {
      carried.push(task.id);
      replacement.set(task.id, task.id);
      continue;
    }
    const fallback =
      result?.status === "failed" ? options.retryRole?.[task.role] : undefined;
    if (fallback !== undefined) {
      retried.push(task.id);
      replacement.set(task.id, `${task.id}:retry`);
    } else if (result?.status === "failed") {
      replacement.set(task.id, undefined);
    }
  }
  // A blocked task stays in the plan once every dependency has a replacement;
  // tasks whose dependency was dropped are dropped with it.
  let changed = true;
  while (changed) {
    changed = false;
    for (const task of tasks) {
      if (replacement.has(task.id)) continue;
      const dependencies = task.dependencies ?? [];
      if (
        dependencies.every(
          (dependency) => replacement.get(dependency) !== undefined,
        )
      ) {
        replacement.set(task.id, task.id);
        changed = true;
      }
    }
  }
  const dropped = tasks
    .filter((task) => replacement.get(task.id) === undefined)
    .map((task) => task.id);
  const next: WorkerTaskSpec[] = [];
  for (const task of tasks) {
    const id = replacement.get(task.id);
    if (id === undefined) continue;
    const dependencies = (task.dependencies ?? []).map((dependency) =>
      replacement.get(dependency),
    );
    if (dependencies.some((dependency) => dependency === undefined)) continue;
    const rewritten = dependencies.filter(
      (dependency): dependency is string => dependency !== undefined,
    );
    if (carried.includes(task.id)) {
      next.push({ ...task, dependencies: rewritten });
      continue;
    }
    const fallback =
      resultById.get(task.id)?.status === "failed"
        ? options.retryRole?.[task.role]
        : undefined;
    if (fallback === undefined) {
      next.push({ ...task, dependencies: rewritten });
      continue;
    }
    next.push({
      id,
      role: fallback,
      objective: `${task.objective} (retry as ${fallback})`,
      dependencies: rewritten,
    });
  }
  const kept = new Set(next.map((task) => task.id));
  return {
    tasks: next.filter((task) =>
      (task.dependencies ?? []).every((dependency) => kept.has(dependency)),
    ),
    carried,
    retried,
    dropped,
  };
}
