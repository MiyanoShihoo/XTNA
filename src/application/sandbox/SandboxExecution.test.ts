import { describe, expect, it } from "vitest";

import {
  buildDockerInvocation,
  executeSandboxCommand,
  type SandboxExecutionRequest,
} from "./SandboxExecution.js";
import type { SandboxCapability } from "./SandboxCapability.js";

const capability = (
  backends: SandboxCapability["backends"],
): SandboxCapability => ({
  platform: "win32",
  backends,
  best: backends.some((entry) => entry.isolation === "container")
    ? "container"
    : "none",
  probes: [],
  checkedAt: "2026-10-31T00:00:00.000Z",
});

const dockerBackend = {
  id: "docker" as const,
  isolation: "container" as const,
  detail: "docker server 27",
  interactiveOnly: false,
};

const request: SandboxExecutionRequest = {
  tier: "L2",
  image: "alpine:3.20",
  command: "sh",
  arguments: ["-c", "echo ok"],
  // A preview the host produced. No tool schema maps to this field, so a caller cannot supply
  // one from a model payload.
  preview: {
    command: ["sh", "-c", "echo ok"],
    image: "alpine:3.20",
    createdAt: "2026-10-31T00:00:00.000Z",
  },
};

describe("sandbox execution", () => {
  it("constructs a no-shell, no-network Docker invocation", () => {
    const invocation = buildDockerInvocation("docker", request);
    expect(invocation).toContain("--network");
    expect(invocation).toContain("none");
    expect(invocation).toContain("--read-only");
    expect(invocation).toContain("--cap-drop");
    expect(invocation).toContain("ALL");
    expect(invocation).toContain("alpine:3.20");
    expect(invocation.slice(-3)).toEqual(["sh", "-c", "echo ok"]);
  });

  it("refuses when no container backend exists", async () => {
    let called = false;
    const result = await executeSandboxCommand(
      capability([]),
      request,
      async () => {
        called = true;
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("no container");
    expect(called).toBe(false);
  });

  it("refuses L2 without a preview the host produced", async () => {
    const { preview: _omitted, ...withoutPreview } = request;
    const result = await executeSandboxCommand(
      capability([dockerBackend]),
      withoutPreview,
      async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("preview");
  });

  it("executes through an injected container runner", async () => {
    let seen: readonly string[] = [];
    const result = await executeSandboxCommand(
      capability([dockerBackend]),
      request,
      async (_file, args) => {
        seen = args;
        return { exitCode: 0, stdout: "ok\n", stderr: "" };
      },
    );
    expect(result.allowed).toBe(true);
    expect(result.isolation).toBe("container");
    expect(seen).toEqual(
      expect.arrayContaining(["alpine:3.20", "sh", "-c", "echo ok"]),
    );
    expect(result.result?.stdout).toBe("ok\n");
  });
});
