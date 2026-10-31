/**
 * OS-process worker handler for the bounded WorkerScheduler.
 *
 * A worker is an explicit command, never an LLM session inferred from a role.
 * The task brief is written as JSON to stdin; the child is expected to write a
 * JSON object on stdout with optional `evidenceIds` and `summary`. Process
 * ownership and cleanup come from `spawnOwnedProviderProcess`; this module does
 * not add a second lifecycle owner.
 */
import { randomUUID } from "node:crypto";

import {
  spawnOwnedProviderProcess,
  ProviderProcessSupervisor,
  type ProviderProcessLaunch,
} from "../../process/ProviderProcess.js";
import type {
  WorkerHandler,
  WorkerReport,
  WorkerTaskInput,
} from "./WorkerScheduler.js";

export interface ProcessWorkerCommand {
  readonly command: string;
  readonly arguments?: readonly string[];
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  /** Per-worker wall clock; the scheduler also has its own attempt timeout. */
  readonly timeoutMs?: number;
  /** Retained stdout/stderr budget per stream. Defaults to 64 KiB. */
  readonly maxOutputBytes?: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_OUTPUT_BYTES = 64 * 1024;

const parseReport = (stdout: string, taskId: string): WorkerReport => {
  const lines = stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  for (const line of lines.reverse()) {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    if (value === null || typeof value !== "object" || Array.isArray(value))
      continue;
    const record = value as Record<string, unknown>;
    if (
      record.evidenceIds !== undefined &&
      (!Array.isArray(record.evidenceIds) ||
        !record.evidenceIds.every((id) => typeof id === "string"))
    )
      continue;
    if (record.summary !== undefined && typeof record.summary !== "string")
      continue;
    return {
      ...(Array.isArray(record.evidenceIds)
        ? { evidenceIds: record.evidenceIds as string[] }
        : {}),
      ...(typeof record.summary === "string"
        ? { summary: record.summary }
        : {}),
    };
  }
  throw new Error(
    `Worker ${taskId} did not emit a valid JSON report on stdout.`,
  );
};

const waitForAbort = (signal: AbortSignal): Promise<never> =>
  new Promise((_resolve, reject) => {
    signal.addEventListener(
      "abort",
      () => reject(new Error("Worker cancelled.")),
      { once: true },
    );
  });

/**
 * Run one worker command. The child receives the task brief on stdin and must
 * end with a JSON report on stdout. The process is always owned; a timeout or
 * cancellation goes through the supervisor's cleanup path.
 */
export async function runProcessWorkerTask(
  task: WorkerTaskInput,
  command: ProcessWorkerCommand,
  signal?: AbortSignal,
): Promise<WorkerReport> {
  if (signal?.aborted === true)
    throw new Error(`Worker ${task.id} cancelled before start.`);
  const timeoutMs = Math.max(1, command.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const maxOutputBytes = Math.max(
    1024,
    command.maxOutputBytes ?? DEFAULT_OUTPUT_BYTES,
  );
  const child = await spawnOwnedProviderProcess({
    command: command.command,
    arguments: command.arguments ?? [],
    runId: `xtna-worker-${task.id}-${randomUUID()}`,
    ...(command.cwd === undefined ? {} : { cwd: command.cwd }),
    ...(command.env === undefined ? {} : { env: command.env }),
    stdin: "pipe",
    ...(signal === undefined ? {} : { signal }),
  });
  const launch: ProviderProcessLaunch = {
    process: child.process,
    ownsProcessLifetime: true,
    ownership: child.ownership,
    ...(child.cleanup === undefined ? {} : { cleanup: child.cleanup }),
  };
  const supervisor = new ProviderProcessSupervisor(launch, {
    maxDiagnosticBytes: {
      stdout: maxOutputBytes,
      stderr: maxOutputBytes,
    },
  });
  try {
    child.process.stdin?.end(
      `${JSON.stringify({
        id: task.id,
        role: task.role,
        objective: task.objective,
        attempt: task.attempt,
      })}\n`,
    );
    const aborted = signal === undefined ? undefined : waitForAbort(signal);
    const exited = await (aborted === undefined
      ? supervisor.waitForExit(timeoutMs)
      : Promise.race([supervisor.waitForExit(timeoutMs), aborted]));
    if (exited === false) throw new Error(`Worker ${task.id} timed out.`);
    await supervisor.waitForOutputClose(1_000);
    const snapshot = supervisor.snapshot();
    if (snapshot.exitCode !== 0) {
      const detail = snapshot.stderr.text.trim().slice(0, 500);
      throw new Error(
        `Worker ${task.id} exited ${String(snapshot.exitCode)}${detail.length === 0 ? "" : `: ${detail}`}`,
      );
    }
    return parseReport(snapshot.stdout.text, task.id);
  } catch (error) {
    throw error;
  } finally {
    await supervisor.stop();
    supervisor.dispose();
  }
}

/** Bind one explicit command per task id; no command is inferred from a role. */
export function createProcessWorkerHandler(
  commands: Readonly<Record<string, ProcessWorkerCommand>>,
): WorkerHandler {
  return async (task, context) => {
    const command = commands[task.id];
    if (command === undefined)
      throw new Error(`No process command registered for task ${task.id}.`);
    return runProcessWorkerTask(task, command, context.signal);
  };
}
