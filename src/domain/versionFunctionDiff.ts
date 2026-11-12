import { compareUnicodeCodePoints } from "./unicodeCodePointOrder.js";
import { hasStableNativeSymbol } from "./native/nativeSymbol.js";
import { compareFunctions } from "./functionComparison.js";
import type {
  DimensionName,
  FunctionComparisonUnknownReason,
} from "./functionComparisonSchemas.js";
import type { FunctionSnapshot } from "./functionDossierEvidence.js";

/**
 * Compare two inventories of the same artifact observed at different versions.
 *
 * A pair is built only from one stable symbol name on each side. A generated or
 * missing symbol, or a name that occurs more than once on a side, is reported
 * instead of guessed: pairing two unrelated functions would manufacture a
 * change that no provider observed.
 *
 * `unchanged` means every compared dimension reported equality. A dimension
 * whose facet the provider declared unavailable is reported as `unknown`, so
 * absence of evidence never reads as absence of change. This is a comparison of
 * observed facts, not a claim that two functions behave the same.
 */
export type FunctionPairStatus = "unchanged" | "changed" | "unknown";

export interface VersionFunctionChange {
  readonly key: string;
  readonly status: FunctionPairStatus;
  readonly paired_by: "stable_symbol";
  readonly changed_dimensions: readonly DimensionName[];
  readonly unknown_dimensions: readonly DimensionName[];
  /** Why each unknown dimension could not be judged, as observed upstream. */
  readonly unknown_reasons: readonly {
    readonly dimension: DimensionName;
    readonly reasons: readonly FunctionComparisonUnknownReason[];
  }[];
  readonly dimension_counts: {
    readonly unchanged: number;
    readonly changed: number;
    readonly unknown: number;
  };
  readonly left_evidence_id: string;
  readonly right_evidence_id: string;
  readonly limitations: readonly string[];
}

export type UnpairedReason = "duplicate_name" | "missing_stable_symbol";

export interface UnpairedFunction {
  readonly name: string;
  readonly side: "left" | "right" | "both";
  readonly reason: UnpairedReason;
}

export interface VersionFunctionDiff {
  readonly paired: readonly VersionFunctionChange[];
  readonly only_before: readonly string[];
  readonly only_after: readonly string[];
  readonly unpaired: readonly UnpairedFunction[];
  readonly summary: {
    readonly unchanged: number;
    readonly changed: number;
    readonly unknown: number;
    readonly only_before: number;
    readonly only_after: number;
    readonly unpaired: number;
  };
}

interface SideIndex {
  readonly stable: ReadonlyMap<string, readonly FunctionSnapshot[]>;
  /** Names whose origin the provider did not establish as a stable symbol. */
  readonly unstable: ReadonlyMap<string, readonly FunctionSnapshot[]>;
}

const push = (
  map: Map<string, FunctionSnapshot[]>,
  name: string,
  snapshot: FunctionSnapshot,
): void => {
  const existing = map.get(name);
  if (existing === undefined) map.set(name, [snapshot]);
  else existing.push(snapshot);
};

/**
 * Collapse only an identical record: the same Evidence appearing twice is one
 * observation. Two different records at one address — another provider, another
 * name — stay separate so the caller can see the ambiguity instead of losing it.
 */
const indexSide = (snapshots: readonly FunctionSnapshot[]): SideIndex => {
  const stable = new Map<string, FunctionSnapshot[]>();
  const unstable = new Map<string, FunctionSnapshot[]>();
  const seen = new Set<string>();
  for (const snapshot of snapshots) {
    const { name, symbol } = snapshot.dossier.procedure;
    const identity = snapshot.evidence.evidence_id;
    if (seen.has(identity)) continue;
    seen.add(identity);
    push(
      hasStableNativeSymbol(name, symbol) ? stable : unstable,
      name,
      snapshot,
    );
  }
  return { stable, unstable };
};

const changeOf = (
  key: string,
  left: FunctionSnapshot,
  right: FunctionSnapshot,
): VersionFunctionChange => {
  const comparison = compareFunctions(left, right);
  return {
    key,
    status: comparison.status,
    paired_by: "stable_symbol",
    changed_dimensions: comparison.dimensions
      .filter(({ status }) => status === "changed")
      .map(({ dimension }) => dimension),
    unknown_dimensions: comparison.dimensions
      .filter(({ status }) => status === "unknown")
      .map(({ dimension }) => dimension),
    unknown_reasons: comparison.dimensions.flatMap((dimension) =>
      dimension.status === "unknown"
        ? [
            {
              dimension: dimension.dimension,
              reasons: dimension.unknown_reasons ?? ["unspecified"],
            },
          ]
        : [],
    ),
    dimension_counts: comparison.summary,
    left_evidence_id: left.evidence.evidence_id,
    right_evidence_id: right.evidence.evidence_id,
    limitations: comparison.limitations,
  };
};

const names = (index: SideIndex): Set<string> => {
  const all = new Set<string>(index.stable.keys());
  for (const name of index.unstable.keys()) all.add(name);
  return all;
};

type NameOutcome =
  | {
      readonly kind: "pair";
      readonly left: FunctionSnapshot;
      readonly right: FunctionSnapshot;
    }
  | { readonly kind: "only_before" }
  | { readonly kind: "only_after" }
  | { readonly kind: "unpaired"; readonly entry: UnpairedFunction };

/** Decide one name's fate from the counts on each side. */
const classifyName = (
  name: string,
  leftIndex: SideIndex,
  rightIndex: SideIndex,
): NameOutcome => {
  const leftStable = leftIndex.stable.get(name) ?? [];
  const rightStable = rightIndex.stable.get(name) ?? [];
  // Duplicates are counted across both tables: a generated namesake is still
  // another function carrying that name, so pairing past it would hide it.
  const leftCount =
    leftStable.length + (leftIndex.unstable.get(name)?.length ?? 0);
  const rightCount =
    rightStable.length + (rightIndex.unstable.get(name)?.length ?? 0);
  if (leftCount > 1 || rightCount > 1)
    return {
      kind: "unpaired",
      entry: {
        name,
        side:
          leftCount > 1 && rightCount > 1
            ? "both"
            : leftCount > 1
              ? "left"
              : "right",
        reason: "duplicate_name",
      },
    };
  if (leftCount === 1 && rightCount === 1) {
    const left = leftStable[0];
    const right = rightStable[0];
    if (left !== undefined && right !== undefined)
      return { kind: "pair", left, right };
    return {
      kind: "unpaired",
      entry: {
        name,
        side:
          leftStable.length === 1
            ? "right"
            : rightStable.length === 1
              ? "left"
              : "both",
        reason: "missing_stable_symbol",
      },
    };
  }
  return leftCount === 1 ? { kind: "only_before" } : { kind: "only_after" };
};

/** Diff two function inventories, reusing the single-function comparison. */
export const diffFunctionInventories = (
  left: readonly FunctionSnapshot[],
  right: readonly FunctionSnapshot[],
): VersionFunctionDiff => {
  const leftIndex = indexSide(left);
  const rightIndex = indexSide(right);
  const paired: VersionFunctionChange[] = [];
  const onlyBefore: string[] = [];
  const onlyAfter: string[] = [];
  const unpaired: UnpairedFunction[] = [];

  for (const name of new Set([...names(leftIndex), ...names(rightIndex)])) {
    const outcome = classifyName(name, leftIndex, rightIndex);
    if (outcome.kind === "pair")
      paired.push(changeOf(name, outcome.left, outcome.right));
    else if (outcome.kind === "only_before") onlyBefore.push(name);
    else if (outcome.kind === "only_after") onlyAfter.push(name);
    else unpaired.push(outcome.entry);
  }

  const byKey = (a: { key: string }, b: { key: string }) =>
    compareUnicodeCodePoints(a.key, b.key);
  const byName = (a: string, b: string) => compareUnicodeCodePoints(a, b);
  const sortedPaired = [...paired].sort(byKey);
  const sortedUnpaired = [...unpaired].sort(
    (a, b) =>
      compareUnicodeCodePoints(a.name, b.name) ||
      compareUnicodeCodePoints(a.side, b.side) ||
      compareUnicodeCodePoints(a.reason, b.reason),
  );

  return {
    paired: sortedPaired,
    only_before: [...onlyBefore].sort(byName),
    only_after: [...onlyAfter].sort(byName),
    unpaired: sortedUnpaired,
    summary: {
      unchanged: sortedPaired.filter(({ status }) => status === "unchanged")
        .length,
      changed: sortedPaired.filter(({ status }) => status === "changed").length,
      unknown: sortedPaired.filter(({ status }) => status === "unknown").length,
      only_before: onlyBefore.length,
      only_after: onlyAfter.length,
      unpaired: unpaired.length,
    },
  };
};
