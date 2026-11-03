/**
 * Bound execution adapter for admitted sandbox tiers.
 *
 * Admission remains owned by `SandboxCapability`; this module only turns an
 * admitted L2/L3 request into a Docker/Podman argv array and delegates the
 * actual spawn to an injected runner. Without a container backend it refuses
 * instead of falling back to host execution.
 */
import { execFile } from "node:child_process";
import { resolve } from "node:path";

import {
  admitCommand,
  type CommandTier,
  type SandboxCapability,
  type SandboxCommandPreview,
} from "./SandboxCapability.js";

export interface SandboxExecutionRequest {
  readonly tier: Exclude<CommandTier, "L1">;
  readonly image: string;
  readonly command: string;
  readonly arguments?: readonly string[];
  readonly cwd?: string;
  /** Produced by this process for the operator; never forwarded from a tool payload. */
  readonly preview?: SandboxCommandPreview;
  readonly approvalToken?: string;
  readonly timeoutMs?: number;
}

export interface SandboxCommandResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export type SandboxCommandRunner = (
  file: string,
  args: readonly string[],
  timeoutMs: number,
) => Promise<SandboxCommandResult>;

export interface SandboxExecutionResult {
  readonly allowed: boolean;
  readonly reason: string;
  readonly isolation: SandboxCapability["best"];
  readonly invocation?: readonly string[];
  readonly result?: SandboxCommandResult;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;

export const defaultDockerRunner: SandboxCommandRunner = (
  file,
  args,
  timeoutMs,
) =>
  new Promise((resolveResult) => {
    execFile(
      file,
      [...args],
      {
        timeout: timeoutMs,
        windowsHide: true,
        maxBuffer: MAX_OUTPUT_BYTES,
        encoding: "utf8",
      },
      (error, stdout, stderr) => {
        const exitCode =
          error === null || error.code === undefined
            ? 0
            : typeof error.code === "number"
              ? error.code
              : null;
        resolveResult({
          exitCode,
          stdout: String(stdout ?? "").slice(0, MAX_OUTPUT_BYTES),
          stderr: String(stderr ?? "").slice(0, MAX_OUTPUT_BYTES),
        });
      },
    );
  });

/** Pure argv construction, kept testable without Docker. */
export const buildDockerInvocation = (
  backend: "docker" | "podman",
  request: SandboxExecutionRequest,
): readonly string[] => {
  const cwd = request.cwd === undefined ? undefined : resolve(request.cwd);
  return [
    "run",
    "--rm",
    "--network",
    "none",
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--pids-limit",
    "256",
    "--memory",
    "512m",
    "--cpus",
    "1",
    ...(cwd === undefined ? [] : ["-v", `${cwd}:/work:ro`, "-w", "/work"]),
    request.image,
    request.command,
    ...(request.arguments ?? []),
  ];
};

/**
 * Execute only when admission passes and a container backend exists. The
 * backend command is explicit; no shell string is ever constructed.
 */
export async function executeSandboxCommand(
  capability: SandboxCapability,
  request: SandboxExecutionRequest,
  run: SandboxCommandRunner = defaultDockerRunner,
): Promise<SandboxExecutionResult> {
  const admission = admitCommand({
    tier: request.tier,
    capability,
    ...(request.preview === undefined ? {} : { preview: request.preview }),
    ...(request.approvalToken === undefined
      ? {}
      : { approvalToken: request.approvalToken }),
  });
  if (!admission.allowed)
    return {
      allowed: false,
      reason: admission.reason,
      isolation: admission.isolation,
    };
  const backend = capability.backends.find(
    (entry) =>
      !entry.interactiveOnly &&
      (entry.id === "docker" || entry.id === "podman"),
  );
  const backendId =
    backend?.id === "docker" || backend?.id === "podman"
      ? backend.id
      : undefined;
  if (backend === undefined || backendId === undefined)
    return {
      allowed: false,
      reason: "no executable container backend (docker or podman)",
      isolation: capability.best,
    };
  if (request.image.trim().length === 0 || request.command.trim().length === 0)
    return {
      allowed: false,
      reason: "image and command must be nonempty",
      isolation: capability.best,
    };
  const invocation = buildDockerInvocation(backendId, request);
  const timeoutMs = Math.max(1, request.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const result = await run(backendId, invocation, timeoutMs);
  return {
    allowed: true,
    reason: `executed in ${backend.id} ${backend.isolation}`,
    isolation: backend.isolation,
    invocation,
    result,
  };
}
