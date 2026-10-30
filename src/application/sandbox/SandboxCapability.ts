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

export interface AdmissionRequest {
  readonly tier: CommandTier;
  readonly capability: SandboxCapability;
  /** L2 requires a diff preview; L3 requires an explicit approval token. */
  readonly diffPreview?: boolean;
  readonly approvalToken?: string;
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
    if (request.diffPreview !== true)
      return {
        allowed: false,
        reason: "L2 needs a diff preview before execution",
        isolation: capability.best,
      };
    return {
      allowed: true,
      reason: "L2 admitted to the detected isolation backend",
      isolation: capability.best,
    };
  }
  if (request.approvalToken === undefined || request.approvalToken.length < 8)
    return {
      allowed: false,
      reason: "L3 needs an explicit approval token (at least 8 characters)",
      isolation: capability.best,
    };
  return {
    allowed: true,
    reason: "L3 admitted with an approval token",
    isolation: capability.best,
  };
};
