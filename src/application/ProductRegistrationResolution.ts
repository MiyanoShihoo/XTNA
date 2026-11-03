import { LEGACY_MCP_SERVER_KEY, PRODUCT_IDENTITY } from "../identity.js";
import type { ClientConfigurationDocument } from "./ClientConfigurationDocument.js";

/**
 * Contract: `docs/agent-orchestrator/P1-IDENTITY-CONTRACT.md`, batch 1.
 *
 * This module answers *what exists and who owns it*. It performs no write, removes
 * nothing, and clears no policy entry; those are later batches gated on this result.
 * Ownership is supplied by the caller so that classification cannot invent permission from
 * a name that merely looks like ours.
 */

export type RegistrationIdentity = "current" | "legacy";
export type RegistrationTier = "document" | "lower-layer" | "read-only-source";
export type RegistrationOwnership = "owned" | "foreign" | "unknown";

export type RegistrationConflictKind =
  | "duplicate"
  | "legacy_identity"
  | "lower_layer"
  | "foreign_current"
  | "foreign_historical"
  | "policy_in_read_only_tier"
  | "stale_policy_residue";

export interface RegistrationConflict {
  readonly kind: RegistrationConflictKind;
  readonly keys: readonly string[];
}

/** One configuration document plus what this command may do with the file behind it. */
export interface ProductRegistrationSource {
  readonly document: ClientConfigurationDocument;
  readonly tier: RegistrationTier;
  readonly writable: boolean;
  readonly path?: string;
}

export interface ProductRegistrationMember {
  readonly key: string;
  readonly identity: RegistrationIdentity;
  readonly tier: RegistrationTier;
  readonly writable: boolean;
  readonly value: unknown;
  readonly ownership: RegistrationOwnership;
  readonly sourcePath?: string;
}

/** Everything the action phase needs; nothing is imported implicitly. */
export interface ProductRegistrationContext {
  /** Classification is injected so a name alone can never grant permission. */
  readonly classifyOwnership: (
    value: unknown,
    key: string,
  ) => RegistrationOwnership;
  /** Whether this dialect can express a shadowed/duplicate member at all. */
  readonly duplicateDetectable: (
    document: ClientConfigurationDocument,
  ) => boolean;
}

export interface ProductRegistrationPolicyEdit {
  readonly list: string;
  readonly key: string;
  readonly outcome: "removed";
}

export interface ProductRegistration {
  readonly members: readonly ProductRegistrationMember[];
  readonly present: boolean;
  readonly duplicate: boolean;
  readonly primary?: ProductRegistrationMember;
  readonly target?: ProductRegistrationMember;
  readonly retire: readonly ProductRegistrationMember[];
  readonly conflicts: readonly RegistrationConflict[];
  readonly policyEdits: readonly ProductRegistrationPolicyEdit[];
}

const keysInOrder = (): readonly {
  readonly key: string;
  readonly identity: RegistrationIdentity;
}[] => [
  { key: PRODUCT_IDENTITY.mcpServerKey, identity: "current" },
  { key: LEGACY_MCP_SERVER_KEY, identity: "legacy" },
];

/** Native server table first, then the OpenCode V1 table, which is still the same tier. */
const entriesOf = (
  document: ClientConfigurationDocument,
  key: string,
): readonly unknown[] => {
  const found: unknown[] = [];
  if (Object.hasOwn(document.servers, key)) found.push(document.servers[key]);
  if (Object.hasOwn(document.legacyServers, key))
    found.push(document.legacyServers[key]);
  return found;
};

const rank = (member: ProductRegistrationMember): number => {
  const tierRank = member.tier === "document" ? 0 : 1;
  const identityRank = member.identity === "current" ? 0 : 1;
  return tierRank * 2 + identityRank;
};

export const resolveProductRegistration = (
  sources: readonly ProductRegistrationSource[],
  context: ProductRegistrationContext,
): ProductRegistration => {
  const members: ProductRegistrationMember[] = [];
  for (const source of sources)
    for (const { key, identity } of keysInOrder())
      for (const value of entriesOf(source.document, key))
        members.push({
          key,
          identity,
          tier: source.tier,
          writable: source.writable,
          value,
          // A name is evidence of nothing; the classifier decides, and may say unknown.
          ownership: context.classifyOwnership(value, key),
          ...(source.path === undefined ? {} : { sourcePath: source.path }),
        });

  members.sort((left, right) => rank(left) - rank(right));

  const documents = members.filter((member) => member.tier === "document");
  const detectable = sources.some(
    (source) =>
      source.tier === "document" &&
      context.duplicateDetectable(source.document),
  );
  const duplicate = documents.length > 1 && detectable;

  const primary =
    documents.find((member) => member.identity === "current") ??
    documents[0] ??
    members[0];

  const target =
    primary !== undefined &&
    primary.ownership === "owned" &&
    primary.writable &&
    primary.tier === "document"
      ? primary
      : undefined;

  const retire = members.filter(
    (member) =>
      member.identity === "legacy" &&
      member.ownership === "owned" &&
      member.writable &&
      member.tier === "document",
  );

  const conflicts: RegistrationConflict[] = [];
  if (duplicate)
    conflicts.push({
      kind: "duplicate",
      keys: documents.map((member) => member.key),
    });
  if (primary?.identity === "legacy")
    conflicts.push({ kind: "legacy_identity", keys: [primary.key] });
  const lower = members.filter((member) => member.tier !== "document");
  if (lower.length > 0)
    conflicts.push({
      kind: "lower_layer",
      keys: lower.map((member) => member.key),
    });
  for (const member of documents) {
    if (member.ownership === "owned") continue;
    if (member.ownership !== "foreign") continue;
    conflicts.push({
      kind:
        member.identity === "current"
          ? "foreign_current"
          : "foreign_historical",
      keys: [member.key],
    });
  }

  return {
    members,
    present: members.length > 0,
    duplicate,
    ...(primary === undefined ? {} : { primary }),
    ...(target === undefined ? {} : { target }),
    retire,
    conflicts,
    // Batch 1 removes nothing; policy edits arrive with the policy batch.
    policyEdits: [],
  };
};
