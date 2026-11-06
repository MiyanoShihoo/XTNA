import { z } from "zod";

import { prefixedDigestSchema } from "./digests.js";
import { evidenceSchema } from "./evidence.js";
import {
  functionComparisonDimensionNameSchema,
  functionComparisonUnknownReasonSchema,
} from "./functionComparisonSchemas.js";

/**
 * Upper bound on the observations one side of a version diff may declare.
 *
 * Each record is a complete function dossier, so this is already far beyond a
 * usable request. It exists to reject an unbounded document before it is
 * parsed, not to admit a large one.
 */
export const MAX_FUNCTION_INVENTORY_RECORDS = 5000;

const evidenceIdSchema = prefixedDigestSchema("ev");

/**
 * Observations are inline Evidence records only. The same schema the other
 * comparison tools advertise is reused here, so a record that is acceptable to
 * `compare_functions` is acceptable to this tool, and no path, reference or
 * free-form value can be smuggled in.
 */
const inventoryRecordsSchema = z
  .array(evidenceSchema)
  .max(MAX_FUNCTION_INVENTORY_RECORDS)
  .describe(
    `At most ${String(MAX_FUNCTION_INVENTORY_RECORDS)} analyze_function Evidence records.`,
  );

/**
 * One side of a version diff: the same shape `diffFunctionInventoryDocuments`
 * accepts, so the CLI and the tool read identical documents.
 */
const functionInventoryDocumentSchema = z.union([
  inventoryRecordsSchema,
  z
    .strictObject({
      functions: inventoryRecordsSchema.optional(),
      items: inventoryRecordsSchema.optional(),
      evidence: inventoryRecordsSchema.optional(),
    })
    .describe(
      "A document holding exactly one inventory array under functions, items or evidence.",
    ),
]);

/** Inline-only inputs: no filesystem path can be supplied to this tool. */
export const functionInventoryDiffInputSchema = z.strictObject({
  left: functionInventoryDocumentSchema.describe(
    "Left inventory: an array of analyze_function Evidence records, or an object holding exactly one such array.",
  ),
  right: functionInventoryDocumentSchema.describe(
    "Right inventory: an array of analyze_function Evidence records, or an object holding exactly one such array.",
  ),
});

const unknownReasonEntrySchema = z.strictObject({
  dimension: functionComparisonDimensionNameSchema,
  reasons: z.array(functionComparisonUnknownReasonSchema).min(1),
});

const versionFunctionChangeSchema = z.strictObject({
  key: z.string(),
  status: z.enum(["unchanged", "changed", "unknown"]),
  paired_by: z.literal("stable_symbol"),
  changed_dimensions: z.array(functionComparisonDimensionNameSchema),
  unknown_dimensions: z.array(functionComparisonDimensionNameSchema),
  unknown_reasons: z.array(unknownReasonEntrySchema),
  dimension_counts: z.strictObject({
    unchanged: z.int().min(0),
    changed: z.int().min(0),
    unknown: z.int().min(0),
  }),
  left_evidence_id: evidenceIdSchema,
  right_evidence_id: evidenceIdSchema,
  limitations: z.array(z.string()),
});

const unpairedFunctionSchema = z.strictObject({
  name: z.string(),
  side: z.enum(["left", "right", "both"]),
  reason: z.enum(["duplicate_name", "missing_stable_symbol"]),
});

/**
 * Wire shape of the version-level function diff.
 *
 * This mirrors `VersionFunctionDiff`. Two guards keep the two aligned: a
 * type-level assertion in the tool's test covers the declared fields, and the
 * strict objects below make the runtime round-trip in that test reject any
 * emitted field the interface does not declare, at every depth. Nested
 * optional fields are invisible to the type assertions alone.
 */
export const versionFunctionDiffSchema = z.strictObject({
  paired: z.array(versionFunctionChangeSchema),
  only_before: z.array(z.string()),
  only_after: z.array(z.string()),
  unpaired: z.array(unpairedFunctionSchema),
  summary: z.strictObject({
    unchanged: z.int().min(0),
    changed: z.int().min(0),
    unknown: z.int().min(0),
    only_before: z.int().min(0),
    only_after: z.int().min(0),
    unpaired: z.int().min(0),
  }),
});
