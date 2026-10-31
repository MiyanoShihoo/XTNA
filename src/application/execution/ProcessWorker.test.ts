import { describe, expect, it } from "vitest";

import {
  runProcessWorkerTask,
  type ProcessWorkerCommand,
} from "./ProcessWorker.js";
import type { WorkerTaskInput } from "./WorkerScheduler.js";

const task = (id: string): WorkerTaskInput => ({
  id,
  role: "static-worker",
  objective: `objective for ${id}`,
  attempt: 1,
});

const reportScript = [
  'let data = "";',
  'process.stdin.setEncoding("utf8");',
  'process.stdin.on("data", (chunk) => { data += chunk; });',
  'process.stdin.on("end", () => {',
  "  const task = JSON.parse(data);",
  "  process.stdout.write(JSON.stringify({",
  "    evidenceIds: [`ev_${task.id}`],",
  "    summary: task.objective,",
  '  }) + "\\n");',
  "});",
].join("\n");

const command = (script: string): ProcessWorkerCommand => ({
  command: process.execPath,
  arguments: ["-e", script],
  timeoutMs: 10_000,
  maxOutputBytes: 32 * 1024,
});

describe("process worker", () => {
  it("writes the task brief to stdin and parses the JSON report", async () => {
    const report = await runProcessWorkerTask(
      task("static-1"),
      command(reportScript),
    );
    expect(report.evidenceIds).toEqual(["ev_static-1"]);
    expect(report.summary).toBe("objective for static-1");
  });

  it("surfaces a nonzero exit as a failed worker", async () => {
    await expect(
      runProcessWorkerTask(
        task("failure"),
        command('process.stderr.write("boom"); process.exit(7);'),
      ),
    ).rejects.toThrow("exited 7");
  });

  it("stops an owned process when cancellation is delivered", async () => {
    const controller = new AbortController();
    const pending = runProcessWorkerTask(
      task("cancel"),
      command("process.stdin.resume(); setInterval(() => {}, 1000);"),
      controller.signal,
    );
    setTimeout(() => controller.abort(), 50);
    await expect(pending).rejects.toThrow("cancelled");
  });

  it("rejects a missing report without leaking the worker", async () => {
    await expect(
      runProcessWorkerTask(
        task("empty"),
        command('process.stdin.resume(); process.stdin.on("end", () => {});'),
      ),
    ).rejects.toThrow("valid JSON report");
  });
});
