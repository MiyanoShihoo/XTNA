import { describe, expect, expectTypeOf, it, onTestFinished } from "vitest";
import { z } from "zod";

import { diffFunctionInventoryDocuments } from "../../../src/application/functionInventoryDiff.js";
import { FUNCTION_COMPARISON_EXAMPLE } from "../../../src/contracts/functionComparisonExample.js";
import { createEvidence, parseEvidence } from "../../../src/domain/evidence.js";
import type { VersionFunctionDiff } from "../../../src/domain/versionFunctionDiff.js";
import {
  functionInventoryDiffInputSchema,
  MAX_FUNCTION_INVENTORY_RECORDS,
  versionFunctionDiffSchema,
} from "../../../src/domain/versionFunctionDiffSchema.js";
import { createApplicationMcpHarness } from "../../fixtures/applicationMcpHarness.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";

const TOOL = "diff_functions";

/** A session whose provider launch is a failure, so a launch cannot pass silently. */
const noProviderSession = (onLaunch: () => void) =>
  createTestBinarySession(() => {
    onLaunch();
    throw new Error("diff_functions must not launch a provider");
  });

const side = () => [FUNCTION_COMPARISON_EXAMPLE.left];
const otherSide = () => [FUNCTION_COMPARISON_EXAMPLE.right];

describe("diff_functions as a public MCP tool", () => {
  it("is advertised through the production registration", async () => {
    const harness = await createApplicationMcpHarness({
      session: noProviderSession(() => undefined),
    });
    onTestFinished(harness.close);
    const listed = await harness.client.listTools();
    const tool = listed.tools.find(({ name }) => name === TOOL);
    expect(tool, "diff_functions was not advertised").toBeDefined();
    // A read-only analysis tool must not advertise destructive or write hints.
    expect(tool?.annotations?.readOnlyHint).toBe(false);
    expect(tool?.inputSchema?.required).toEqual(["left", "right"]);
  });

  it("returns exactly the comparison the CLI entry point computes", async () => {
    let launches = 0;
    const harness = await createApplicationMcpHarness({
      session: noProviderSession(() => {
        launches += 1;
      }),
    });
    onTestFinished(harness.close);
    const response = await harness.client.callTool({
      name: TOOL,
      arguments: { left: side(), right: otherSide() },
    });
    expect(response.isError, JSON.stringify(response.content)).not.toBe(true);
    expect(launches).toBe(0);

    const delivered = parseEvidence(response.structuredContent);
    const expected = diffFunctionInventoryDocuments(side(), otherSide());
    if (!expected.ok) throw expected.error;
    expect(delivered.normalized_result).toEqual(expected.value);
    expect(
      versionFunctionDiffSchema.parse(delivered.normalized_result),
    ).toEqual(delivered.normalized_result);
  });

  it("keeps unknown_dimensions and unknown_reasons in step", async () => {
    const foreign = createEvidence(
      {
        path: "/tmp/function-foreign-provider",
        sha256: "3".repeat(64),
        format: "mach-o",
      },
      { id: "another-provider", name: "Another provider", version: "1" },
      {
        operation: FUNCTION_COMPARISON_EXAMPLE.left.operation,
        parameters: FUNCTION_COMPARISON_EXAMPLE.left.parameters,
        result: FUNCTION_COMPARISON_EXAMPLE.left.normalized_result,
        confidence: FUNCTION_COMPARISON_EXAMPLE.left.confidence,
        authority: FUNCTION_COMPARISON_EXAMPLE.left.authority,
        relationshipCoverage: { status: "complete" },
      },
    );
    const harness = await createApplicationMcpHarness({
      session: noProviderSession(() => undefined),
    });
    onTestFinished(harness.close);
    const response = await harness.client.callTool({
      name: TOOL,
      arguments: { left: side(), right: [foreign] },
    });
    expect(response.isError, JSON.stringify(response.content)).not.toBe(true);

    const diff = versionFunctionDiffSchema.parse(
      parseEvidence(response.structuredContent).normalized_result,
    );
    expect(diff.paired).toHaveLength(1);
    const pair = diff.paired[0]!;
    // Provider mismatch is the reason the text dimensions cannot be judged.
    expect(pair.unknown_dimensions.length).toBeGreaterThan(0);
    expect(
      pair.unknown_reasons.map(({ dimension }) => dimension).sort(),
    ).toEqual([...pair.unknown_dimensions].sort());
    expect(pair.dimension_counts.unknown).toBe(pair.unknown_dimensions.length);
    for (const entry of pair.unknown_reasons)
      expect(entry.reasons.length).toBeGreaterThan(0);
    // A changed dimension and an unknown dimension coexist without erasing
    // each other, and neither is counted as unchanged.
    expect(
      pair.changed_dimensions.length + pair.unknown_dimensions.length,
    ).toBe(pair.dimension_counts.changed + pair.dimension_counts.unknown);
  });

  it("rejects a document that declares two inventories", async () => {
    const harness = await createApplicationMcpHarness({
      session: noProviderSession(() => undefined),
    });
    onTestFinished(harness.close);
    const response = await harness.client.callTool({
      name: TOOL,
      arguments: {
        left: { functions: side(), items: side() },
        right: otherSide(),
      },
    });
    const failure = parseMcpToolError(response);
    expect(JSON.stringify(failure)).toContain("exactly one is required");
  });

  it("refuses an inventory above the declaration limit", async () => {
    const harness = await createApplicationMcpHarness({
      session: noProviderSession(() => undefined),
    });
    onTestFinished(harness.close);
    // The same authenticated record repeated: the limit is about count, and an
    // oversized document must be refused before it reaches the diff.
    const oversized = Array.from(
      { length: MAX_FUNCTION_INVENTORY_RECORDS + 1 },
      () => FUNCTION_COMPARISON_EXAMPLE.left,
    );
    const atLimit = oversized.slice(0, MAX_FUNCTION_INVENTORY_RECORDS);
    expect(
      functionInventoryDiffInputSchema.safeParse({ left: oversized, right: [] })
        .success,
    ).toBe(false);
    expect(
      functionInventoryDiffInputSchema.safeParse({ left: atLimit, right: [] })
        .success,
    ).toBe(true);
    const response = await harness.client.callTool({
      name: TOOL,
      arguments: { left: oversized, right: [] },
    });
    expect(response.isError).toBe(true);
  }, 60_000);

  it("accepts no filesystem path in place of records", async () => {
    const harness = await createApplicationMcpHarness({
      session: noProviderSession(() => undefined),
    });
    onTestFinished(harness.close);
    const response = await harness.client.callTool({
      name: TOOL,
      arguments: { left: "E:\\secrets\\inventory.json", right: [] },
    });
    expect(response.isError).toBe(true);
  });

  it("publishes the diff as derived Evidence with both sources linked", async () => {
    const harness = await createApplicationMcpHarness({
      session: noProviderSession(() => undefined),
    });
    onTestFinished(harness.close);
    const response = await harness.client.callTool({
      name: TOOL,
      arguments: { left: side(), right: otherSide() },
    });
    const evidence = parseEvidence(response.structuredContent);
    expect(evidence).toMatchObject({
      predicate_type: "XTNA.function-inventory-diff",
      operation: TOOL,
      confidence: "derived",
      authority: "analyst-inference",
      subject: null,
      provider: { id: "rea-function-inventory-diff" },
    });
    const linked = new Set(evidence.evidence_links);
    expect(linked).toContain(FUNCTION_COMPARISON_EXAMPLE.left.evidence_id);
    expect(linked).toContain(FUNCTION_COMPARISON_EXAMPLE.right.evidence_id);
  });
});

describe("diff_functions wire schema", () => {
  it("stays aligned with the domain record", () => {
    expectTypeOf<
      keyof z.infer<typeof versionFunctionDiffSchema>
    >().toEqualTypeOf<keyof VersionFunctionDiff>();
    expectTypeOf<
      z.infer<typeof versionFunctionDiffSchema>
    >().toExtend<VersionFunctionDiff>();
  });

  it("refuses an undeclared field at any depth", () => {
    // The type assertions above cannot see a nested optional field. Strict
    // objects make them visible: this is what turns the round-trip assertion
    // in the comparison test into a real drift guard.
    const withUndeclaredPairField = {
      paired: [
        {
          key: "main",
          status: "unchanged",
          paired_by: "stable_symbol",
          changed_dimensions: [],
          unknown_dimensions: [],
          unknown_reasons: [],
          dimension_counts: { unchanged: 8, changed: 0, unknown: 0 },
          left_evidence_id: `ev_${"0".repeat(64)}`,
          right_evidence_id: `ev_${"1".repeat(64)}`,
          limitations: [],
          undeclared: true,
        },
      ],
      only_before: [],
      only_after: [],
      unpaired: [],
      summary: {
        unchanged: 1,
        changed: 0,
        unknown: 0,
        only_before: 0,
        only_after: 0,
        unpaired: 0,
      },
    };
    expect(
      versionFunctionDiffSchema.safeParse(withUndeclaredPairField).success,
    ).toBe(false);
    const { undeclared: _undeclared, ...declaredPair } =
      withUndeclaredPairField.paired[0]!;
    expect(
      versionFunctionDiffSchema.safeParse({
        ...withUndeclaredPairField,
        paired: [declaredPair],
      }).success,
    ).toBe(true);
  });
});
