import { PRODUCT_IDENTITY } from "../identity.js";
import type {
  OwnedWritableMember,
  ProductRegistration,
  ProductRegistrationMember,
  ProductRegistrationPolicyEdit,
} from "./ProductRegistrationResolution.js";

/**
 * Contract §3 — the action phase for batch 3.
 *
 * The resolver answers *what exists and who owns it*; this module answers *what this command may
 * do about it*, and nothing else. It is a pure decision: it names a member, a plan and a blocker,
 * and it performs no write. That split is what lets every §3 row be tested as a table instead of
 * as an end-to-end file mutation.
 *
 * The dialect gate is not re-implemented here. The resolver already refuses to list a member it
 * cannot remove acceptably (`retire`) and refuses to name a write target in the same dialect
 * (`target`), so a TOML document arrives with both empty and lands on `BLOCK` by construction.
 */

export type RegistrationVerb = "setup" | "uninstall";

export type RegistrationAction =
  | "NOOP"
  | "MIGRATE"
  | "DELETE"
  | "RETAIN"
  | "BLOCK";

export interface RegistrationActionPlan {
  readonly action: RegistrationAction;
  /** Why this plan, in the words a remediation string can reuse. */
  readonly reason: string;
  /** The member the write updates, when one already exists. */
  readonly target?: OwnedWritableMember;
  /** The key the write creates during `MIGRATE`; absent for every other action. */
  readonly writeKey?: string;
  /** Members the verb removes. Empty for `BLOCK` and `RETAIN`. */
  readonly retire: readonly OwnedWritableMember[];
  /** List entries the plan is allowed to remove, declared before the write (§6). */
  readonly policyEdits: readonly ProductRegistrationPolicyEdit[];
}

/**
 * Row 6 has no document-tier current member to write into, so `target` cannot name one. The
 * dialect gate is read from the resolver's own `retire` list: a member it refused to list is a
 * member §4 will not let this command remove.
 */
const migrationBlocked = (): RegistrationActionPlan => ({
  action: "BLOCK",
  reason:
    "This configuration format cannot be migrated without losing content the user wrote; remove the historical entry manually.",
  retire: [],
  policyEdits: [],
});

const membersOf = (
  registration: ProductRegistration,
  identity: "current" | "legacy",
): readonly ProductRegistrationMember[] =>
  registration.members.filter((member) => member.identity === identity);

const only = (
  members: readonly ProductRegistrationMember[],
): ProductRegistrationMember | undefined =>
  members.length === 1 ? members[0] : undefined;

/** A member the plan may act on: owned, writable, in the document tier. */
const isActionable = (
  member: ProductRegistrationMember | undefined,
): member is OwnedWritableMember =>
  member !== undefined &&
  member.ownership === "owned" &&
  member.writable &&
  member.tier === "document";

const blocker = (reason: string): RegistrationActionPlan => ({
  action: "BLOCK",
  reason,
  retire: [],
  policyEdits: [],
});

const retain = (reason: string): RegistrationActionPlan => ({
  action: "RETAIN",
  reason,
  retire: [],
  policyEdits: [],
});

/**
 * §3 row 9 / 13: a member outside the document tier cannot be removed. When the current member is
 * in the document tier and the historical one is not, deleting the current member would expose
 * the fallback, so both are retained and the blocker names the file.
 */
const belowDocumentTier = (
  registration: ProductRegistration,
): ProductRegistrationMember | undefined =>
  registration.members.find((member) => member.tier !== "document");

const legacyOnlySetup = (
  historical: ProductRegistrationMember | undefined,
  registration: ProductRegistration,
): RegistrationActionPlan => {
  if (!isActionable(historical))
    return blocker(
      historical?.ownership === "unknown"
        ? "The historical registration's ownership cannot be established, so it is left untouched."
        : "The historical registration is not this product's to migrate, or is not writable.",
    );
  const removable = registration.retire.some(
    (member) => member.key === historical.key,
  );
  // A member the resolver refused to list is one §4 will not let this command remove.
  if (!removable) return migrationBlocked();
  return {
    action: "MIGRATE",
    reason: `Migrate the historical ${historical.key} registration to ${PRODUCT_IDENTITY.mcpServerKey}.`,
    writeKey: PRODUCT_IDENTITY.mcpServerKey,
    retire: registration.retire,
    policyEdits: [],
  };
};

const legacyOnlyUninstall = (
  historical: ProductRegistrationMember | undefined,
): RegistrationActionPlan => {
  if (!isActionable(historical))
    return retain(
      "The historical registration is not this product's to remove, or is not writable.",
    );
  return {
    action: "DELETE",
    reason: `Remove the historical ${historical.key} registration.`,
    retire: [historical],
    policyEdits: [],
  };
};

export const decideRegistrationAction = (
  registration: ProductRegistration,
  verb: RegistrationVerb,
): RegistrationActionPlan => {
  if (!registration.present)
    return {
      action: "NOOP",
      reason: "No registration exists.",
      retire: [],
      policyEdits: [],
    };

  const current = only(membersOf(registration, "current"));
  const historical = only(membersOf(registration, "legacy"));
  const lower = belowDocumentTier(registration);

  if (registration.conflicts.some(({ kind }) => kind === "unknown_ownership"))
    return blocker(
      "At least one discovered registration has unknown ownership; nothing is written until it is established.",
    );

  // Row 13 takes precedence over the duplicate rules: a current member in the document tier next
  // to a historical member below it. Removing the current one would surface the fallback.
  if (
    current !== undefined &&
    historical !== undefined &&
    lower !== undefined &&
    lower === historical
  )
    return blocker(
      `The historical registration lives in ${historical.sourcePath ?? "a lower-layer file"}, which this command cannot rewrite. Remove it by hand, then rerun.`,
    );

  if (!registration.duplicate) {
    if (current !== undefined)
      return verb === "setup"
        ? retain("The current registration is already in place.")
        : isActionable(current)
          ? {
              action: "DELETE",
              reason: `Remove the ${current.key} registration.`,
              retire: [current],
              policyEdits: [],
            }
          : retain("The current registration is not this product's to remove.");
    return verb === "setup"
      ? legacyOnlySetup(historical, registration)
      : legacyOnlyUninstall(historical);
  }

  // Rows 10–12b: both identities are present in the document tier.
  if (verb === "setup") {
    if (isActionable(current) && isActionable(historical)) {
      // Same gate as row 6: a historical member the resolver would not retire is one this dialect
      // cannot remove acceptably, so the pair is not migrated here.
      if (!registration.retire.some((member) => member.key === historical.key))
        return migrationBlocked();
      return {
        action: "MIGRATE",
        reason: `Both identities are present; keep ${current.key} and retire ${historical.key}.`,
        target: current,
        writeKey: current.key,
        retire: registration.retire,
        policyEdits: [],
      };
    }
    return blocker(
      "Both identities are present and at least one is not this product's to change.",
    );
  }

  // Uninstall, rows 10–12b.
  if (isActionable(current) && isActionable(historical))
    return {
      action: "DELETE",
      reason: "Both identities belong to this product; remove both.",
      retire: [current, historical],
      // The contract removes only the current key from a list: an entry naming the historical key
      // is left alone because no member bears that name afterwards (invariant 10).
      policyEdits: [{ list: "deny", key: current.key, outcome: "removed" }],
    };
  if (isActionable(current))
    return {
      action: "DELETE",
      reason: `Remove ${current.key} and keep the registration this product does not own.`,
      retire: [current],
      policyEdits: [{ list: "deny", key: current.key, outcome: "removed" }],
    };
  if (isActionable(historical))
    return {
      action: "DELETE",
      reason: `Remove the historical ${historical.key} registration and keep the one this product does not own.`,
      retire: [historical],
      policyEdits: [],
    };
  return retain("Neither registration is this product's to remove.");
};
