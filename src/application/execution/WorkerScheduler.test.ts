import { describe, expect, it } from "vitest";

import {
  planWaves,
  replanAfterFailure,
  runWorkerPlan,
  type WorkerHandler,
  type WorkerTaskSpec,
} from "./WorkerScheduler.js";

const task = (
  id: string,
  dependencies: readonly string[] = [],
  role: WorkerTaskSpec["role"] = "static-worker",
): WorkerTaskSpec => ({
  id,
  role,
  objective: `do ${id}`,
  dependencies,
});

describe("worker plan", () => {
  it("groups a diamond into dependency waves", () => {
    const waves = planWaves([
      task("a"),
      task("b", ["a"]),
      task("c", ["a"]),
      task("d", ["b", "c"]),
    ]);
    expect(waves.ok).toBe(true);
    if (!waves.ok) return;
    expect(waves.value).toEqual([["a"], ["b", "c"], ["d"]]);
  });

  it("rejects cycles, duplicate ids and unknown dependencies", () => {
    const cycle = planWaves([task("a", ["b"]), task("b", ["a"])]);
    expect(cycle.ok ? undefined : cycle.error.code).toBe("dependency-cycle");
    const duplicate = planWaves([task("a"), task("a")]);
    expect(duplicate.ok ? undefined : duplicate.error.code).toBe(
      "duplicate-task",
    );
    const unknown = planWaves([task("a", ["ghost"])]);
    expect(unknown.ok ? undefined : unknown.error.code).toBe(
      "unknown-dependency",
    );
    const self = planWaves([task("a", ["a"])]);
    expect(self.ok ? undefined : self.error.code).toBe("self-dependency");
  });
});

describe("worker run", () => {
  it("runs a wave in parallel and the next wave after it", async () => {
    const events: string[] = [];
    let concurrent = 0;
    let peak = 0;
    const handler: WorkerHandler = async (input) => {
      concurrent += 1;
      peak = Math.max(peak, concurrent);
      events.push(`start:${input.id}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
      events.push(`end:${input.id}`);
      concurrent -= 1;
      return { evidenceIds: ["ev_1"] };
    };
    const report = await runWorkerPlan(
      [task("a"), task("b", ["a"]), task("c", ["a"])],
      { handlers: { "static-worker": handler } },
    );
    expect(report.ok).toBe(true);
    if (!report.ok) return;
    expect(peak).toBe(2);
    expect(events.indexOf("end:a")).toBeLessThan(events.indexOf("start:b"));
    expect(report.value.tasks.map((item) => item.status)).toEqual([
      "completed",
      "completed",
      "completed",
    ]);
    expect(report.value.waves).toEqual([["a"], ["b", "c"]]);
  });

  it("retries a failed attempt before reporting success", async () => {
    let attempts = 0;
    const flaky: WorkerHandler = async (input) => {
      attempts += 1;
      if (input.attempt === 1) throw new Error("transient");
      return { evidenceIds: ["ev_2"] };
    };
    const report = await runWorkerPlan([task("a")], {
      handlers: { "static-worker": flaky },
    });
    expect(report.ok).toBe(true);
    if (!report.ok) return;
    expect(attempts).toBe(2);
    expect(report.value.tasks[0]).toMatchObject({
      status: "completed",
      attempts: 2,
      evidenceIds: ["ev_2"],
    });
  });

  it("blocks dependents of a failed task and still runs independent work", async () => {
    const handler: WorkerHandler = async (input) => {
      if (input.id === "a") throw new Error("boom");
      return { evidenceIds: ["ev_3"] };
    };
    const report = await runWorkerPlan(
      [task("a"), task("b", ["a"]), task("independent")],
      { handlers: { "static-worker": handler }, maxAttempts: 2 },
    );
    expect(report.ok).toBe(true);
    if (!report.ok) return;
    const byId = new Map(report.value.tasks.map((item) => [item.id, item]));
    expect(byId.get("a")).toMatchObject({ status: "failed", attempts: 2 });
    expect(byId.get("b")).toMatchObject({ status: "blocked", attempts: 0 });
    expect(byId.get("b")?.reason).toContain("a");
    expect(byId.get("independent")?.status).toBe("completed");
  });

  it("delivers cancellation to running workers and cancels later waves", async () => {
    const controller = new AbortController();
    const seen: string[] = [];
    const handler: WorkerHandler = async (input, { signal }) => {
      if (input.id === "slow") {
        seen.push("slow-start");
        return await new Promise((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              seen.push("slow-aborted");
              reject(new Error("aborted"));
            },
            { once: true },
          );
          controller.abort();
        });
      }
      return { evidenceIds: ["ev_4"] };
    };
    const report = await runWorkerPlan(
      [task("slow"), task("after", ["slow"])],
      { handlers: { "static-worker": handler }, signal: controller.signal },
    );
    expect(report.ok).toBe(true);
    if (!report.ok) return;
    const byId = new Map(report.value.tasks.map((item) => [item.id, item]));
    expect(seen).toContain("slow-aborted");
    expect(byId.get("slow")?.status).toBe("cancelled");
    expect(byId.get("after")?.status).toBe("cancelled");
    expect([...report.value.cancelled].sort()).toEqual(["after", "slow"]);
  });

  it("times out an attempt that ignores its signal", async () => {
    const stuck: WorkerHandler = () => new Promise(() => {});
    const report = await runWorkerPlan([task("a")], {
      handlers: { "static-worker": stuck },
      maxAttempts: 2,
      timeoutMs: 15,
    });
    expect(report.ok).toBe(true);
    if (!report.ok) return;
    expect(report.value.tasks[0]).toMatchObject({
      status: "failed",
      attempts: 2,
    });
    expect(report.value.tasks[0]?.reason).toContain("timed out");
  });

  it("blocks a task whose role has no registered handler", async () => {
    const report = await runWorkerPlan([task("a", [], "runtime-worker")], {
      handlers: {},
    });
    expect(report.ok).toBe(true);
    if (!report.ok) return;
    expect(report.value.tasks[0]).toMatchObject({
      status: "blocked",
      attempts: 0,
    });
  });
});

describe("replanning", () => {
  const failingRun = async () => {
    const handler: WorkerHandler = async (input) => {
      if (input.id === "a") throw new Error("no runtime provider");
      return { evidenceIds: ["ev_5"] };
    };
    const report = await runWorkerPlan(
      [task("a"), task("b", ["a"]), task("c")],
      { handlers: { "static-worker": handler }, maxAttempts: 1 },
    );
    if (!report.ok) throw new Error("plan failed to run");
    return report.value;
  };

  it("re-queues a failed task under a fallback role and rewires dependents", async () => {
    const report = await failingRun();
    const next = replanAfterFailure(
      [task("a"), task("b", ["a"]), task("c")],
      report,
      { retryRole: { "static-worker": "runtime-worker" } },
    );
    expect(next.carried).toEqual(["c"]);
    expect(next.retried).toEqual(["a"]);
    expect(next.dropped).toEqual([]);
    const byId = new Map(next.tasks.map((item) => [item.id, item]));
    expect(byId.get("a:retry")).toMatchObject({
      role: "runtime-worker",
      dependencies: [],
    });
    expect(byId.get("a:retry")?.objective).toContain("retry as runtime-worker");
    expect(byId.get("b")?.dependencies).toEqual(["a:retry"]);
    expect(byId.get("c")).toBeDefined();
    expect(planWaves(next.tasks).ok).toBe(true);
  });

  it("drops a failed branch when no fallback role is configured", async () => {
    const report = await failingRun();
    const next = replanAfterFailure(
      [task("a"), task("b", ["a"]), task("c")],
      report,
    );
    expect(next.carried).toEqual(["c"]);
    expect(next.retried).toEqual([]);
    expect([...next.dropped].sort()).toEqual(["a", "b"]);
    expect(next.tasks.map((item) => item.id)).toEqual(["c"]);
  });
});
