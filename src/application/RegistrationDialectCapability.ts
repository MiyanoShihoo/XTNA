import type {
  ClientConfigurationDocument,
  ClientRegistrationDialect,
} from "./ClientConfigurationDocument.js";

/**
 * Contract §4 — the dialect capability gate.
 *
 * `MIGRATE` and `DELETE` of a historical member both require the dialect to remove that member
 * *acceptably*. This is the production implementation of the gate the resolver takes as a seam;
 * without it the §4 table existed only in the contract and in a test stub, so a TOML member could
 * still be offered for removal by any caller that passed a permissive predicate.
 *
 * Two capabilities live here because they answer the same question from different angles:
 * whether this document can express the state the contract wants (a duplicate), and whether this
 * document can leave that state without silently losing something the user wrote.
 */

/** Dialects whose only removal path rewrites the whole document and drops every comment. */
const COMMENT_LOSING_DIALECTS: ReadonlySet<ClientRegistrationDialect> = new Set(
  ["toml", "grok"],
);

/**
 * §4: may this document have its historical member removed or migrated?
 *
 * TOML serializes through `stringifyToml`, which drops every comment in the file. The contract
 * forbids paying for a rename with a user's comments, so the answer is `false` for both
 * `MIGRATE` and `DELETE` — the caller must `BLOCK` and state the loss.
 *
 * A YAML document that reaches this point parsed with every alias resolved: `HermesConfigurationYaml`
 * refuses unresolved or cyclic aliases, so a parsed document has a removal path. The unparseable
 * case never becomes a document at all and is reported as `invalid` by the reader.
 */
export const dialectCanRemoveHistorical = (
  document: ClientConfigurationDocument,
): boolean => !COMMENT_LOSING_DIALECTS.has(document.dialect);

/**
 * §1 D: can this dialect express a *repeated* member at all, so a `duplicate` verdict is a fact
 * rather than a guess?
 *
 * - TOML cannot repeat a table, and Hermes YAML shadows without a detector the shared helper
 *   exposes, so the contract refuses to claim a duplicate there.
 * - The Harness projects one Cordis entry per document, so repetition is not expressible.
 * - JSON-family and OpenCode tables can hold both keys; the verdict is then observable.
 */
const NO_REPEAT_DETECTION: ReadonlySet<ClientRegistrationDialect> = new Set([
  "toml",
  "grok",
  "hermes",
  "dsh",
]);

export const dialectCanDetectDuplicate = (
  document: ClientConfigurationDocument,
): boolean => !NO_REPEAT_DETECTION.has(document.dialect);
