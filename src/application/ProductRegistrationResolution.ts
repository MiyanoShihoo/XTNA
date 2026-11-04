import { dshDocument } from "./DshCordisPatch.js";
import { LEGACY_MCP_SERVER_KEY, PRODUCT_IDENTITY } from "../identity.js";
import type { ClientConfigurationDocument } from "./ClientConfigurationDocument.js";

/**
 * Contract: `docs/agent-orchestrator/P1-IDENTITY-CONTRACT.md` revision 5, batch 1, after the
 * first independent review round. The review changed the implementation only; the contract text
 * did not move, so this file cites revision 5 (§6 addendum records the one shape deviation).
 *
 * Answers *what exists and who owns it*. It performs no write, removes nothing and clears no
 * policy entry; every action stays with a later batch. Ownership is supplied by the caller so
 * a name can never grant permission on its own.
 */

export type RegistrationIdentity = "current" | "legacy";
export type RegistrationTier = "document" | "lower-layer" | "read-only-source";
export type RegistrationOwnership = "owned" | "foreign" | "unknown";
/** Batch 1 does not evaluate policy; the field exists so the record is not widened later. */
export type RegistrationPolicy =
  | "enabled"
  | "disabled"
  | "excluded"
  | "not_allowlisted"
  | "unknown";

export type RegistrationConflictKind =
  | "duplicate"
  | "legacy_identity"
  | "lower_layer"
  | "foreign_current"
  | "foreign_historical"
  | "unknown_ownership"
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
  readonly sourcePath?: string;
}

export interface ProductRegistrationMember {
  readonly key: string;
  readonly identity: RegistrationIdentity;
  readonly tier: RegistrationTier;
  readonly writable: boolean;
  readonly value: unknown;
  readonly ownership: RegistrationOwnership;
  readonly policy: RegistrationPolicy;
  readonly sourcePath?: string;
}

/**
 * A member the contract permits a command to write or delete: owned, document tier, writable.
 * The brand makes a foreign member a type error in any later delete or migrate signature.
 */
export interface OwnedWritableMember extends ProductRegistrationMember {
  readonly ownership: "owned";
  readonly writable: true;
  readonly tier: "document";
}

export interface ProductRegistrationContext {
  /** Classification is injected so a name alone never grants permission. */
  readonly classifyOwnership: (
    value: unknown,
    key: string,
  ) => RegistrationOwnership;
  /** Whether this dialect can express a shadowed/duplicate member at all (§1 D). */
  readonly duplicateDetectable: (
    document: ClientConfigurationDocument,
  ) => boolean;
  /**
   * Contract §4. `false` means this dialect cannot remove the historical member acceptably,
   * so the resolver must not offer it as a retire candidate.
   */
  readonly dialectCanRemove: (document: ClientConfigurationDocument) => boolean;
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
  readonly target?: OwnedWritableMember;
  readonly retire: readonly OwnedWritableMember[];
  readonly conflicts: readonly RegistrationConflict[];
  readonly policyEdits: readonly ProductRegistrationPolicyEdit[];
}

const isOwnedWritableDocumentMember = (
  member: ProductRegistrationMember,
): member is OwnedWritableMember =>
  member.ownership === "owned" && member.writable && member.tier === "document";

/**
 * Identity is a dialect fact, not a string comparison (§1 D):
 * - the Harness stores its registration under the Cordis patch entry id and projects it to the
 *   historical key, so that member *is* the current registration;
 * - every other dialect spells identity in the key.
 *
 * Exported so `doctor` answers the same question with the same rule instead of asking whether a
 * key string looks familiar. Two derivations of one fact is how the health verdict and the write
 * path came to disagree.
 */
export const identityFor = (
  document: ClientConfigurationDocument,
  key: string,
): RegistrationIdentity => {
  if (document.dialect === "dsh") return "current";
  return key === PRODUCT_IDENTITY.mcpServerKey ? "current" : "legacy";
};

const keysInOrder = (): readonly string[] => [
  PRODUCT_IDENTITY.mcpServerKey,
  LEGACY_MCP_SERVER_KEY,
];

/**
 * Native server table plus the OpenCode V1 table. A V1 entry that repeats a key already present
 * natively is the same registration in two storage tiers, not a second member.
 */
const entriesOf = (
  document: ClientConfigurationDocument,
  key: string,
): readonly { readonly value: unknown }[] => {
  const found: { value: unknown }[] = [];
  if (Object.hasOwn(document.servers, key))
    found.push({ value: document.servers[key] });
  if (!found.length && Object.hasOwn(document.legacyServers, key))
    found.push({ value: document.legacyServers[key] });
  return found;
};

const rank = (member: ProductRegistrationMember): number => {
  const tierRank =
    member.tier === "document" ? 0 : member.tier === "lower-layer" ? 1 : 2;
  const identityRank = member.identity === "current" ? 0 : 1;
  return tierRank * 2 + identityRank;
};

const buildConflicts = (
  members: readonly ProductRegistrationMember[],
  duplicate: boolean,
  primary: ProductRegistrationMember | undefined,
): RegistrationConflict[] => {
  const conflicts: RegistrationConflict[] = [];
  const distinctKeys = new Set(members.map((member) => member.key));
  if (duplicate) {
    const productKeys = [
      PRODUCT_IDENTITY.mcpServerKey,
      LEGACY_MCP_SERVER_KEY,
    ].filter((key) => distinctKeys.has(key));
    // A Harness duplicate names its entry id, not a server key.
    conflicts.push({
      kind: "duplicate",
      keys: productKeys.length > 0 ? productKeys : [...distinctKeys],
    });
  }
  if (primary?.identity === "legacy")
    conflicts.push({ kind: "legacy_identity", keys: [primary.key] });
  // Row 9: a member outside the document tier is reported as `lower_layer`. The tier it was
  // found in is on the member. `policy_in_read_only_tier` belongs to row 3b — a *policy list*
  // read from a read-only tier — so a member must never borrow that kind (review M1).
  for (const tier of ["lower-layer", "read-only-source"] as const) {
    const inTier = members.filter((member) => member.tier === tier);
    if (inTier.length > 0)
      conflicts.push({
        kind: "lower_layer",
        keys: inTier.map((member) => member.key),
      });
  }
  for (const member of members) {
    if (member.ownership === "unknown")
      conflicts.push({ kind: "unknown_ownership", keys: [member.key] });
    else if (member.ownership === "foreign")
      conflicts.push({
        kind:
          member.identity === "current"
            ? "foreign_current"
            : "foreign_historical",
        keys: [member.key],
      });
  }
  return conflicts;
};

interface RegistrationRecord {
  readonly member: ProductRegistrationMember;
  readonly source: ProductRegistrationSource;
}

/**
 * §1 D: the Harness member's identity is its Cordis entry id, not the projected server name.
 * The projection stores the registration as `servers.rea`, so reading the key back would report
 * a current registration as historical and lose the entry id entirely.
 */
const memberKey = (
  document: ClientConfigurationDocument,
  key: string,
): string =>
  document.dialect === "dsh" ? dshDocument(document.document).entryId : key;

/**
 * Each member keeps the source it came from. Re-deriving the source from an optional
 * `sourcePath` let a document without one fall back to `sources[0]`, so the §4 dialect gate
 * judged the wrong dialect and offered a TOML member for removal (review H1).
 */
const collectRecords = (
  sources: readonly ProductRegistrationSource[],
  context: ProductRegistrationContext,
): RegistrationRecord[] => {
  const records: RegistrationRecord[] = [];
  for (const source of sources)
    for (const key of keysInOrder())
      for (const entry of entriesOf(source.document, key))
        records.push({
          member: {
            key: memberKey(source.document, key),
            identity: identityFor(source.document, key),
            tier: source.tier,
            writable: source.writable,
            // A caller that mutates a member must not reach the document a later write path
            // reads (review M4).
            value: structuredClone(entry.value),
            // A name is evidence of nothing; the classifier decides, and may say unknown.
            ownership: context.classifyOwnership(entry.value, key),
            policy: "unknown",
            ...(source.sourcePath === undefined
              ? {}
              : { sourcePath: source.sourcePath }),
          },
          source,
        });
  records.sort((left, right) => rank(left.member) - rank(right.member));
  return records;
};

/**
 * §5 conjunct 1 asks for *effective* registrations, not source records.
 *
 * A higher tier shadows a lower one that carries the same key: the client loads one member and the
 * other is evidence of where it used to come from. Two *different* keys are two registrations and
 * both take effect. Counting source records instead made a legitimate override look like a
 * conflict.
 */
export const effectiveMembers = (
  registration: ProductRegistration,
): readonly ProductRegistrationMember[] => {
  const documentKeys = new Set(
    registration.members
      .filter((member) => member.tier === "document")
      .map((member) => member.key),
  );
  return registration.members.filter(
    (member) => member.tier === "document" || !documentKeys.has(member.key),
  );
};
export const resolveProductRegistration = (
  sources: readonly ProductRegistrationSource[],
  context: ProductRegistrationContext,
): ProductRegistration => {
  const records = collectRecords(sources, context);
  const members = records.map((record) => record.member);

  const documents = members.filter((member) => member.tier === "document");
  const distinctKeys = new Set(members.map((member) => member.key));
  const tiers = new Set(members.map((member) => member.tier));
  // Only an explicit path proves two members share one document. Counting an absent path as a
  // single document made the verdict depend on optional reporting metadata (review H4).
  const perDocument = new Map<string, number>();
  for (const record of records) {
    const id = record.source.sourcePath;
    if (record.member.tier !== "document" || id === undefined) continue;
    perDocument.set(id, (perDocument.get(id) ?? 0) + 1);
  }
  const detectable = sources.some(
    (source) =>
      source.tier === "document" &&
      context.duplicateDetectable(source.document),
  );
  // §1 D: the Harness expresses exactly one duplicate form — a patch list that repeats its own
  // entry id. The projection stores a single member, so no key comparison can see it.
  const dshRepeats = sources.some(
    (source) =>
      source.document.dialect === "dsh" &&
      dshDocument(source.document.document).entryCount > 1,
  );
  // Two different keys are a duplicate: across tiers (row 13) or repeated inside one document.
  // A cross-tier pair is two files, so the dialect's ability to express a *repeated* entry says
  // nothing about it and must not suppress the verdict (review C1).
  const duplicate =
    dshRepeats ||
    (distinctKeys.size > 1 &&
      (tiers.size > 1 ||
        (detectable && [...perDocument.values()].some((count) => count > 1))));

  const primary =
    documents.find((member) => member.identity === "current") ??
    documents[0] ??
    members.find((member) => member.identity === "current") ??
    members[0];

  // The member's own source, not a lookup by optional path. `target` is gated by the same §4
  // rule as `retire`: offering a write target in a dialect that cannot remove or migrate
  // acceptably is the TOML false green the review blocked on.
  const documentOf = (member: ProductRegistrationMember) =>
    records.find((record) => record.member === member)?.source.document;

  const actionable = (
    member: ProductRegistrationMember,
  ): member is OwnedWritableMember => {
    if (!isOwnedWritableDocumentMember(member)) return false;
    const document = documentOf(member);
    return document !== undefined && context.dialectCanRemove(document);
  };

  const target =
    primary !== undefined && actionable(primary) ? primary : undefined;

  const retire = members.filter(
    (member): member is OwnedWritableMember =>
      member.identity === "legacy" && actionable(member),
  );

  const conflicts = buildConflicts(members, duplicate, primary);

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
