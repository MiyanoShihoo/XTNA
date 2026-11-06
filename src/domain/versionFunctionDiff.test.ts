import { describe, expect, it } from "vitest";

import { createEvidence, type Evidence } from "./evidence.js";
import { createAnalysisProfile } from "./analysisProfile.js";
import { createFunctionCoordinateContext } from "./native/functionCoordinateContext.js";
import { enhancedInputSchemas } from "../contracts/enhancedInputs.js";
import { functionDossierSchema } from "./native/functionDossier.js";
import { functionSnapshotFixture } from "./functionDossierEvidence.fixture.js";
import { diffFunctionInventories } from "./versionFunctionDiff.js";
import type { FunctionSnapshot } from "./functionDossierEvidence.js";

const provider = { id: "fixture", name: "fixture", version: "1" } as const;

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
    pseudocode: input.pseudocode ?? "return 0;",
    assembly: ["ret"],
    comments: [],
    callers: [],
    callees: [],
    incoming_references: [],
    outgoing_references: [],
    referenced_strings: [],
    referenced_names: [],
    native_api: null,
    native_value_flow: null,
    facet_availability: {
      pseudocode: { available: true },
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
): FunctionSnapshot => {
  const evidence: Evidence = createEvidence(
    {
      path: `/fixture/${seed}`,
      sha256: seed.repeat(64).slice(0, 64),
      format: "mach-o",
      architecture: "arm64",
    },
    provider,
    {
      operation: "analyze_function",
      analysisProfile: createAnalysisProfile(provider, {
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
      relationshipCoverage: { status: "complete" },
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

  it("pairs the unique stable candidate despite an unstable namesake", () => {
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
    expect(diff.paired.map(({ key }) => key)).toEqual(["init"]);
    expect(diff.unpaired).toEqual([]);
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
