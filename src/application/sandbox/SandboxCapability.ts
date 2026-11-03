/**
 * Sandbox capability detection and command admission.
 *
 * This is the honest half of "sandboxed dynamic execution": XTNA does not ship
 * a sandbox, so it proves which isolation exists on the host and refuses to
 * label a command sandboxed when none does. L2/L3 commands are admitted only
 * when a real container or VM backend answered a probe.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";

export type Isolation = "none" | "process" | "container" | "vm";

export interface SandboxBackend {
  readonly id: "windows-sandbox" | "wsl2" | "docker" | "podman";
  readonly isolation: Isolation;
  readonly detail: string;
  /** Windows Sandbox only runs an interactive desktop; it cannot execute a command line. */
  readonly interactiveOnly: boolean;
}

export interface SandboxProbe {
  readonly id: string;
  readonly ok: boolean;
  readonly detail: string;
}

export interface SandboxCapability {
  readonly platform: NodeJS.Platform;
  readonly backends: readonly SandboxBackend[];
  readonly best: Isolation;
  readonly probes: readonly SandboxProbe[];
  readonly checkedAt: string;
}

export type CommandTier = "L1" | "L2" | "L3";

/**
 * A preview the host produced for the operator before execution.
 *
 * Not a boolean: `sandbox_exec` used to forward `diff_preview` straight from the model payload,
 * so the L2 gate was a flag the model set on itself. A value of this type can only come from the
 * process that built the invocation, and no tool schema maps to it.
 */
export interface SandboxCommandPreview {
  readonly command: readonly string[];
  readonly image: string;
  readonly createdAt: string;
}

export interface AdmissionRequest {
  readonly tier: CommandTier;
  readonly capability: SandboxCapability;
  /** L2 requires a host-produced preview; L3 requires approval this process can verify. */
  readonly preview?: SandboxCommandPreview;
  readonly approvalToken?: string;
  /**
   * Verifies that `approvalToken` was issued by an operator for this run.
   *
   * A token the requester can invent is not an approval. The previous rule admitted L3 for any
   * string of eight characters, and the token travels in the same payload the model writes, so
   * the tier's only gate was a length check on text the model controls. Without a verifier, L3
   * refuses: no operator channel, no third tier.
   */
  readonly verifyApproval?: (token: string) => boolean;
}

export interface Admission {
  readonly allowed: boolean;
  readonly reason: string;
  readonly isolation: Isolation;
}

type Runner = (
  file: string,
  args: readonly string[],
) => Promise<{ ok: boolean; detail: string }>;

/** wsl.exe answers UTF-16LE; everything else is UTF-8. */
const decode = (value: Buffer | string): string => {
  if (typeof value === "string") return value;
  if (value.includes(0)) return value.toString("utf16le");
  return value.toString("utf8");
};

const defaultRunner: Runner = (file, args) =>
  new Promise((resolve) => {
    const child = execFile(
      file,
      [...args],
      { timeout: 5_000, windowsHide: true, encoding: "buffer" },
      (error, stdout, stderr) => {
        if (error !== null) {
          resolve({ ok: false, detail: decode(stderr).slice(0, 200) });
          return;
        }
        resolve({ ok: true, detail: decode(stdout).trim().slice(0, 200) });
      },
    );
    child.on("error", () => resolve({ ok: false, detail: "not installed" }));
  });

const RANK: Readonly<Record<Isolation, number>> = {
  none: 0,
  process: 1,
  container: 2,
  vm: 3,
};

export const isolationAtLeast = (
  value: Isolation,
  minimum: Isolation,
): boolean => RANK[value] >= RANK[minimum];

/**
 * Probe the host for isolation backends. Every probe is bounded and every
 * failure is recorded; a missing backend is reported as absent, never assumed.
 */
export const probeSandboxCapability = async (
  run: Runner = defaultRunner,
  platform: NodeJS.Platform = process.platform,
): Promise<SandboxCapability> => {
  const probes: SandboxProbe[] = [];
  const backends: SandboxBackend[] = [];

  const docker = await run("docker", [
    "version",
    "--format",
    "{{.Server.Version}}",
  ]);
  probes.push({ id: "docker", ok: docker.ok, detail: docker.detail });
  if (docker.ok)
    backends.push({
      id: "docker",
      isolation: "container",
      detail: `docker server ${docker.detail}`,
      interactiveOnly: false,
    });

  const podman = await run("podman", ["info", "--format", "{{.Version}}"]);
  probes.push({ id: "podman", ok: podman.ok, detail: podman.detail });
  if (podman.ok)
    backends.push({
      id: "podman",
      isolation: "container",
      detail: `podman ${podman.detail}`,
      interactiveOnly: false,
    });

  if (platform === "win32") {
    const sandboxPath = `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\WindowsSandbox.exe`;
    const present = existsSync(sandboxPath);
    probes.push({
      id: "windows-sandbox",
      ok: present,
      detail: present ? sandboxPath : "WindowsSandbox.exe not found",
    });
    if (present)
      backends.push({
        id: "windows-sandbox",
        isolation: "vm",
        detail: sandboxPath,
        interactiveOnly: true,
      });

    const wsl = await run("wsl.exe", ["--status"]);
    probes.push({ id: "wsl2", ok: wsl.ok, detail: wsl.detail });
    if (wsl.ok)
      backends.push({
        id: "wsl2",
        isolation: "vm",
        detail: "wsl --status answered",
        interactiveOnly: false,
      });
  }

  const executable = backends.filter((backend) => !backend.interactiveOnly);
  const best = executable.reduce<Isolation>(
    (current, backend) =>
      RANK[backend.isolation] > RANK[current] ? backend.isolation : current,
    "none",
  );
  return {
    platform,
    backends,
    best,
    probes,
    checkedAt: new Date().toISOString(),
  };
};

/**
 * Decide whether a command may run under a tier.
 *
 * L1 is read-only and runs anywhere. L2 needs a container or VM backend plus a
 * diff preview. L3 needs the same backend plus an explicit approval token.
 * Without a backend the answer is a refusal that names the missing capability.
 */
export const admitCommand = (request: AdmissionRequest): Admission => {
  const { tier, capability } = request;
  if (tier === "L1")
    return {
      allowed: true,
      reason: "read-only tier runs in the current process",
      isolation: "process",
    };
  if (capability.best === "none")
    return {
      allowed: false,
      reason:
        "no container or VM backend answered a probe (docker, podman, WSL2 or Windows Sandbox); refusing to call this sandboxed",
      isolation: "none",
    };
  if (!isolationAtLeast(capability.best, "container"))
    return {
      allowed: false,
      reason: `best available isolation is ${capability.best}`,
      isolation: capability.best,
    };
  if (tier === "L2") {
    if (request.preview === undefined)
      return {
        allowed: false,
        reason:
          "L2 needs a preview this process produced for the operator; a preview flag from the caller is not one",
        isolation: capability.best,
      };
    return {
      allowed: true,
      reason: "L2 admitted to the detected isolation backend",
      isolation: capability.best,
    };
  }
  const token = request.approvalToken;
  if (token === undefined || request.verifyApproval === undefined)
    return {
      allowed: false,
      reason:
        "L3 needs an operator approval this process can verify; no approval channel is registered, so the command is refused rather than called sandboxed",
      isolation: capability.best,
    };
  if (!request.verifyApproval(token))
    return {
      allowed: false,
      reason: "the approval token was not issued by an operator for this run",
      isolation: capability.best,
    };
  return {
    allowed: true,
    reason: "L3 admitted with a verified operator approval",
    isolation: capability.best,
  };
};
