import type { ClientConfigurationDocument } from "./ClientConfigurationDocument.js";
import {
  readClientConfigurationFiles,
  type ClientConfigurationFileError,
  type ClientConfigurationSource,
} from "./ClientConfigurationFiles.js";
import {
  commandOwnershipClassifier,
  registrationContext,
  toRegistrationSources,
} from "./ProductRegistrationSources.js";
import {
  resolveProductRegistration,
  type ProductRegistration,
  type ProductRegistrationSource,
} from "./ProductRegistrationResolution.js";
import type { SetupClient } from "./SupportedClients.js";
import type { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";
import { err, ok, type Result } from "../domain/result.js";

/**
 * One verified view of what this product has registered with a client.
 *
 * Doctor, setup and uninstall each used to answer "what is registered here?" for themselves:
 * doctor read the effective document, setup read the file it was about to write, uninstall read
 * the file it was about to edit. Same question, three answers — and the answers disagreed
 * whenever a member lived in a lower layer, under the historical key, or in another tier.
 *
 * This snapshot is that answer, derived once from the configuration stack the reader already
 * assembles. It states facts (members, tiers, ownership, dialect) and grants nothing: a consumer
 * still has to decide what its verb may do, and every existing write guard stays in the path.
 */
export interface RegistrationSnapshot {
  /** Members across every tier, with ownership and writability already classified. */
  readonly registration: ProductRegistration;
  /** The same members with the source document each one came from. */
  readonly sources: readonly ProductRegistrationSource[];
  /** The document a write would target, when the stack has one. */
  readonly document: ClientConfigurationDocument | undefined;
  /** Every file the snapshot read, in the reader's order. */
  readonly sourcePaths: readonly string[];
}

export interface RegistrationSnapshotOptions {
  readonly resources?: ArtifactResourceScope;
  readonly platform?: NodeJS.Platform;
  /** The entry this build runs; ownership of a path launcher is decided against it. */
  readonly currentCommandPath?: string | undefined;
  /** Files the client reads but this product must never write (for example system settings). */
  readonly readOnlyPaths?: readonly string[];
}

const sourcesOf = (
  files: readonly ClientConfigurationSource[],
  client: SetupClient,
  options: RegistrationSnapshotOptions,
): RegistrationSnapshot => {
  const sources = toRegistrationSources(files, {
    targetPath: client.configPath,
    ...(options.readOnlyPaths === undefined
      ? {}
      : { readOnlyPaths: options.readOnlyPaths }),
  });
  const registration = resolveProductRegistration(
    sources,
    registrationContext(
      commandOwnershipClassifier(client, options.currentCommandPath),
    ),
  );
  return {
    registration,
    sources,
    // The document a write targets is the one the reader treats as the client's own config.
    document: files.find((file) => file.sourcePath === client.configPath),
    sourcePaths: files.map((file) => file.sourcePath),
  };
};

/**
 * Read the stack and resolve it. A configuration that cannot be read is an error, never an empty
 * snapshot: "nothing registered" and "could not tell" must not look the same to a writer.
 */
export const readRegistrationSnapshot = async (
  client: SetupClient,
  options: RegistrationSnapshotOptions = {},
): Promise<Result<RegistrationSnapshot, ClientConfigurationFileError>> => {
  const files = await readClientConfigurationFiles(
    client,
    options.resources,
    options.platform ?? process.platform,
  );
  if (!files.ok) return files;
  return ok(sourcesOf(files.value, client, options));
};
