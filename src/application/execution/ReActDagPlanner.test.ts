import { describe, expect, it } from "vitest";
import { executeReActDag, type PlanTask } from "./ReActDagPlanner.js";

const readTask = (
  id: string,
  dependencies: readonly string[] = [],
): PlanTask<number, number> => ({
  id,
  operation: "read",
  authority: "read-only",
  input: 1,
  dependencies,
  execute: async (_input, outputs) => {
    await Promise.resolve();
    return dependencies
      .map((dependency) => outputs[dependency])
      .filter((value): value is number => typeof value === "number")
      .reduce((sum, value) => sum + value, 0);
  },
});

describe("ReAct DAG execution", () => {
  it("runs independent reads concurrently and passes dependency outputs", async () => {
    let running = 0;
    let peak = 0;
    const makeConcurrent = (id: string): PlanTask => ({
      ...readTask(id),
      execute: async () => {
        running += 1;
        peak = Math.max(peak, running);
        await new Promise((resolve) => setTimeout(resolve, 15));
        running -= 1;
        return 1;
      },
    });
    const result = await executeReActDag(
      [makeConcurrent("a"), makeConcurrent("b"), readTask("c", ["a", "b"])],
      { maxConcurrency: 2 },
    );
    expect(result.status).toBe("completed");
    expect(peak).toBe(2);
    expect(result.results.find(({ id }) => id === "c")?.output).toBe(2);
  });

  it("blocks unapproved writes and their dependents", async () => {
    const result = await executeReActDag([
      { ...readTask("write"), authority: "write" },
      readTask("after", ["write"]),
    ]);
    expect(result.results.map(({ status }) => status)).toEqual([
      "blocked",
      "skipped",
    ]);
  });

  it("plans destructive commands without executing them", async () => {
    let called = false;
    const result = await executeReActDag([
      {
        ...readTask("remove"),
        authority: "destructive",
        dryRun: true,
        execute: async () => {
          called = true;
          return 1;
        },
      },
    ]);
    expect(called).toBe(false);
    expect(result.results[0]?.output).toMatchObject({
      dryRun: true,
      authority: "destructive",
    });
  });

  it("rejects dependency cycles instead of hanging", async () => {
    const result = await executeReActDag([
      readTask("a", ["b"]),
      readTask("b", ["a"]),
    ]);
    expect(result.results.every(({ status }) => status === "blocked")).toBe(
      true,
    );
  });
});
