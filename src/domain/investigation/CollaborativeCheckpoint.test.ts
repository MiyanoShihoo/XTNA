import { describe, expect, it } from "vitest";
import { appendCheckpoint, checkpointDigest, emptyCollaboration, mergeCheckpoints } from "./CollaborativeCheckpoint.js";

const checkpoint = (actor: string, operation: string) => ({ schema: "xtna.collaborative-checkpoint/1" as const, parents: [], actor, operations: [{ id: operation, kind: "hypothesis" as const, payload: { statement: operation } }] });

describe("collaborative checkpoints", () => {
  it("merges concurrent immutable histories without losing either head", () => {
    const left = appendCheckpoint(emptyCollaboration(), checkpoint("left", "one"));
    const right = appendCheckpoint(emptyCollaboration(), checkpoint("right", "two"));
    const merged = mergeCheckpoints(left, right);
    expect(merged.heads).toHaveLength(2);
    expect(Object.values(merged.checkpoints).flatMap(({ operations }) => operations).map(({ id }) => id).sort()).toEqual(["one", "two"]);
  });

  it("advances a head only after all parents are present", () => {
    const base = appendCheckpoint(emptyCollaboration(), checkpoint("a", "one"));
    const parent = base.heads[0]!;
    const next = appendCheckpoint(base, { ...checkpoint("b", "two"), parents: [parent] });
    expect(next.heads).toEqual([checkpointDigest({ ...checkpoint("b", "two"), parents: [parent] })]);
  });

  it("keeps identical operation IDs with different content as conflicts", () => {
    const left = appendCheckpoint(emptyCollaboration(), checkpoint("a", "same"));
    const right = appendCheckpoint(emptyCollaboration(), { ...checkpoint("b", "same"), operations: [{ id: "same", kind: "unknown", payload: null }] });
    expect(mergeCheckpoints(left, right).conflicts).toEqual(["same"]);
  });
});
