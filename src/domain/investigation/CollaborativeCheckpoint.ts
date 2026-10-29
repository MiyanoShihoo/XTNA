import { createHash } from "node:crypto";

export interface CheckpointDocument {
  readonly schema: "xtna.collaborative-checkpoint/1";
  readonly parents: readonly string[];
  readonly actor: string;
  readonly operations: readonly CheckpointOperation[];
}

export interface CheckpointOperation {
  readonly id: string;
  readonly kind: "evidence" | "hypothesis" | "unknown";
  readonly payload: unknown;
}

const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && value !== null) return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
};

export const checkpointDigest = (document: CheckpointDocument): string => `cp_${createHash("sha256").update(canonical(document)).digest("hex")}`;

export interface CollaborationState {
  readonly heads: readonly string[];
  readonly checkpoints: Readonly<Record<string, CheckpointDocument>>;
  readonly conflicts: readonly string[];
}

/** Merge immutable DAG histories; concurrent edits remain visible, never silently overwritten. */
export const mergeCheckpoints = (left: CollaborationState, right: CollaborationState): CollaborationState => {
  const checkpoints = { ...left.checkpoints };
  const conflicts: string[] = [];
  for (const [id, document] of Object.entries(right.checkpoints)) {
    const existing = checkpoints[id];
    if (existing !== undefined && checkpointDigest(existing) !== checkpointDigest(document)) conflicts.push(id);
    else checkpoints[id] = document;
  }
  const referenced = new Set(Object.values(checkpoints).flatMap(({ parents }) => parents));
  const heads = [...new Set([...left.heads, ...right.heads])].filter((id) => checkpoints[id] !== undefined && !referenced.has(id)).sort();
  const operations = new Map<string, CheckpointOperation>();
  for (const document of Object.values(checkpoints)) for (const operation of document.operations) {
    const existing = operations.get(operation.id);
    if (existing !== undefined && canonical(existing) !== canonical(operation)) conflicts.push(operation.id);
    operations.set(operation.id, operation);
  }
  return { heads, checkpoints, conflicts: [...new Set([...left.conflicts, ...right.conflicts, ...conflicts])].sort() };
};

export const emptyCollaboration = (): CollaborationState => ({ heads: [], checkpoints: {}, conflicts: [] });

export const appendCheckpoint = (state: CollaborationState, document: CheckpointDocument): CollaborationState => {
  const id = checkpointDigest(document);
  if (document.parents.some((parent) => state.checkpoints[parent] === undefined)) throw new TypeError("Checkpoint parent is unavailable");
  if (state.checkpoints[id] !== undefined) return state;
  return mergeCheckpoints(state, { heads: [id], checkpoints: { [id]: document }, conflicts: [] });
};
