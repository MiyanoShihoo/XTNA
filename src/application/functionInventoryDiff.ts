import { AnalysisInputError } from "../domain/analysisErrorCore.js";
import type { EvidenceIntegrityError } from "../domain/evidenceErrors.js";
import {
  parseFunctionEvidence,
  type FunctionSnapshot,
} from "../domain/functionDossierEvidence.js";
import {
  diffFunctionInventories,
  type VersionFunctionDiff,
} from "../domain/versionFunctionDiff.js";
import { err, ok, type Result } from "../domain/result.js";

const INVENTORY_KEYS = ["functions", "items", "evidence"] as const;

const INVENTORY_SHAPE =
  "A function inventory must be an array of analyze_function Evidence records, or an object holding exactly one such array under functions, items or evidence.";

const invalid = (message: string): AnalysisInputError =>
  new AnalysisInputError("diff_functions", { userMessage: message }, [
    { path: [], reason: "invalid_value", message },
  ]);

const inventoryArray = (
  value: unknown,
): Result<readonly unknown[], AnalysisInputError> => {
  if (Array.isArray(value)) return ok(value);
  if (typeof value !== "object" || value === null)
    return err(invalid(INVENTORY_SHAPE));
  const held = INVENTORY_KEYS.filter((key) =>
    Array.isArray((value as Record<string, unknown>)[key]),
  );
  if (held.length === 0) return err(invalid(INVENTORY_SHAPE));
  // Two declared tables are ambiguous; picking the first would silently drop
  // the other inventory instead of reporting the malformed document.
  if (held.length > 1)
    return err(
      invalid(
        `A function inventory document declares more than one inventory array (${held.join(", ")}); exactly one is required.`,
      ),
    );
  return ok((value as Record<string, unknown>)[held[0]!] as unknown[]);
};

/**
 * Read one function inventory: an array of analyze_function Evidence records,
 * or an object holding exactly one such array under `functions`, `items` or
 * `evidence`.
 */
export const parseFunctionInventory = (
  value: unknown,
): Result<
  readonly FunctionSnapshot[],
  AnalysisInputError | EvidenceIntegrityError
> => {
  const list = inventoryArray(value);
  if (!list.ok) return list;
  const snapshots: FunctionSnapshot[] = [];
  for (const [index, element] of list.value.entries()) {
    const parsed = parseFunctionEvidence(element, {
      operation: "diff_functions",
      path: [index],
    });
    if (!parsed.ok) return parsed;
    snapshots.push(parsed.value);
  }
  return ok(snapshots);
};

/** Compare two supplied inventories without reading or executing their subjects. */
export const diffFunctionInventoryDocuments = (
  left: unknown,
  right: unknown,
): Result<VersionFunctionDiff, AnalysisInputError | EvidenceIntegrityError> => {
  const parsedLeft = parseFunctionInventory(left);
  if (!parsedLeft.ok) return parsedLeft;
  const parsedRight = parseFunctionInventory(right);
  if (!parsedRight.ok) return parsedRight;
  return ok(diffFunctionInventories(parsedLeft.value, parsedRight.value));
};
