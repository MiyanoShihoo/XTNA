import type { EvidenceMcpServer } from "./EvidenceMcpServer.js";

import type { BinarySessionPort } from "../application/binary/BinarySessionPort.js";
import {
  diffFunctionInventoryDocuments,
  parseFunctionInventory,
} from "../application/functionInventoryDiff.js";
import { recordEvidenceSources } from "../application/investigation/recordEvidenceSources.js";
import { toolContract } from "../contracts/toolContracts.js";
import { createEvidence } from "../domain/evidence.js";
import type { FunctionSnapshot } from "../domain/functionDossierEvidence.js";
import { FUNCTION_INVENTORY_DIFF_PROVIDER } from "../domain/investigationProviders.js";
import type { VersionFunctionDiff } from "../domain/versionFunctionDiff.js";
import { runAdmittedToolOperation } from "./admittedToolOperation.js";
import { withAdmittedAnalysis } from "./analysisAdmission.js";
import { runDerivedOperation } from "./runDerivedOperation.js";
import { toolRegistrationOptions } from "./toolRegistrationOptions.js";

/**
 * Retain each source observation once. Two sides routinely carry the same
 * record, and recording it twice would fail on its own identity.
 */
const uniqueSources = (
  left: readonly FunctionSnapshot[],
  right: readonly FunctionSnapshot[],
): readonly FunctionSnapshot[] => [
  ...new Map(
    [...left, ...right].map((snapshot) => [
      snapshot.evidence.evidence_id,
      snapshot,
    ]),
  ).values(),
];

/**
 * Lift the per-pair limits to the record. Nothing is invented here: every
 * limitation was already reported against the pair that produced it.
 */
const diffLimitations = (diff: VersionFunctionDiff): readonly string[] => {
  const limitations = new Set<string>();
  for (const pair of diff.paired)
    for (const limitation of pair.limitations) limitations.add(limitation);
  if (diff.unpaired.length > 0)
    limitations.add(
      "Unpaired entries were reported instead of matched; they carry no comparison and no change claim.",
    );
  return [...limitations];
};

/** Register inline-only version-level function inventory comparison. */
export const registerFunctionInventoryDiffTool = (
  server: EvidenceMcpServer,
  session: BinarySessionPort,
  contract: ReturnType<typeof toolContract<"diff_functions">>,
): void => {
  const admission = withAdmittedAnalysis({ kind: "session", session });
  server.registerTool(
    contract.name,
    toolRegistrationOptions(contract),
    async (input, context) =>
      runAdmittedToolOperation(
        server,
        admission,
        contract.name,
        context.mcpReq.signal,
        async () => {
          // Parse each side first so the observations that were actually
          // compared can be retained and linked to this record.
          const parsedLeft = parseFunctionInventory(input.left);
          if (!parsedLeft.ok)
            return server.delivery.toCallToolResult(parsedLeft, contract);
          const parsedRight = parseFunctionInventory(input.right);
          if (!parsedRight.ok)
            return server.delivery.toCallToolResult(parsedRight, contract);
          const computed = await runDerivedOperation(
            context,
            contract.name,
            () => {
              const diff = diffFunctionInventoryDocuments(
                input.left,
                input.right,
              );
              if (!diff.ok) throw diff.error;
              return diff.value;
            },
          );
          if (!computed.ok)
            return server.delivery.toCallToolResult(computed, contract);
          const diff = computed.value;
          const sourceRecords = uniqueSources(
            parsedLeft.value,
            parsedRight.value,
          );
          const recordedSources = recordEvidenceSources(
            (evidence) => session.recordEvidence(evidence),
            sourceRecords.map(({ evidence }) => evidence),
          );
          if (!recordedSources.ok)
            return server.delivery.toCallToolResult(recordedSources, contract);
          const evidence = createEvidence(
            undefined,
            FUNCTION_INVENTORY_DIFF_PROVIDER,
            {
              predicateType: "XTNA.function-inventory-diff",
              operation: contract.name,
              parameters: {
                left_observations: parsedLeft.value.length,
                right_observations: parsedRight.value.length,
              },
              result: diff,
              confidence: "derived",
              authority: "analyst-inference",
              limitations: diffLimitations(diff),
              evidenceLinks: sourceRecords.map(
                ({ evidence: source }) => source.evidence_id,
              ),
            },
          );
          const recorded = session.recordEvidence(evidence);
          return server.delivery.toEvidenceToolResult(
            evidence,
            contract,
            recorded,
          );
        },
      ),
  );
};
