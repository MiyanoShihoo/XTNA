import { describe, expect, it } from "vitest";

import {
  createHypothesis,
  hypothesisRecordSchema,
  transitionHypothesis,
  type HypothesisRecord,
} from "./HypothesisBoard.js";

const created = (): HypothesisRecord =>
  createHypothesis({
    id: "hyp reconnect",
    statement: "Module A handles reconnect",
    checklist: [
      {
        id: "call-seen",
        label: "Reconnect calls Module A",
        direction: "supporting",
      },
      {
        id: "other-owner",
        label: "Another module owns reconnect",
        direction: "contradicting",
      },
    ],
  });

const begin = (record = created()): HypothesisRecord => {
  const result = transitionHypothesis(record, { kind: "start-investigation" });
  if (!result.ok) throw new Error("Expected investigation to start");
  return result.value;
};

const confirm = (
  record: HypothesisRecord,
  checklist_item_id: string,
  evidence_ids: string[],
): HypothesisRecord => {
  const result = transitionHypothesis(record, {
    kind: "record-checklist",
    checklist_item_id,
    disposition: "confirm",
    evidence_ids,
  });
  if (!result.ok) throw new Error("Expected checklist transition");
  return result.value;
};

// oxlint-disable-next-line max-lines-per-function -- The complete transition matrix stays adjacent.
describe("hypothesis investigation board", () => {
  it("creates a proposed claim with separate positive and negative checks", () => {
    const record = created();
    expect(record.status).toBe("proposed");
    expect(record.checklist.map(({ direction }) => direction)).toEqual([
      "supporting",
      "contradicting",
    ]);
    expect(record).not.toHaveProperty("confidence");
    expect(JSON.stringify(record)).not.toMatch(/probability|score/iu);
    expect(hypothesisRecordSchema.parse(record)).toEqual(record);
  });

  it("requires investigation and evidence before support", () => {
    const initial = created();
    const early = transitionHypothesis(initial, {
      kind: "record-checklist",
      checklist_item_id: "call-seen",
      disposition: "confirm",
      evidence_ids: ["ev_1"],
    });
    expect(early).toMatchObject({
      ok: false,
      error: { code: "invalid-state-transition" },
    });
    const active = begin(initial);
    const incomplete = transitionHypothesis(active, {
      kind: "mark-supported",
      evidence_ids: ["ev_1"],
    });
    expect(incomplete).toMatchObject({
      ok: false,
      error: { code: "checklist-incomplete" },
    });
    const supported = transitionHypothesis(
      confirm(active, "call-seen", ["ev_1"]),
      {
        kind: "mark-supported",
        evidence_ids: ["ev_1"],
      },
    );
    expect(supported).toMatchObject({
      ok: false,
      error: { code: "checklist-incomplete" },
    });
  });

  it("supports only after both checklist directions have dispositions", () => {
    const active = begin();
    const supported = confirm(active, "call-seen", ["ev_1"]);
    const checkedNegative = transitionHypothesis(supported, {
      kind: "record-checklist",
      checklist_item_id: "other-owner",
      disposition: "dismiss",
      evidence_ids: ["ev_2"],
    });
    if (!checkedNegative.ok)
      throw new Error("Expected negative check dismissal");
    const result = transitionHypothesis(checkedNegative.value, {
      kind: "mark-supported",
      evidence_ids: ["ev_1", "ev_2"],
    });
    expect(result).toMatchObject({ ok: true, value: { status: "supported" } });
  });

  it("automatically backtracks when contrary evidence arrives, including after support", () => {
    const active = begin();
    const conflicted = confirm(active, "other-owner", ["ev_counter"]);
    expect(conflicted.status).toBe("backtracked");
    expect(conflicted.conflicts[0]).toMatchObject({
      previous_status: "investigating",
      backtrack_to: "investigating",
      evidence_ids: ["ev_counter"],
    });
    expect(conflicted.history.at(-1)?.kind).toBe("conflict-backtracked");
    expect(
      transitionHypothesis(conflicted, {
        kind: "mark-supported",
        evidence_ids: ["ev_1"],
      }),
    ).toMatchObject({ ok: false, error: { code: "invalid-state-transition" } });
  });

  it("resolves a conflict explicitly and returns to investigation", () => {
    const conflicted = confirm(begin(), "other-owner", ["ev_counter"]);
    const resolved = transitionHypothesis(conflicted, {
      kind: "resolve-conflict",
      conflict_id: "conflict-1",
      resolution: "counter-evidence-dismissed",
      rationale: "The symbol belongs to an unrelated reconnect timer",
      evidence_ids: ["ev_context"],
    });
    if (!resolved.ok) throw new Error("Expected conflict resolution");
    expect(resolved.value.status).toBe("investigating");
    expect(resolved.value.conflicts[0]?.resolution).toMatchObject({
      kind: "counter-evidence-dismissed",
      evidence_ids: ["ev_context"],
    });
    expect(resolved.value.checklist[1]?.state).toBe("dismissed");
  });

  it("requires evidence for a hypothesis revision", () => {
    const conflicted = confirm(begin(), "other-owner", ["ev_counter"]);
    const missing = transitionHypothesis(conflicted, {
      kind: "resolve-conflict",
      conflict_id: "conflict-1",
      resolution: "hypothesis-revised",
      rationale: "Narrow the claim to the timer callback",
      revised_statement: "Module A owns only the reconnect timer callback",
      evidence_ids: [],
    });
    expect(missing).toMatchObject({
      ok: false,
      error: { code: "invalid-command" },
    });
    const revised = transitionHypothesis(conflicted, {
      kind: "resolve-conflict",
      conflict_id: "conflict-1",
      resolution: "hypothesis-revised",
      rationale: "Narrow the claim to the timer callback",
      revised_statement: "Module A owns only the reconnect timer callback",
      evidence_ids: ["ev_disassembly"],
    });
    expect(revised).toMatchObject({
      ok: true,
      value: {
        statement: "Module A owns only the reconnect timer callback",
        status: "investigating",
      },
    });
  });

  it("permits refutation only from an actual conflict", () => {
    const active = begin();
    expect(
      transitionHypothesis(active, {
        kind: "refute",
        evidence_ids: ["ev_counter"],
        rationale: "No conflict has been recorded",
      }),
    ).toMatchObject({ ok: false, error: { code: "invalid-state-transition" } });
    const conflicted = confirm(active, "other-owner", ["ev_counter"]);
    const refuted = transitionHypothesis(conflicted, {
      kind: "refute",
      evidence_ids: ["ev_counter"],
      rationale: "Module B directly owns the reconnect entry point",
    });
    expect(refuted).toMatchObject({ ok: true, value: { status: "refuted" } });
  });

  it("does not mutate prior snapshots or erase conflict history", () => {
    const initial = created();
    const active = begin(initial);
    const conflicted = confirm(active, "other-owner", ["ev_counter"]);
    expect(initial.status).toBe("proposed");
    expect(active.status).toBe("investigating");
    expect(active.conflicts).toEqual([]);
    expect(Object.isFrozen(conflicted)).toBe(true);
    expect(Object.isFrozen(conflicted.history)).toBe(true);
    expect(() => {
      (conflicted as { status: string }).status = "supported";
    }).toThrow();
    expect(conflicted.history.map(({ sequence }) => sequence)).toEqual([
      1, 2, 3, 4,
    ]);
  });

  it("rejects unknown items and malformed commands without changing state", () => {
    const active = begin();
    const before = JSON.stringify(active);
    expect(
      transitionHypothesis(active, {
        kind: "record-checklist",
        checklist_item_id: "missing",
        disposition: "confirm",
        evidence_ids: ["ev_1"],
      }),
    ).toMatchObject({ ok: false, error: { code: "unknown-checklist-item" } });
    expect(
      transitionHypothesis(active, {
        kind: "record-checklist",
        checklist_item_id: "call-seen",
        disposition: "confirm",
        evidence_ids: [],
      }),
    ).toMatchObject({ ok: false, error: { code: "invalid-command" } });
    expect(JSON.stringify(active)).toBe(before);
  });

  it("validates persisted records and rejects duplicate checklist IDs", () => {
    expect(() =>
      createHypothesis({
        id: "hyp",
        statement: "claim",
        checklist: [
          { id: "same", label: "one", direction: "supporting" },
          { id: "same", label: "two", direction: "contradicting" },
        ],
      }),
    ).toThrow("unique");
    expect(hypothesisRecordSchema.safeParse({ id: "hyp" }).success).toBe(false);
  });
});
