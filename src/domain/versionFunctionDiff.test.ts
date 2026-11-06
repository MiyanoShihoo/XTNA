import { describe, expect, it } from "vitest";

import { createEvidence, type Evidence } from "./evidence.js";
import { createAnalysisProfile } from "./analysisProfile.js";
import { createFunctionCoordinateContext } from "./native/functionCoordinateContext.js";
import { enhancedInputSchemas } from "../contracts/enhancedInputs.js";
import { functionDossierSchema } from "./native/functionDossier.js";
import { functionSnapshotFixture } from "./functionDossierEvidence.fixture.js";
import { diffFunctionInventories } from "./versionFunctionDiff.js";
import type { FunctionSnapshot } from "./functionDossierEvidence.js";

const symbol = (source: "imported" | "default") => ({
  primary: true,
  dynamic: false,
  external: false,
  type: "function",
  source,
});

const dossier = (input: {
  readonly address: string;
  readonly name: string;
  readonly source?: "imported" | "default";
  readonly pseudocode?: string;
  readonly signature?: string;
  readonly blocks?: readonly {
    readonly start: string;
    readonly end: string;
    readonly successors: readonly string[];
  }[];
  readonly cfgAvailable?: boolean;
  readonly undeclaredPseudocode?: boolean;
  readonly partialCoverage?: boolean;
  readonly callees?: readonly string[];
  readonly generatedCallees?: readonly string[];
  readonly strings?: readonly string[];
  readonly stringRows?: readonly {
    readonly source: string;
    readonly value: string;
    readonly typed?: {
      readonly encoding: string;
      readonly termination: "missing" | "present_or_not_required";
      readonly byte_length: number;
    };
  }[];
}) =>
  functionDossierSchema.parse({
    procedure: {
      address: input.address,
      name: input.name,
      symbol: symbol(input.source ?? "imported"),
      classification: null,
      signature: input.signature ?? "int main(void)",
      locals: [],
      body: { available: false, reason: "fixture has no body range" },
    },
    pseudocode:
      input.undeclaredPseudocode === true
        ? ""
        : (input.pseudocode ?? "return 0;"),
    assembly: ["ret"],
    comments: [],
    callers: [],
    callees: [
      ...(input.callees ?? []).map((name, index) => ({
        address: `0x${String(9000 + index)}`,
        name,
        symbol: symbol("imported"),
        classification: null,
        body: { available: false, reason: "fixture has no body range" },
      })),
      // A callee the provider never resolved leaves the relationship identity
      // unknown, which is what the calls-dimension reason fixture needs.
      ...(input.generatedCallees ?? []).map((name, index) => ({
        address: `0x${String(9500 + index)}`,
        name,
        symbol: symbol("default"),
        classification: null,
        body: { available: false, reason: "fixture has no body range" },
      })),
    ],
    incoming_references: [],
    outgoing_references: [],
    referenced_strings: [
      ...(input.strings ?? []).map((value, index) => ({
        address: `0x${String(8000 + index)}`,
        value,
        source_address: `0x${String(1000 + index)}`,
      })),
      // Repeated rows at one source offset with mixed typed metadata: the
      // shape that proves a metadata limit is reported as a reason, not prose.
      ...(input.stringRows ?? []).map((row, index) => ({
        address: `0x${String(7000 + index)}`,
        value: row.value,
        source_address: row.source,
        ...(row.typed === undefined ? {} : { string: row.typed }),
      })),
    ],
    referenced_names: [],
    native_api: null,
    native_value_flow: null,
    facet_availability: {
      ...(input.undeclaredPseudocode === true
        ? {}
        : { pseudocode: { available: true } }),
      assembly: { available: true },
      comments: { available: true },
      callers: { available: true },
      callees: { available: true },
      references: { available: true },
      strings_names: { available: true },
      cfg:
        input.cfgAvailable === false
          ? { available: false, reason: "provider did not report blocks" }
          : { available: true },
    },
    basic_blocks: input.blocks ?? [
      {
        start: input.address,
        end: `${input.address.slice(0, -1)}1`,
        successors: [],
      },
    ],
    limitations: [],
  });

const snapshot = (
  value: ReturnType<typeof dossier>,
  seed: string,
  providerId = "fixture",
  partialCoverage = false,
): FunctionSnapshot => {
  const observingProvider = {
    id: providerId,
    name: providerId,
    version: "1",
  } as const;
  const evidence: Evidence = createEvidence(
    {
      path: `/fixture/${seed}`,
      sha256: seed.repeat(64).slice(0, 64),
      format: "mach-o",
      architecture: "arm64",
    },
    observingProvider,
    {
      operation: "analyze_function",
      analysisProfile: createAnalysisProfile(observingProvider, {
        architecture: "arm64",
        loader: "auto-from-header",
        function_coordinate_context: createFunctionCoordinateContext({
          loader: "auto-from-header",
          language_id: "auto-from-header",
          compiler_spec_id: "auto-default",
          load_segment: null,
          address_coordinates: null,
          entry_point: null,
        }),
      }),
      parameters: enhancedInputSchemas.analyze_function.parse({
        procedure: value.procedure.name,
      }),
      result: value,
      confidence: "derived",
      authority: "shipped-artifact",
      relationshipCoverage: partialCoverage
        ? {
            status: "partial",
            limitations: ["fixture: call discovery stopped at the first hop"],
          }
        : { status: "complete" },
    },
  );
  return functionSnapshotFixture(evidence);
};

const main = (text: string, address = "0x1000", seed = "a") =>
  snapshot(dossier({ address, name: "main", pseudocode: text }), seed);

describe("version-level function diff", () => {
  it("reports identical inventories as unchanged", () => {
    const diff = diffFunctionInventories(
      [main("return 0;", "0x1000", "a")],
      [main("return 0;", "0x2000", "b")],
    );
    expect(diff.summary).toEqual({
      unchanged: 1,
      changed: 0,
      unknown: 0,
      only_before: 0,
      only_after: 0,
      unpaired: 0,
    });
    expect(diff.paired[0]!.changed_dimensions).toEqual([]);
  });

  it("names the changed dimension instead of a generic verdict", () => {
    const diff = diffFunctionInventories(
      [main("return 0;")],
      [main("return 1;")],
    );
    expect(diff.paired[0]).toMatchObject({
      key: "main",
      status: "changed",
      paired_by: "stable_symbol",
    });
    expect(diff.paired[0]!.changed_dimensions).toContain("pseudocode");
    expect(diff.paired[0]!.changed_dimensions).not.toContain("cfg");
  });

  it("detects a control-flow change over unchanged text", () => {
    const left = snapshot(
      dossier({
        address: "0x1000",
        name: "main",
        blocks: [
          { start: "0x1000", end: "0x1004", successors: ["0x1004"] },
          { start: "0x1004", end: "0x1008", successors: [] },
        ],
      }),
      "c",
    );
    const right = snapshot(
      dossier({
        address: "0x1000",
        name: "main",
        blocks: [{ start: "0x1000", end: "0x1008", successors: [] }],
      }),
      "d",
    );
    const diff = diffFunctionInventories([left], [right]);
    expect(diff.paired[0]!.status).toBe("changed");
    expect(diff.paired[0]!.changed_dimensions).toContain("cfg");
  });

  it("separates functions that exist on only one side", () => {
    const removed = snapshot(
      dossier({ address: "0x1000", name: "old_helper" }),
      "e",
    );
    const added = snapshot(
      dossier({ address: "0x1000", name: "new_helper" }),
      "f",
    );
    const diff = diffFunctionInventories([removed], [added]);
    expect(diff.only_before).toEqual(["old_helper"]);
    expect(diff.only_after).toEqual(["new_helper"]);
    expect(diff.paired).toEqual([]);
  });
});

describe("version diff pairing refusals", () => {
  it("refuses to pair a duplicated name", () => {
    const first = snapshot(dossier({ address: "0x1000", name: "main" }), "1");
    const second = snapshot(dossier({ address: "0x2000", name: "main" }), "2");
    const diff = diffFunctionInventories([first, second], [main("return 0;")]);
    expect(diff.paired).toEqual([]);
    expect(diff.unpaired).toEqual([
      { name: "main", side: "left", reason: "duplicate_name" },
    ]);
  });

  it("refuses to pair a generated symbol on both sides", () => {
    const generated = snapshot(
      dossier({ address: "0x1000", name: "FUN_1000", source: "default" }),
      "3",
    );
    const diff = diffFunctionInventories([generated], [generated]);
    expect(diff.paired).toEqual([]);
    expect(diff.unpaired).toEqual([
      { name: "FUN_1000", side: "both", reason: "missing_stable_symbol" },
    ]);
  });

  it("does not fall back to one-sided pairing when one side is generated", () => {
    const generated = snapshot(
      dossier({ address: "0x1000", name: "main", source: "default" }),
      "6",
    );
    const named = snapshot(dossier({ address: "0x1000", name: "main" }), "7");
    const diff = diffFunctionInventories([generated], [named]);
    expect(diff.paired).toEqual([]);
    expect(diff.only_after).toEqual([]);
    expect(diff.unpaired).toEqual([
      { name: "main", side: "left", reason: "missing_stable_symbol" },
    ]);
  });

  // A generated name that exists on only one side is still an arrival or a
  // departure; refusing to pair it must not hide the function from the diff.
  it("reports a generated function that exists on only one side", () => {
    const generated = snapshot(
      dossier({ address: "0x1000", name: "FUN_1000", source: "default" }),
      "8",
    );
    const diff = diffFunctionInventories([], [generated]);
    expect(diff.only_after).toEqual(["FUN_1000"]);
    expect(diff.unpaired).toEqual([]);
    expect(diff.summary).toMatchObject({ only_after: 1, unpaired: 0 });
  });

  // A generated namesake is another function carrying the name: pairing past it
  // would drop that observation without saying so.
  it("reports a duplicated name when a generated namesake shares it", () => {
    const stableLeft = snapshot(
      dossier({ address: "0x1000", name: "init" }),
      "9",
    );
    const generatedLeft = snapshot(
      dossier({ address: "0x2000", name: "init", source: "default" }),
      "a",
    );
    const stableRight = snapshot(
      dossier({ address: "0x3000", name: "init" }),
      "b",
    );
    const diff = diffFunctionInventories(
      [stableLeft, generatedLeft],
      [stableRight],
    );
    expect(diff.paired).toEqual([]);
    expect(diff.unpaired).toEqual([
      { name: "init", side: "left", reason: "duplicate_name" },
    ]);
  });

  it("reports a one-sided duplicate instead of collapsing it into an arrival", () => {
    const first = snapshot(dossier({ address: "0x1000", name: "main" }), "c1");
    const second = snapshot(dossier({ address: "0x2000", name: "main" }), "c2");
    const diff = diffFunctionInventories([first, second], []);
    expect(diff.only_before).toEqual([]);
    expect(diff.unpaired).toEqual([
      { name: "main", side: "left", reason: "duplicate_name" },
    ]);
  });

  it("names a non-pseudocode dimension when only that dimension differs", () => {
    const left = snapshot(
      dossier({ address: "0x1000", name: "main", signature: "int main(void)" }),
      "c",
    );
    const right = snapshot(
      dossier({ address: "0x1000", name: "main", signature: "int main(int)" }),
      "d",
    );
    const diff = diffFunctionInventories([left], [right]);
    expect(diff.paired[0]!.changed_dimensions).toEqual(["identity"]);
    expect(diff.paired[0]!.dimension_counts.changed).toBe(1);
  });

  it("sorts paired keys and one-sided names", () => {
    const left = ["zulu", "alpha", "mike"].map((name, index) =>
      snapshot(
        dossier({ address: `0x${String(1000 + index)}`, name }),
        String(index + 1),
      ),
    );
    const right = [
      snapshot(dossier({ address: "0x3000", name: "zulu" }), "e"),
      snapshot(dossier({ address: "0x4000", name: "alpha" }), "f"),
    ];
    const diff = diffFunctionInventories(left, right);
    expect(diff.paired.map(({ key }) => key)).toEqual(["alpha", "zulu"]);
    expect(diff.only_before).toEqual(["mike"]);
  });

  it("reports unknown rather than unchanged when a facet is unavailable", () => {
    const left = snapshot(
      dossier({ address: "0x1000", name: "main", cfgAvailable: false }),
      "4",
    );
    const right = snapshot(dossier({ address: "0x1000", name: "main" }), "5");
    const diff = diffFunctionInventories([left], [right]);
    expect(diff.paired[0]!.status).toBe("unknown");
    expect(diff.paired[0]!.unknown_dimensions).toContain("cfg");
  });
});

describe("version diff over calls and strings", () => {
  it("reports a changed callee set", () => {
    const left = snapshot(
      dossier({ address: "0x1000", name: "main", callees: ["puts"] }),
      "01",
    );
    const right = snapshot(
      dossier({ address: "0x1000", name: "main", callees: ["puts", "malloc"] }),
      "02",
    );
    const diff = diffFunctionInventories([left], [right]);
    expect(diff.paired[0]!.changed_dimensions).toEqual(["calls"]);
    expect(diff.paired[0]!.dimension_counts.changed).toBe(1);
  });

  it("reports a changed referenced-string set", () => {
    const left = snapshot(
      dossier({ address: "0x1000", name: "main", strings: ["hello"] }),
      "03",
    );
    const right = snapshot(
      dossier({ address: "0x1000", name: "main", strings: ["hello", "world"] }),
      "04",
    );
    const diff = diffFunctionInventories([left], [right]);
    expect(diff.paired[0]!.changed_dimensions).toEqual(["strings_names"]);
  });

  it("reports both dimensions when both changed", () => {
    const left = snapshot(
      dossier({
        address: "0x1000",
        name: "main",
        callees: ["puts"],
        strings: ["a"],
      }),
      "05",
    );
    const right = snapshot(
      dossier({
        address: "0x1000",
        name: "main",
        callees: ["fwrite"],
        strings: ["b"],
      }),
      "06",
    );
    const diff = diffFunctionInventories([left], [right]);
    expect(diff.paired[0]!.changed_dimensions).toEqual([
      "calls",
      "strings_names",
    ]);
    expect(diff.paired[0]!.dimension_counts.changed).toBe(2);
  });

  it("does not depend on the order of the input inventories", () => {
    const alpha = snapshot(dossier({ address: "0x1000", name: "alpha" }), "07");
    const beta = snapshot(dossier({ address: "0x2000", name: "beta" }), "08");
    const forward = diffFunctionInventories([alpha, beta], [alpha, beta]);
    const reversed = diffFunctionInventories([beta, alpha], [beta, alpha]);
    expect(forward).toEqual(reversed);
    expect(forward.paired.map(({ key }) => key)).toEqual(["alpha", "beta"]);
    expect(forward.summary.unchanged).toBe(2);
  });

  it("counts a repeated observation of the same function once", () => {
    const observation = snapshot(
      dossier({ address: "0x1000", name: "main" }),
      "09",
    );
    const diff = diffFunctionInventories(
      [observation, observation],
      [observation],
    );
    expect(diff.paired).toHaveLength(1);
    expect(diff.unpaired).toEqual([]);
    expect(diff.summary.unchanged).toBe(1);
  });

  it("keeps observations from different providers apart", () => {
    const first = snapshot(
      dossier({ address: "0x1000", name: "main" }),
      "0a",
      "provider-a",
    );
    const second = snapshot(
      dossier({ address: "0x1000", name: "main" }),
      "0a",
      "provider-b",
    );
    const diff = diffFunctionInventories([first, second], [first]);
    expect(diff.paired).toEqual([]);
    expect(diff.unpaired).toEqual([
      { name: "main", side: "left", reason: "duplicate_name" },
    ]);
  });

  it("preserves both evidence ids and the comparison limitations", () => {
    const left = snapshot(dossier({ address: "0x1000", name: "main" }), "0b");
    const right = snapshot(dossier({ address: "0x1000", name: "main" }), "0c");
    const diff = diffFunctionInventories([left], [right]);
    expect(diff.paired[0]!.left_evidence_id).toBe(left.evidence.evidence_id);
    expect(diff.paired[0]!.right_evidence_id).toBe(right.evidence.evidence_id);
    expect(diff.paired[0]!.limitations).toEqual([]);
  });
});

describe("version diff record identity", () => {
  it("keeps two records at one address distinct and order-independent", () => {
    const generated = snapshot(
      dossier({ address: "0x1000", name: "FUN_1000", source: "default" }),
      "d1",
    );
    const named = snapshot(dossier({ address: "0x1000", name: "main" }), "d2");
    const right = snapshot(dossier({ address: "0x1000", name: "main" }), "d3");
    const forward = diffFunctionInventories([generated, named], [right]);
    const reversed = diffFunctionInventories([named, generated], [right]);
    expect(forward).toEqual(reversed);
    expect(forward.paired.map(({ key }) => key)).toEqual(["main"]);
    expect(forward.only_before).toEqual(["FUN_1000"]);
  });
});

describe("unknown reason codes", () => {
  const reasonsOf = (
    diff: ReturnType<typeof diffFunctionInventories>,
    name: string,
  ) => diff.paired.find(({ key }) => key === name)!.unknown_reasons;

  it("reports provider_mismatch when two providers are compared", () => {
    const left = snapshot(
      dossier({ address: "0x1000", name: "main" }),
      "e1",
      "a",
    );
    const right = snapshot(
      dossier({ address: "0x1000", name: "main" }),
      "e2",
      "b",
    );
    const diff = diffFunctionInventories([left], [right]);
    const reasons = reasonsOf(diff, "main");
    const text = reasons.filter(({ dimension }) =>
      ["pseudocode", "assembly"].includes(dimension),
    );
    expect(text).toHaveLength(2);
    expect(
      text.every(({ reasons }) => reasons.includes("provider_mismatch")),
    ).toBe(true);
  });

  it("reports facet_unavailable when the provider declines a facet", () => {
    const left = snapshot(
      dossier({ address: "0x1000", name: "main", cfgAvailable: false }),
      "e3",
    );
    const right = snapshot(dossier({ address: "0x1000", name: "main" }), "e4");
    const diff = diffFunctionInventories([left], [right]);
    expect(reasonsOf(diff, "main")).toEqual([
      { dimension: "cfg", reasons: ["facet_unavailable"] },
    ]);
  });

  it("distinguishes an undeclared facet from an unavailable one", () => {
    const left = snapshot(
      dossier({ address: "0x1000", name: "main", undeclaredPseudocode: true }),
      "e5",
    );
    const right = snapshot(dossier({ address: "0x1000", name: "main" }), "e6");
    const diff = diffFunctionInventories([left], [right]);
    const reasons = reasonsOf(diff, "main");
    expect(reasons).toEqual([
      { dimension: "pseudocode", reasons: ["facet_undeclared"] },
    ]);
  });

  it("reports normalization_failed when CFG blocks cannot be indexed", () => {
    const left = snapshot(
      dossier({
        address: "0x1000",
        name: "main",
        blocks: [
          { start: "0x1000", end: "0x1004", successors: [] },
          { start: "0x1000", end: "0x1008", successors: [] },
        ],
      }),
      "e7",
    );
    const right = snapshot(dossier({ address: "0x1000", name: "main" }), "e8");
    const diff = diffFunctionInventories([left], [right]);
    expect(reasonsOf(diff, "main")).toEqual([
      { dimension: "cfg", reasons: ["normalization_failed"] },
    ]);
  });

  it("reports diff_budget_exceeded when the text diff is bounded out", () => {
    const leftText = Array.from({ length: 6000 }, (_, i) => `line ${i} a`).join(
      "\n",
    );
    const rightText = Array.from(
      { length: 6000 },
      (_, i) => `line ${i} b`,
    ).join("\n");
    const left = snapshot(
      dossier({ address: "0x1000", name: "main", pseudocode: leftText }),
      "e9",
    );
    const right = snapshot(
      dossier({ address: "0x1000", name: "main", pseudocode: rightText }),
      "ea",
    );
    const diff = diffFunctionInventories([left], [right]);
    const pseudo = reasonsOf(diff, "main").find(
      ({ dimension }) => dimension === "pseudocode",
    );
    expect(pseudo?.reasons).toContain("diff_budget_exceeded");
  });

  it("keeps changed and unknown dimensions side by side with their reasons", () => {
    const left = snapshot(
      dossier({
        address: "0x1000",
        name: "main",
        pseudocode: "return 0;",
        cfgAvailable: false,
      }),
      "eb",
    );
    const right = snapshot(
      dossier({ address: "0x1000", name: "main", pseudocode: "return 1;" }),
      "ec",
    );
    const diff = diffFunctionInventories([left], [right]);
    const pair = diff.paired[0]!;
    expect(pair.status).toBe("changed");
    expect(pair.changed_dimensions).toContain("pseudocode");
    expect(pair.unknown_dimensions).toContain("cfg");
    expect(pair.unknown_reasons).toEqual([
      { dimension: "cfg", reasons: ["facet_unavailable"] },
    ]);
  });
});
describe("unspecified reasons", () => {
  it("records unspecified when a caller cannot name the limit", async () => {
    const { unresolvedDimension } =
      await import("./functionComparisonResults.js");
    const dimension = unresolvedDimension({
      dimension: "cfg",
      links: ["ev_" + "1".repeat(64), "ev_" + "2".repeat(64)],
      leftCount: null,
      rightCount: null,
      limitations: ["something the producer could not classify"],
    });
    expect(dimension.status).toBe("unknown");
    if (dimension.status !== "unknown") throw new Error("expected unknown");
    expect(dimension.unknown_reasons).toEqual(["unspecified"]);
  });
});

describe("reason provenance", () => {
  it("keeps a producer reason when a facet limit also applies", () => {
    const left = snapshot(
      dossier({
        address: "0x1000",
        name: "main",
        undeclaredPseudocode: true,
      }),
      "f1",
      "provider-a",
    );
    const right = snapshot(
      dossier({ address: "0x1000", name: "main", pseudocode: "return 0;" }),
      "f2",
      "provider-b",
    );
    const diff = diffFunctionInventories([left], [right]);
    const pseudo = diff.paired[0]!.unknown_reasons.find(
      ({ dimension }) => dimension === "pseudocode",
    );
    expect(pseudo?.reasons).toEqual(["provider_mismatch", "facet_undeclared"]);
  });

  it("reports call_coverage_incomplete when call coverage is partial", () => {
    const left = snapshot(
      dossier({ address: "0x1000", name: "main" }),
      "f3",
      "fixture",
      true,
    );
    const right = snapshot(dossier({ address: "0x1000", name: "main" }), "f4");
    const diff = diffFunctionInventories([left], [right]);
    expect(
      diff.paired[0]!.unknown_reasons.find(
        ({ dimension }) => dimension === "calls",
      )?.reasons,
    ).toEqual(["call_coverage_incomplete"]);
  });

  it("reports normalization_failed for an un-normalizable string offset", () => {
    const left = snapshot(
      dossier({
        address: "0x1000",
        name: "main",
        strings: ["hello"],
      }),
      "f5",
    );
    // A string whose source address precedes the function cannot be normalised.
    const degraded = JSON.parse(JSON.stringify(left)) as {
      dossier: { referenced_strings: { source_address: string }[] };
    };
    degraded.dossier.referenced_strings[0]!.source_address = "0x1";
    const rebuilt = snapshot(
      degraded.dossier as unknown as ReturnType<typeof dossier>,
      "f6",
    );
    const right = snapshot(
      dossier({ address: "0x1000", name: "main", strings: ["hello"] }),
      "f7",
    );
    const diff = diffFunctionInventories([rebuilt], [right]);
    expect(
      diff.paired[0]!.unknown_reasons.find(
        ({ dimension }) => dimension === "strings_names",
      )?.reasons,
    ).toContain("normalization_failed");
  });

  it("reports identity_unstable when the compared symbols are generated", async () => {
    const { compareFunctions } = await import("./functionComparison.js");
    const first = snapshot(
      dossier({ address: "0x1000", name: "FUN_1000", source: "default" }),
      "f8",
    );
    const second = snapshot(
      dossier({ address: "0x1000", name: "FUN_1000", source: "default" }),
      "f9",
    );
    const comparison = compareFunctions(first, second);
    const identity = comparison.dimensions.find(
      ({ dimension }) => dimension === "identity",
    );
    if (identity?.status !== "unknown")
      throw new Error("expected unknown identity");
    expect(identity.unknown_reasons).toEqual(["identity_unstable"]);
  });

  it("keeps an observed identity reason when call coverage is also partial", () => {
    const observed = (seed: string, partial: boolean) =>
      snapshot(
        dossier({
          address: "0x1000",
          name: "main",
          callees: ["puts"],
          generatedCallees: ["FUN_9001"],
        }),
        seed,
        "fixture",
        partial,
      );
    const diff = diffFunctionInventories(
      [observed("1a", true)],
      [observed("1b", false)],
    );
    const calls = diff.paired[0]!.unknown_reasons.find(
      ({ dimension }) => dimension === "calls",
    );
    // Incomplete coverage is one finding. A callee whose identity the provider
    // never established is another. Reporting only the first would erase a
    // reason that was actually observed, which is what this test pins down.
    expect(calls?.reasons).toEqual([
      "identity_unstable",
      "call_coverage_incomplete",
    ]);
  });

  it("names the metadata facet when repeated rows carry mixed typed metadata", () => {
    const typed = {
      encoding: "utf-8",
      termination: "present_or_not_required" as const,
      byte_length: 5,
    };
    const side = (seed: string, bothTyped: boolean) =>
      snapshot(
        dossier({
          address: "0x1000",
          name: "main",
          stringRows: [
            { source: "0x1004", value: "hello", typed },
            {
              source: "0x1004",
              value: "hello",
              ...(bothTyped ? { typed } : {}),
            },
          ],
        }),
        seed,
      );
    const diff = diffFunctionInventories(
      [side("2a", true)],
      [side("2b", false)],
    );
    const strings = diff.paired[0]!.unknown_reasons.find(
      ({ dimension }) => dimension === "strings_names",
    );
    // The cause is a missing typed-metadata facet that both rows were observed
    // to carry. Before this fix it surfaced as `unspecified` while the prose
    // limitation already stated the exact reason.
    expect(strings?.reasons).toEqual(["facet_unavailable"]);
  });
});
