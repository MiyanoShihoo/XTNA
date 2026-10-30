import { z } from "zod";

import { freezeJsonSnapshot } from "../immutableJson.js";
import type { JsonValue } from "../jsonValue.js";
import { err, ok, type Result } from "../result.js";

const id = z.string().min(1);
const evidenceIds = z.array(id);

export const hypothesisStatusSchema = z.enum([
  "proposed",
  "investigating",
  "supported",
  "conflicted",
  "backtracked",
  "refuted",
]);

export const checklistItemSchema = z
  .object({
    id,
    label: z.string().min(1),
    direction: z.enum(["supporting", "contradicting"]),
    state: z.enum(["pending", "confirmed", "dismissed"]),
    evidence_ids: evidenceIds,
  })
  .strict();

export const hypothesisConflictSchema = z
  .object({
    id,
    checklist_item_id: id,
    evidence_ids: evidenceIds.nonempty(),
    previous_status: hypothesisStatusSchema,
    backtrack_to: z.literal("investigating"),
    resolution: z
      .object({
        kind: z.enum(["counter-evidence-dismissed", "hypothesis-revised"]),
        rationale: z.string().min(1),
        evidence_ids: evidenceIds,
      })
      .strict()
      .optional(),
  })
  .strict();

export const hypothesisEventSchema = z
  .object({
    sequence: z.number().int().positive(),
    kind: z.enum([
      "created",
      "investigation-started",
      "checklist-recorded",
      "supported",
      "conflict-backtracked",
      "conflict-resolved",
      "refuted",
    ]),
    evidence_ids: evidenceIds,
    detail: z.string().min(1),
  })
  .strict();

export const hypothesisRecordSchema = z
  .object({
    id,
    statement: z.string().min(1),
    status: hypothesisStatusSchema,
    checklist: z.array(checklistItemSchema),
    conflicts: z.array(hypothesisConflictSchema),
    history: z.array(hypothesisEventSchema).min(1),
  })
  .strict();

export const createHypothesisInputSchema = z
  .object({
    id,
    statement: z.string().min(1),
    checklist: z
      .array(
        z
          .object({
            id,
            label: z.string().min(1),
            direction: z.enum(["supporting", "contradicting"]),
          })
          .strict(),
      )
      .default([]),
  })
  .strict();

export const hypothesisCommandSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("start-investigation") }).strict(),
  z
    .object({
      kind: z.literal("record-checklist"),
      checklist_item_id: id,
      disposition: z.enum(["confirm", "dismiss"]),
      evidence_ids: evidenceIds.nonempty(),
      detail: z.string().min(1).default("Checklist evidence recorded"),
    })
    .strict(),
  z
    .object({
      kind: z.literal("mark-supported"),
      evidence_ids: evidenceIds.nonempty(),
      detail: z.string().min(1).default("Supporting checklist complete"),
    })
    .strict(),
  z
    .object({
      kind: z.literal("resolve-conflict"),
      conflict_id: id,
      resolution: z.enum(["counter-evidence-dismissed", "hypothesis-revised"]),
      rationale: z.string().min(1),
      evidence_ids: evidenceIds,
      revised_statement: z.string().min(1).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("refute"),
      evidence_ids: evidenceIds.nonempty(),
      rationale: z.string().min(1),
    })
    .strict(),
]);

export const hypothesisBoardErrorSchema = z
  .object({
    code: z.enum([
      "checklist-incomplete",
      "conflict-unresolved",
      "duplicate-checklist-item",
      "invalid-command",
      "invalid-state-transition",
      "unknown-checklist-item",
      "unknown-conflict",
    ]),
    message: z.string().min(1),
  })
  .strict();

export type HypothesisRecord = z.infer<typeof hypothesisRecordSchema>;
export type CreateHypothesisInput = z.input<typeof createHypothesisInputSchema>;
export type HypothesisCommand = z.input<typeof hypothesisCommandSchema>;
export type HypothesisBoardError = z.infer<typeof hypothesisBoardErrorSchema>;
export type HypothesisTransitionResult = Result<
  HypothesisRecord,
  HypothesisBoardError
>;

type MutableRecord = {
  id: string;
  statement: string;
  status: z.infer<typeof hypothesisStatusSchema>;
  checklist: {
    id: string;
    label: string;
    direction: "supporting" | "contradicting";
    state: "pending" | "confirmed" | "dismissed";
    evidence_ids: string[];
  }[];
  conflicts: {
    id: string;
    checklist_item_id: string;
    evidence_ids: string[];
    previous_status: z.infer<typeof hypothesisStatusSchema>;
    backtrack_to: "investigating";
    resolution?: {
      kind: "counter-evidence-dismissed" | "hypothesis-revised";
      rationale: string;
      evidence_ids: string[];
    };
  }[];
  history: {
    sequence: number;
    kind: z.infer<typeof hypothesisEventSchema>["kind"];
    evidence_ids: string[];
    detail: string;
  }[];
};

const seal = (record: MutableRecord): HypothesisRecord =>
  freezeJsonSnapshot(
    hypothesisRecordSchema.parse(record) as unknown as JsonValue,
  ) as unknown as HypothesisRecord;

const copy = (record: HypothesisRecord): MutableRecord =>
  structuredClone(record) as MutableRecord;

const failure = (
  code: HypothesisBoardError["code"],
  message: string,
): HypothesisTransitionResult => err({ code, message });

const event = (
  record: MutableRecord,
  kind: MutableRecord["history"][number]["kind"],
  evidence_ids: readonly string[],
  detail: string,
): void => {
  record.history.push({
    sequence: record.history.length + 1,
    kind,
    evidence_ids: [...new Set(evidence_ids)].sort(),
    detail,
  });
};

/** Create a proposed claim with explicit positive and negative checks, never a confidence score. */
export const createHypothesis = (
  input: CreateHypothesisInput,
): HypothesisRecord => {
  const parsed = createHypothesisInputSchema.parse(input);
  const ids = parsed.checklist.map(({ id: itemId }) => itemId);
  if (new Set(ids).size !== ids.length)
    throw new TypeError("Checklist item IDs must be unique");
  return seal({
    id: parsed.id,
    statement: parsed.statement,
    status: "proposed",
    checklist: parsed.checklist.map((item) => ({
      ...item,
      state: "pending",
      evidence_ids: [],
    })),
    conflicts: [],
    history: [
      {
        sequence: 1,
        kind: "created",
        evidence_ids: [],
        detail: "Hypothesis proposed; evidence remains to be investigated",
      },
    ],
  });
};

/** Apply one immutable transition; rejected commands return the original record untouched. */
// oxlint-disable-next-line max-lines-per-function, complexity -- The complete transition table stays adjacent for auditability.
export const transitionHypothesis = (
  current: HypothesisRecord,
  input: HypothesisCommand,
): HypothesisTransitionResult => {
  const checked = hypothesisRecordSchema.safeParse(current);
  if (!checked.success)
    return failure("invalid-command", "Current hypothesis record is invalid");
  const parsed = hypothesisCommandSchema.safeParse(input);
  if (!parsed.success)
    return failure("invalid-command", "Hypothesis command is invalid");
  const command = parsed.data;
  const next = copy(checked.data);
  if (command.kind === "start-investigation") {
    if (next.status !== "proposed")
      return failure(
        "invalid-state-transition",
        "Only a proposed hypothesis can start investigation",
      );
    next.status = "investigating";
    event(next, "investigation-started", [], "Investigation opened");
    return ok(seal(next));
  }
  if (command.kind === "record-checklist") {
    if (!["investigating", "supported"].includes(next.status))
      return failure(
        "invalid-state-transition",
        "Checklist evidence requires investigating or supported status",
      );
    const item = next.checklist.find(
      ({ id: itemId }) => itemId === command.checklist_item_id,
    );
    if (item === undefined)
      return failure("unknown-checklist-item", "Checklist item is unknown");
    item.state = command.disposition === "confirm" ? "confirmed" : "dismissed";
    item.evidence_ids = command.evidence_ids;
    event(
      next,
      "checklist-recorded",
      command.evidence_ids,
      `${item.id}: ${command.disposition}; ${command.detail}`,
    );
    if (item.direction === "contradicting" && item.state === "confirmed") {
      const conflictId = `conflict-${String(next.conflicts.length + 1)}`;
      next.conflicts.push({
        id: conflictId,
        checklist_item_id: item.id,
        evidence_ids: command.evidence_ids,
        previous_status: next.status,
        backtrack_to: "investigating",
      });
      next.status = "backtracked";
      event(
        next,
        "conflict-backtracked",
        command.evidence_ids,
        `${conflictId} requires backtracking to investigating`,
      );
    }
    return ok(seal(next));
  }
  if (command.kind === "mark-supported") {
    if (next.status !== "investigating")
      return failure(
        "invalid-state-transition",
        "Only an investigating hypothesis can be marked supported",
      );
    if (next.conflicts.some(({ resolution }) => resolution === undefined))
      return failure(
        "conflict-unresolved",
        "Resolve every conflict before marking supported",
      );
    const incomplete = next.checklist.filter(
      ({ state }) => state === "pending",
    );
    if (incomplete.length > 0)
      return failure(
        "checklist-incomplete",
        `Checklist items remain pending: ${incomplete.map(({ id: itemId }) => itemId).join(", ")}`,
      );
    if (
      !next.checklist.some(
        ({ direction, state }) =>
          direction === "supporting" && state === "confirmed",
      )
    )
      return failure(
        "checklist-incomplete",
        "At least one supporting checklist item must be confirmed",
      );
    next.status = "supported";
    event(next, "supported", command.evidence_ids, command.detail);
    return ok(seal(next));
  }
  if (command.kind === "resolve-conflict") {
    if (next.status !== "backtracked")
      return failure(
        "invalid-state-transition",
        "Only a backtracked hypothesis can resolve a conflict",
      );
    const conflict = next.conflicts.find(
      ({ id: conflictId }) => conflictId === command.conflict_id,
    );
    if (conflict === undefined)
      return failure("unknown-conflict", "Conflict is unknown");
    if (conflict.resolution !== undefined)
      return failure(
        "invalid-state-transition",
        "Conflict is already resolved",
      );
    if (
      command.resolution === "hypothesis-revised" &&
      command.revised_statement === undefined
    )
      return failure(
        "invalid-command",
        "A revised hypothesis requires revised_statement",
      );
    if (
      command.resolution === "counter-evidence-dismissed" &&
      command.revised_statement !== undefined
    )
      return failure(
        "invalid-command",
        "revised_statement is only valid for hypothesis-revised",
      );
    if (
      command.resolution === "hypothesis-revised" &&
      command.evidence_ids.length === 0
    )
      return failure(
        "invalid-command",
        "A hypothesis revision requires supporting evidence IDs",
      );
    if (command.resolution === "hypothesis-revised")
      next.statement = command.revised_statement!;
    conflict.resolution = {
      kind: command.resolution,
      rationale: command.rationale,
      evidence_ids: command.evidence_ids,
    };
    const item = next.checklist.find(
      ({ id: itemId }) => itemId === conflict.checklist_item_id,
    )!;
    item.state = "dismissed";
    next.status = "investigating";
    event(
      next,
      "conflict-resolved",
      command.evidence_ids,
      `${conflict.id}: ${command.rationale}`,
    );
    return ok(seal(next));
  }
  if (next.status !== "backtracked")
    return failure(
      "invalid-state-transition",
      "Refutation requires a backtracked conflict",
    );
  next.status = "refuted";
  event(next, "refuted", command.evidence_ids, command.rationale);
  return ok(seal(next));
};
