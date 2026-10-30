import { describe, expect, it } from "vitest";

import {
  admitCommand,
  isolationAtLeast,
  probeSandboxCapability,
  type SandboxCapability,
} from "./SandboxCapability.js";

const capability = (
  best: SandboxCapability["best"],
  backends: SandboxCapability["backends"] = [],
): SandboxCapability => ({
  platform: "linux",
  backends,
  best,
  probes: [],
  checkedAt: "2026-10-31T00:00:00.000Z",
});

describe("sandbox capability probe", () => {
  it("reports a container backend when docker answers", async () => {
    const probe = await probeSandboxCapability(
      async (file) =>
        file === "docker"
          ? { ok: true, detail: "27.0.3" }
          : { ok: false, detail: "not installed" },
      "linux",
    );
    expect(probe.best).toBe("container");
    expect(probe.backends.map((entry) => entry.id)).toEqual(["docker"]);
    expect(probe.probes.find((entry) => entry.id === "podman")?.ok).toBe(false);
  });

  it("reports none when no backend answers", async () => {
    const probe = await probeSandboxCapability(
      async () => ({ ok: false, detail: "not installed" }),
      "linux",
    );
    expect(probe.best).toBe("none");
    expect(probe.backends).toEqual([]);
  });

  it("does not count Windows Sandbox as command-capable", async () => {
    const probe = await probeSandboxCapability(
      async () => ({ ok: false, detail: "not installed" }),
      "win32",
    );
    // The file may or may not exist on this host; when it does it is
    // interactive-only and must not raise `best` above none.
    const windowsSandbox = probe.backends.find(
      (entry) => entry.id === "windows-sandbox",
    );
    if (windowsSandbox !== undefined) {
      expect(windowsSandbox.interactiveOnly).toBe(true);
      expect(isolationAtLeast(probe.best, "container")).toBe(false);
    }
  });
});

describe("command admission", () => {
  it("admits read-only work without a sandbox", () => {
    const verdict = admitCommand({
      tier: "L1",
      capability: capability("none"),
    });
    expect(verdict.allowed).toBe(true);
  });

  it("refuses L2 without a container or VM, and names the gap", () => {
    const verdict = admitCommand({
      tier: "L2",
      capability: capability("none"),
      diffPreview: true,
    });
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toContain("no container or VM backend");
  });

  it("refuses L2 without a diff preview", () => {
    const verdict = admitCommand({
      tier: "L2",
      capability: capability("container"),
    });
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toContain("diff preview");
  });

  it("admits L2 with a diff preview and a container backend", () => {
    const verdict = admitCommand({
      tier: "L2",
      capability: capability("container"),
      diffPreview: true,
    });
    expect(verdict).toEqual({
      allowed: true,
      reason: "L2 admitted to the detected isolation backend",
      isolation: "container",
    });
  });

  it("requires an approval token for L3", () => {
    const refused = admitCommand({
      tier: "L3",
      capability: capability("vm"),
    });
    expect(refused.allowed).toBe(false);
    expect(refused.reason).toContain("approval token");
    const admitted = admitCommand({
      tier: "L3",
      capability: capability("vm"),
      approvalToken: "approve-me",
    });
    expect(admitted.allowed).toBe(true);
    expect(admitted.isolation).toBe("vm");
  });
});
