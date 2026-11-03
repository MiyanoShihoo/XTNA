import { parseClientRegistration } from "./ClientRegistration.js";
import { classifyClientRegistrationCommand } from "./ClientRegistrationIdentity.js";
import type { SetupClient } from "./SupportedClients.js";
import type { ClientConfigurationSource } from "./ClientConfigurationFiles.js";
import {
  dialectCanDetectDuplicate,
  dialectCanRemoveHistorical,
} from "./RegistrationDialectCapability.js";
import type {
  ProductRegistrationContext,
  ProductRegistrationSource,
  RegistrationOwnership,
} from "./ProductRegistrationResolution.js";

/**
 * The bridge between the configuration stack the reader already assembles and the resolution
 * record §6 describes.
 *
 * `readClientConfigurationFiles` returns the stack a client actually loads, newest last. The
 * resolver needs the same documents annotated with what this command may do to each one, and it
 * needs the dialect capabilities from §4 / §1 D. Both are derived here, once, so no caller
 * invents its own tier rule — which is how `sources[0]` ended up judging a TOML member's dialect.
 */

/**
 * `targetPath` is the file this command writes (`client.configPath`). Everything else in the
 * stack is a lower layer: readable, never removable. A path in `readOnlyPaths` is reported as
 * `read-only-source` because it is a settings file the product does not own at all.
 */
export const toRegistrationSources = (
  sources: readonly ClientConfigurationSource[],
  {
    targetPath,
    readOnlyPaths = [],
  }: {
    readonly targetPath: string | undefined;
    readonly readOnlyPaths?: readonly string[];
  },
): ProductRegistrationSource[] => {
  const readOnly = new Set(readOnlyPaths);
  return sources.map((source) => {
    const isTarget =
      targetPath !== undefined && source.sourcePath === targetPath;
    const tier = readOnly.has(source.sourcePath)
      ? "read-only-source"
      : isTarget
        ? "document"
        : "lower-layer";
    return {
      document: source,
      tier,
      writable: tier === "document",
      sourcePath: source.sourcePath,
    };
  });
};

/**
 * The dialect capabilities the resolver asks for, bound to the real §4 / §1 D implementation.
 * A caller that needs a different answer for one document can still pass its own context; this
 * is only the default that keeps every production caller honest.
 */
export const registrationContext = (
  classifyOwnership: (value: unknown, key: string) => RegistrationOwnership,
): ProductRegistrationContext => ({
  classifyOwnership,
  duplicateDetectable: dialectCanDetectDuplicate,
  dialectCanRemove: dialectCanRemoveHistorical,
});

/**
 * The production ownership classifier: the same command identity the status reader already uses,
 * so a member cannot be `owned` here and `foreign` in `doctor`.
 *
 * A registration the client's own schema cannot parse stays `unknown`, never `owned`: an
 * unreadable value must not become permission to write.
 */
export const commandOwnershipClassifier =
  (
    client: Pick<SetupClient, "name" | "format">,
    currentCommandPath: string | undefined,
  ) =>
  (value: unknown): RegistrationOwnership => {
    const parsed = parseClientRegistration(value, client as SetupClient);
    if (!parsed.ok) return "unknown";
    return classifyClientRegistrationCommand(
      [parsed.value.command, ...parsed.value.args],
      currentCommandPath,
    );
  };
