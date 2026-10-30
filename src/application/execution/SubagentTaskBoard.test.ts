import { describe, expect, it } from "vitest";

import { SubagentTaskBoard } from "./SubagentTaskBoard.js";

describe("subagent task board", () => {
  it("admits independent role workers concurrently", () => {
    const board = new SubagentTaskBoard();
    expect(
      board.start({
        id: "static",
        role: "static-worker",
        objective: "map JavaScript reachability",
      }).ok,
    ).toBe(true);
    expect(
      board.start({
        id: "runtime",
        role: "runtime-worker",
        objective: "observe the live target",
      }).ok,
    ).toBe(true);
    expect(board.list().map(({ id, status }) => ({ id, status }))).toEqual([
      { id: "static", status: "running" },
      { id: "runtime", status: "running" },
    ]);
  });

  it("requires a dependency to complete before starting a dependent", () => {
    const board = new SubagentTaskBoard();
    board.start({
      id: "static",
      role: "static-worker",
      objective: "map JavaScript reachability",
    });
    expect(
      board.start({
        id: "contract",
        role: "contract-worker",
        objective: "synthesize the endpoint schema",
        dependencies: ["static"],
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "unsatisfied-dependency", dependency: "static" },
    });
    board.finish({
      id: "static",
      status: "completed",
      evidenceIds: ["ev_static"],
      summary: "mapped",
    });
    expect(
      board.start({
        id: "contract",
        role: "contract-worker",
        objective: "synthesize the endpoint schema",
        dependencies: ["static"],
      }).ok,
    ).toBe(true);
  });

  it("requires evidence for completion and indexes shared evidence", () => {
    const board = new SubagentTaskBoard();
    board.start({
      id: "runtime",
      role: "runtime-worker",
      objective: "observe the target",
    });
    expect(board.finish({ id: "runtime", status: "completed" }).ok).toBe(false);
    board.finish({
      id: "runtime",
      status: "completed",
      evidenceIds: ["ev_runtime", "ev_shared"],
    });
    board.start({
      id: "contract",
      role: "contract-worker",
      objective: "derive the contract",
    });
    board.finish({
      id: "contract",
      status: "completed",
      evidenceIds: ["ev_shared", "ev_contract"],
    });
    expect(board.evidenceIndex()).toEqual({
      ev_contract: ["contract"],
      ev_runtime: ["runtime"],
      ev_shared: ["contract", "runtime"],
    });
  });

  it("rejects duplicate ids, invalid transitions, and unbounded fan-out", () => {
    const board = new SubagentTaskBoard();
    board.start({
      id: "static",
      role: "static-worker",
      objective: "one",
    });
    expect(
      board.start({
        id: "static",
        role: "static-worker",
        objective: "two",
      }).ok,
    ).toBe(false);
    board.finish({ id: "static", status: "failed" });
    expect(board.finish({ id: "static", status: "cancelled" }).ok).toBe(false);
    for (let index = 0; index < 31; index += 1)
      expect(
        board.start({
          id: `task-${String(index)}`,
          role: "static-worker",
          objective: `task ${String(index)}`,
        }).ok,
      ).toBe(true);
    expect(
      board.start({
        id: "overflow",
        role: "static-worker",
        objective: "overflow",
      }),
    ).toMatchObject({ ok: false, error: { code: "task-limit" } });
  });
});
