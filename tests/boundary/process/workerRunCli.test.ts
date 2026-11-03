import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

/**
 * The CLI lane for process workers had no test at all, so nothing checked that it refuses to run
 * without a human confirmation, or that it still respects the scheduler's verdict.
 *
 * These cases spawn the script exactly as a user would. The plan is data; the command is explicit;
 * nothing is inferred from a role.
 */
const run = promisify(execFile);
const script = resolve("scripts/worker-run.mjs");

const cli = async (args: readonly string[]) => {
  try {
    // `execFile` always pipes stdio, which is what makes `process.stdin.isTTY` false — the case
    // the refusal branch exists for.
    const { stdout, stderr } = await run(process.execPath, [script, ...args], {
      timeout: 60_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as {
      code?: number;
      stdout?: string;
      stderr?: string;
    };
    return {
      code: failure.code ?? 1,
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? "",
    };
  }
};

const planFile = async (plan: unknown) => {
  const directory = await mkdtemp(join(tmpdir(), "rea-worker-cli-"));
  const path = join(directory, "plan.json");
  await writeFile(path, JSON.stringify(plan), "utf8");
  return {
    path,
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
};

const workerCommand = (source: string) => ({
  command: process.execPath,
  arguments: ["-e", source],
});

describe("worker-run CLI", () => {
  it("exits 2 and prints usage without a plan", async () => {
    const result = await cli([]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("usage:");
  });

  it("refuses a plan that is not JSON", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rea-worker-cli-"));
    const path = join(directory, "plan.json");
    await writeFile(path, "{ not json", "utf8");
    const result = await cli(["--plan", path]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("not valid JSON");
    await rm(directory, { recursive: true, force: true });
  });

  it("refuses a plan with no tasks", async () => {
    const plan = await planFile({ tasks: [] });
    const result = await cli(["--plan", plan.path]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("nonempty array");
    await plan.cleanup();
  });

  // The gate that makes this lane human-gated: a non-interactive run without --yes must not
  // launch anything.
  it("refuses to launch workers without a human confirmation", async () => {
    const plan = await planFile({
      tasks: [
        {
          id: "a",
          role: "static-worker",
          objective: "say nothing",
          command: workerCommand("process.exit(0)"),
        },
      ],
    });
    const result = await cli(["--plan", plan.path]);
    expect(result.code).toBe(3);
    expect(result.stderr).toContain("refusing to launch workers");
    await plan.cleanup();
  });

  it("runs a confirmed plan and reports the task completed", async () => {
    const plan = await planFile({
      tasks: [
        {
          id: "a",
          role: "static-worker",
          objective: "cite one evidence id",
          command: workerCommand(
            'console.log(JSON.stringify({ evidenceIds: ["ev_cli"] }))',
          ),
        },
      ],
    });
    const result = await cli(["--plan", plan.path, "--yes", "--json"]);
    expect(result.code).toBe(0);
    const report = JSON.parse(result.stdout) as {
      ok: boolean;
      value: { tasks: readonly { id: string; status: string }[] };
    };
    expect(report.ok).toBe(true);
    expect(report.value.tasks[0]).toMatchObject({
      id: "a",
      status: "completed",
    });
    await plan.cleanup();
  });

  // §5.1 reaches the CLI: a worker that prints `{}` did not report what it observed, and the
  // lane must exit non-zero rather than claim success.
  it("reports a worker that cites no evidence as a failure", async () => {
    const plan = await planFile({
      tasks: [
        {
          id: "a",
          role: "static-worker",
          objective: "cite nothing",
          command: workerCommand("console.log('{}')"),
        },
      ],
    });
    const result = await cli(["--plan", plan.path, "--yes", "--json"]);
    expect(result.code).toBe(1);
    const report = JSON.parse(result.stdout) as {
      value: {
        tasks: readonly { status: string; reason?: string }[];
      };
    };
    expect(report.value.tasks[0]).toMatchObject({
      status: "failed",
      reason: "a completed task must cite at least one evidence id",
    });
    await plan.cleanup();
  });
});
