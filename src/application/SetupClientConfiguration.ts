import { readClientPolicyBlock } from "./GeminiClientSettings.js";
import {
  readClientConfigurationFiles,
  clientConfigurationForWrite,
  clientWriteDialect,
  effectiveClientConfiguration,
  readConfigurationText,
  type ClientConfigurationSource,
  type ClientConfigurationFileError,
} from "./ClientConfigurationFiles.js";
import { err, ok, type Result } from "../domain/result.js";
import { ConfigurationError } from "../domain/configurationErrors.js";
import {
  clientConfigurationValuesEqual,
  effectiveClientServer,
  productServerName,
  clientServerListedDisabled,
  clientServerPath,
  legacyClientServerPath,
  shadowedClientServers,
  OMP_DISABLED_SERVERS_KEY,
  parseClientConfiguration,
  parseZcodeFallbackConfiguration,
  serializeClientConfiguration,
  withClientServers,
  type ClientConfigurationDocument,
} from "./ClientConfigurationDocument.js";
import { dshDocument, DshCordisDocument } from "./DshCordisPatch.js";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { RegularFileChangedError } from "../filesystem/RegularFile.js";
import { withClientConfigurationTransaction } from "./ClientConfigurationTransaction.js";
import { isClientConfigurationCleanupFailure } from "./ClientConfigurationCleanup.js";
import {
  ClientConfigurationPublication,
  ClientConfigurationWriteError,
} from "./ClientConfigurationPublication.js";
import {
  clientRegistrationEnvironment,
  clientRegistrationEnvironmentDetailsWithBudget,
  type ProviderRequestBudgetResolver,
} from "./ClientRegistrationEnvironment.js";

import {
  clientRegistrationOwnership,
  clientRegistrationOwnershipRemediation,
  refreshClientRegistration,
} from "./ClientRegistration.js";

import { LEGACY_MCP_SERVER_KEY, PRODUCT_IDENTITY } from "../identity.js";
import { dialectCanRemoveHistorical } from "./RegistrationDialectCapability.js";
import { snapshotEnvironment } from "../process/snapshotEnvironment.js";
import { npxRegistrationCommand } from "./ClientRegistrationIdentity.js";
import { resolveClientConfigTransactionPath } from "./ClientConfigPath.js";
import { packageReadTargetChanged } from "./MsixPackageStorage.js";
import { RegularFileCleanupFailure } from "../filesystem/OwnedRegularFile.js";
import {
  readRegularFileText,
  readRegularFileTextSnapshot,
  InvalidUtf8FileError,
} from "./RegularFileRead.js";
import {
  preserveCurrentRecoveryBackup,
  selectCurrentRecoveryBackup,
} from "./SetupRecoveryBackup.js";
import type {
  ClientConfigurationInspection,
  ClientConfigurationResult,
  SetupProviderEnvironment,
} from "./SetupTypes.js";
import {
  registrationWriteBlocker,
  type SetupClient,
} from "./SupportedClients.js";

export class ClientConfigurationCleanupRollbackFailure extends RegularFileCleanupFailure<string> {
  constructor(
    failure: RegularFileCleanupFailure<string>,
    readonly configurationFailure: Extract<
      ClientConfigurationResult,
      { readonly status: "failed" }
    >,
  ) {
    super({
      ...failure,
      cleanupCause: new AggregateError(
        [failure.cleanupCause, configurationFailure],
        `Configuration readback cleanup and rollback failed: ${failure.path}`,
      ),
    });
  }
}

/**
 * §3 rows 6–12, decided before anything is written.
 *
 * Two facts stop a setup write: a member this product does not own (writing beside it manufactures
 * the duplicate row 10 forbids, and overwriting it takes over someone else's registration), and an
 * owned historical member in a dialect that cannot remove it without dropping the user's comments.
 *
 * It runs before `registrationCurrent` asks whether a write is needed: rows 10 and 11 are BLOCK
 * even when the current member already matches, which is exactly the state that looks "unchanged".
 */
const configurationWriteRefusal = (
  parsed: ClientConfigurationDocument,
  client: SetupClient,
):
  | {
      readonly status: "failed";
      readonly reason: "registration_ownership";
      readonly detail: string;
    }
  | undefined => {
  const ownershipOf = (key: string) =>
    Object.hasOwn(parsed.servers, key)
      ? clientRegistrationOwnership(parsed.servers[key], client)
      : "absent";
  const currentOwnership = ownershipOf(PRODUCT_IDENTITY.mcpServerKey);
  const legacyOwnership = ownershipOf(LEGACY_MCP_SERVER_KEY);
  // §1 D: the Harness owns its registration by stable Cordis entry id, and the projected
  // `servers.rea` value is a view of that entry — a malformed launcher inside it says nothing
  // about who owns the entry. `registrationOwnershipBlocker` exempts dsh for the same reason.
  const members =
    parsed.dialect === "dsh"
      ? []
      : ([
          [PRODUCT_IDENTITY.mcpServerKey, currentOwnership],
          [LEGACY_MCP_SERVER_KEY, legacyOwnership],
        ] as const);
  const blocked = members.find(
    ([, ownership]) => ownership !== "absent" && ownership !== "owned",
  );
  if (blocked !== undefined)
    return {
      status: "failed",
      reason: "registration_ownership",
      detail: `The "${String(blocked[0])}" registration is ${String(blocked[1]) === "unknown" ? "not readable as this product's own" : "owned by another product"}; it was left untouched. Remove or rename it by hand, then rerun rea setup.`,
    };
  if (legacyOwnership === "owned" && !dialectCanRemoveHistorical(parsed))
    return {
      status: "failed",
      reason: "registration_ownership",
      detail: `The "${LEGACY_MCP_SERVER_KEY}" registration can only be replaced by rewriting this ${client.format} file, which drops the comments you wrote. Nothing was changed. Remove that entry by hand, then rerun rea setup.`,
    };
  return undefined;
};

/** Configure one supported client's native stdio MCP registration shape. */
export const configureClientConfiguration = async (
  client: SetupClient,
  environment: SetupProviderEnvironment = {},
  command: readonly string[] = npxRegistrationCommand(),
  resolveProviderRequestBudget?: ProviderRequestBudgetResolver,
): Promise<ClientConfigurationResult> => {
  if (client.configPathError !== undefined)
    return { status: "failed", reason: "path" };
  const transactionPath = await resolveClientConfigTransactionPath(
    client.configPath,
  );
  if (transactionPath === undefined)
    return { status: "failed", reason: "path" };
  try {
    return await withClientConfigurationTransaction(transactionPath, () =>
      configureClientDocument(
        { client, transactionPath },
        environment,
        command,
        resolveProviderRequestBudget,
      ),
    );
  } catch (cause: unknown) {
    if (cause instanceof ConfigurationError)
      return { status: "failed", reason: "readback" };
    throw cause;
  }
};

// oxlint-disable-next-line max-lines-per-function -- One transaction: read, admit, decide, write and verify. Splitting it would separate the admission order from the write it protects.
const configureClientDocument = async (
  {
    client,
    transactionPath,
  }: { readonly client: SetupClient; readonly transactionPath: string },
  environment: SetupProviderEnvironment,
  command: readonly string[],
  resolveProviderRequestBudget?: ProviderRequestBudgetResolver,
): Promise<ClientConfigurationResult> => {
  const format = client.format;
  if (format === undefined || format === "unsupported")
    return { status: "failed", reason: "readback" };
  const files = await readClientConfigurationFiles(
    client,
    undefined,
    undefined,
    environment,
  );
  if (!files.ok) {
    throwCleanupFailure(files.error);
    return { status: "failed", reason: "readback" };
  }
  const existing = files.value.find(
    ({ sourcePath }) => sourcePath === client.configPath,
  );
  const editabilityError =
    existing?.dialect === "dsh"
      ? dshDocument(existing.document).editabilityError
      : undefined;
  if (editabilityError !== undefined)
    return { status: "failed", reason: "readback" };
  // Policy admission belongs to the transaction snapshot below, not the
  // earlier layered discovery document.
  let snapshot:
    | Awaited<ReturnType<typeof readRegularFileTextSnapshot>>
    | undefined;
  try {
    snapshot = await readRegularFileTextSnapshot(transactionPath, {
      symlinks: "reject",
    });
  } catch (cause: unknown) {
    if (cause instanceof RegularFileCleanupFailure) throw cause;
    if (!isMissing(cause)) return { status: "failed", reason: "readback" };
  }
  const original = snapshot?.text;
  let parsed: ClientConfigurationDocument;
  try {
    parsed = parseClientConfiguration(
      original ??
        (format === "toml" || format === "grok" || format === "dsh"
          ? ""
          : "{}"),
      format,
    );
    parsed = clientConfigurationForWrite(parsed, files.value);
    const ownershipBlocker = registrationOwnershipBlocker(
      client,
      parsed,
      original ?? "",
      files.value,
    );
    if (ownershipBlocker !== undefined)
      return {
        status: "failed",
        reason: "registration_ownership",
        detail: ownershipBlocker,
      };
    const historicalBlocker = historicalIdentityBlocker(
      client,
      parsed,
      files.value,
    );
    if (historicalBlocker !== undefined)
      return {
        status: "failed",
        reason: historicalBlocker.reason,
        detail: historicalBlocker.detail,
      };
    const policy = await readClientPolicyBlock(
      client,
      parsed,
      await clientConfigurationDesired(
        client,
        environment,
        command,
        parsed,
        files.value,
        resolveProviderRequestBudget,
      ),
    );
    if (!policy.ok) {
      throwCleanupFailure(policy.error);
      return { status: "failed", reason: "readback" };
    }
    if (policy.value !== undefined)
      return { status: "failed", reason: "readback" };
  } catch (cause: unknown) {
    if (cause instanceof RegularFileCleanupFailure) throw cause;
    // Malformed existing configuration fails the readback gate.
    void cause;
    return { status: "failed", reason: "readback" };
  }
  const fallback = await readZcodeFallbackServers(client, parsed);
  if (!fallback.ok) {
    if (fallback.error.kind !== "registration_ownership")
      throwCleanupFailure(fallback.error);
    return fallback.error.kind === "registration_ownership"
      ? {
          status: "failed",
          reason: "registration_ownership",
          detail: fallback.error.detail,
        }
      : { status: "failed", reason: "readback" };
  }
  const fallbackBlocker = fallbackHistoricalBlocker(client, fallback.value);
  if (fallbackBlocker !== undefined)
    return {
      status: "failed",
      reason: fallbackBlocker.reason,
      detail: fallbackBlocker.detail,
    };
  const desired = await clientConfigurationDesired(
    client,
    environment,
    command,
    {
      ...parsed,
      servers: { ...fallback.value, ...parsed.servers },
    },
    files.value,
    resolveProviderRequestBudget,
  );
  // A state the contract blocks must be reported even when no write is apparently needed: row 10
  // and row 11 both look `unchanged` from the current member alone.
  const refusal = configurationWriteRefusal(parsed, client);
  if (refusal !== undefined) return refusal;
  // §3 row 6: a registration that only exists under the historical key is not "current", even
  // when the client would load it with the desired launcher. Reporting `unchanged` there leaves
  // the inherited member in place and the identity mismatch never resolves.
  // §1 D: the Harness stores its registration as `servers.rea` because that is what the Cordis
  // entry projects to, so `rea` there is the *current* identity, not an inherited one. Treating it
  // as inherited made every second Harness setup report `configured` instead of `unchanged`.
  const inheritsHistoricalMember =
    parsed.dialect !== "dsh" &&
    Object.hasOwn(parsed.servers, LEGACY_MCP_SERVER_KEY) &&
    clientRegistrationOwnership(
      parsed.servers[LEGACY_MCP_SERVER_KEY],
      client,
    ) === "owned" &&
    dialectCanRemoveHistorical(parsed);
  if (registrationCurrent(parsed, desired) && !inheritsHistoricalMember)
    return { status: "unchanged" };
  return persistClientConfiguration({
    client,
    transactionPath,
    snapshot,
    format,
    original,
    parsed,
    desired,
    fallbackServers: fallback.value,
  });
};

interface ClientConfigurationUpdate {
  readonly client: SetupClient;
  readonly transactionPath: string;
  readonly snapshot:
    | Awaited<ReturnType<typeof readRegularFileTextSnapshot>>
    | undefined;
  readonly format: NonNullable<SetupClient["format"]>;
  readonly original: string | undefined;
  readonly parsed: ClientConfigurationDocument;
  readonly desired: unknown;
  readonly fallbackServers: Readonly<Record<string, unknown>>;
}

const persistClientConfiguration = async ({
  client,
  transactionPath,
  snapshot,
  format,
  original,
  parsed,
  desired,
  fallbackServers,
}: ClientConfigurationUpdate): Promise<ClientConfigurationResult> => {
  // The plan chose this file; an MSIX package may have switched to its
  // private copy since, for example when it quit.
  if (client.msixPackage !== undefined) {
    const target = await packageReadTargetChanged(
      client.msixPackage,
      client.configPath,
    );
    if (!target.ok)
      return {
        status: "failed",
        reason: "target_unavailable",
        failure: {
          kind: "inspect",
          path: target.error.path,
          detail: target.error.detail,
        },
      };
    if (target.value) return { status: "failed", reason: "target_changed" };
  }
  // A native OpenCode V2 entry replaces REA's legacy V1 entry, which would
  // otherwise conflict with it.
  const legacyPath = legacyClientServerPath(
    parsed,
    PRODUCT_IDENTITY.mcpServerKey,
  );
  // §3 rows 6–12 are decided before the write, and before the question of whether one is needed:
  // rows 10 and 11 are BLOCK even when the current member already matches.
  const refusal = configurationWriteRefusal(parsed, client);
  if (refusal !== undefined) return refusal;
  const legacyOwned =
    Object.hasOwn(parsed.servers, LEGACY_MCP_SERVER_KEY) &&
    clientRegistrationOwnership(
      parsed.servers[LEGACY_MCP_SERVER_KEY],
      client,
    ) === "owned";
  const retireLegacy = legacyOwned;
  const inherited = { ...fallbackServers, ...parsed.servers };
  if (retireLegacy) delete inherited[LEGACY_MCP_SERVER_KEY];
  const registered = withClientServers(
    parsed,
    {
      ...inherited,
      [PRODUCT_IDENTITY.mcpServerKey]: desired,
    },
    PRODUCT_IDENTITY.mcpServerKey,
  );
  // OMP's denylist would hide the registration; keep every other listed name.
  const ompDisabled =
    parsed.dialect === "omp"
      ? parsed.document[OMP_DISABLED_SERVERS_KEY]
      : undefined;
  const enableOmp =
    Array.isArray(ompDisabled) &&
    ompDisabled.includes(PRODUCT_IDENTITY.mcpServerKey);
  const document =
    enableOmp && Array.isArray(ompDisabled)
      ? {
          ...registered,
          [OMP_DISABLED_SERVERS_KEY]: ompDisabled.filter(
            (name: unknown) => name !== PRODUCT_IDENTITY.mcpServerKey,
          ),
        }
      : registered;
  let serialized: ReturnType<typeof serializeClientConfiguration>;
  try {
    serialized = serializeClientConfiguration(
      document,
      format,
      original,
      [
        ...Object.keys(fallbackServers)
          .filter((name) => name !== PRODUCT_IDENTITY.mcpServerKey)
          .map((name) => clientServerPath(parsed, name)),
        clientServerPath(parsed, PRODUCT_IDENTITY.mcpServerKey),
        ...(retireLegacy
          ? [clientServerPath(parsed, LEGACY_MCP_SERVER_KEY)]
          : []),
        ...(legacyPath === undefined ? [] : [legacyPath]),
        ...(enableOmp ? [[OMP_DISABLED_SERVERS_KEY]] : []),
      ],
      // Ownership admission above covers every legacy member removed here.
      {
        removeShadowedMembersAt: legacyPath === undefined ? [] : [legacyPath],
      },
    );
  } catch (cause: unknown) {
    // An unserializable edit is reported before any file is written.
    return {
      status: "failed",
      reason: "write",
      failure: new ClientConfigurationWriteError(
        client.configPath,
        "serialize",
        cause,
      ).problem,
    };
  }
  if (!serialized.ok)
    return {
      status: "failed",
      reason: "shadowed_member",
      path: serialized.error.path,
    };
  let recoveryBackupPath: string | undefined;
  if (original !== undefined) {
    const preserved = await preserveCurrentRecoveryBackup(
      `${client.configPath}.rea.backup`,
      transactionPath,
      original,
    );
    if (!preserved.ok) return { status: "failed", reason: "backup" };
    recoveryBackupPath = preserved.value;
  }
  let publication: ClientConfigurationPublication;
  try {
    await mkdir(dirname(client.configPath), { recursive: true });
    publication = await ClientConfigurationPublication.write(
      transactionPath,
      serialized.value,
      original,
      0o600,
      { requestedPath: client.configPath, state: snapshot?.state },
    );
  } catch (cause: unknown) {
    if (isClientConfigurationCleanupFailure(cause)) throw cause;
    if (isConfigurationConflict(cause))
      return conflictFailure(recoveryBackupPath);
    return {
      status: "failed",
      reason: "write",
      failure: (cause instanceof ClientConfigurationWriteError
        ? cause
        : new ClientConfigurationWriteError(client.configPath, "publish", cause)
      ).problem,
      ...(recoveryBackupPath === undefined
        ? {}
        : { backupPath: recoveryBackupPath }),
    };
  }
  return publication.verify(async () => {
    try {
      const text = await readRegularFileText(publication.path);
      await publication.assertCurrent(text);
      const readback = parseClientConfiguration(text, format);
      if (
        !registrationCurrent(readback, desired) ||
        Object.entries(fallbackServers).some(
          ([name, entry]) =>
            name !== PRODUCT_IDENTITY.mcpServerKey &&
            !clientConfigurationValuesEqual(readback.servers[name], entry),
        )
      ) {
        return await rollbackOrReadbackFailure(
          publication,
          original,
          recoveryBackupPath,
        );
      }
    } catch (cause: unknown) {
      if (isConfigurationConflict(cause) || isMissing(cause))
        return conflictFailure(recoveryBackupPath);
      if (cause instanceof RegularFileCleanupFailure) {
        const rollback = await restoreConfig(publication, original);
        if (!rollback.ok)
          throw new ClientConfigurationCleanupRollbackFailure(
            cause,
            rollbackFailure(rollback.error, recoveryBackupPath),
          );
        throw cause;
      }
      // Readback failure restores the transaction before reporting.
      void cause;
      return rollbackOrReadbackFailure(
        publication,
        original,
        recoveryBackupPath,
      );
    }
    return {
      status: "configured",
      ...(recoveryBackupPath === undefined
        ? {}
        : { backupPath: recoveryBackupPath }),
    };
  });
};

/** Determine whether an existing client configuration matches the desired registration. */
export const clientConfigurationAligned = async (
  client: SetupClient,
  providerEnvironment: SetupProviderEnvironment,
  command: readonly string[],
  resolveProviderRequestBudget?: ProviderRequestBudgetResolver,
): Promise<boolean> => {
  if (client.configPathError !== undefined) return false;
  try {
    const files = await readClientConfigurationFiles(
      client,
      undefined,
      undefined,
      providerEnvironment,
    );
    if (!files.ok) {
      throwCleanupFailure(files.error);
      return false;
    }
    const original = await readRegularFileText(client.configPath);
    const parsed = clientConfigurationForWrite(
      parseClientConfiguration(original, client.format),
      files.value,
    );
    const desired = await clientConfigurationDesired(
      client,
      providerEnvironment,
      command,
      parsed,
      files.value,
      resolveProviderRequestBudget,
    );
    const policy = await readClientPolicyBlock(client, parsed, desired);
    if (!policy.ok) {
      throwCleanupFailure(policy.error);
      return false;
    }
    return policy.value === undefined && registrationCurrent(parsed, desired);
  } catch (cause: unknown) {
    if (cause instanceof RegularFileCleanupFailure) throw cause;
    // Unreadable configuration is treated as not aligned so setup repairs it.
    void cause;
    return false;
  }
};

/** Preflight one client configuration before setup presents any mutations. */
export const inspectClientConfiguration = async (
  client: SetupClient,
  providerEnvironment: SetupProviderEnvironment,
  command: readonly string[],
  resolveProviderRequestBudget?: ProviderRequestBudgetResolver,
): Promise<ClientConfigurationInspection> => {
  let inspection: ClientConfigurationInspection;
  try {
    inspection = await inspectClientDocument(
      client,
      providerEnvironment,
      command,
      resolveProviderRequestBudget,
    );
  } catch (cause: unknown) {
    if (!(cause instanceof ConfigurationError)) throw cause;
    return {
      status: "invalid",
      remediation: `${cause.message}: ${cause.settings.map(({ setting, constraint }) => `${setting}: ${constraint}`).join("; ")}`,
    };
  }
  if (inspection.status !== "create" && inspection.status !== "update")
    return inspection;
  // A change the running client would overwrite is not a persisted registration.
  const blocker = registrationWriteBlocker(client, "setup");
  return blocker === undefined
    ? inspection
    : { status: "invalid", remediation: blocker };
};

// oxlint-disable-next-line max-lines-per-function -- One inspection: read, admit, decide and plan. The admission order is the point, so it is kept beside the decision it produces.
const inspectClientDocument = async (
  client: SetupClient,
  providerEnvironment: SetupProviderEnvironment,
  command: readonly string[],
  resolveProviderRequestBudget?: ProviderRequestBudgetResolver,
): Promise<ClientConfigurationInspection> => {
  if (client.configPathError !== undefined)
    return { status: "invalid", remediation: client.configPathError };
  if (client.format === "unsupported") return { status: "already_current" };
  const files = await readClientConfigurationFiles(
    client,
    undefined,
    undefined,
    providerEnvironment,
  );
  if (!files.ok) {
    throwCleanupFailure(files.error);
    return {
      status: "invalid",
      remediation: files.error.detail,
    };
  }
  const existing = files.value.find(
    ({ sourcePath }) => sourcePath === client.configPath,
  );
  const editabilityError =
    existing?.dialect === "dsh"
      ? dshDocument(existing.document).editabilityError
      : undefined;
  if (editabilityError !== undefined)
    return {
      status: "invalid",
      remediation: editabilityError.message,
    };
  const transactionPath = await resolveClientConfigTransactionPath(
    client.configPath,
  );
  if (transactionPath === undefined)
    return {
      status: "invalid",
      remediation:
        "The configuration path is unsafe or unresolved. Check ownership and symbolic links before rerunning setup.",
    };
  let original: string;
  try {
    original = await readRegularFileText(transactionPath);
  } catch (cause: unknown) {
    if (cause instanceof RegularFileCleanupFailure) throw cause;
    if (isMissing(cause)) {
      const inherited = effectiveClientConfiguration(files.value, {
        client,
        document: undefined,
      });
      const ownershipBlocker =
        inherited === undefined
          ? undefined
          : registrationOwnershipBlocker(client, inherited, "", files.value);
      if (ownershipBlocker !== undefined)
        return { status: "invalid", remediation: ownershipBlocker };
      const inheritedHistorical =
        inherited === undefined
          ? undefined
          : historicalIdentityBlocker(client, inherited, files.value);
      if (inheritedHistorical !== undefined)
        return { status: "invalid", remediation: inheritedHistorical.detail };
      // This read establishes absence; do not reuse an earlier user-file policy.
      const policy = await readClientPolicyBlock(
        client,
        undefined,
        await clientConfigurationDesired(
          client,
          providerEnvironment,
          command,
          undefined,
          files.value,
          resolveProviderRequestBudget,
        ),
      );
      if (!policy.ok) {
        throwCleanupFailure(policy.error);
        return {
          status: "invalid",
          remediation: policy.error.detail,
        };
      }
      if (policy.value !== undefined)
        return { status: "invalid", remediation: policy.value };
      const fallback = await readZcodeFallbackServers(client);
      if (!fallback.ok) {
        if (fallback.error.kind !== "registration_ownership")
          throwCleanupFailure(fallback.error);
        return { status: "invalid", remediation: fallback.error.detail };
      }
      const fallbackBlocker = fallbackHistoricalBlocker(client, fallback.value);
      if (fallbackBlocker !== undefined)
        return { status: "invalid", remediation: fallbackBlocker.detail };
      return { status: "create" };
    }
    return {
      status: "invalid",
      remediation: `The configuration file could not be read. Check its permissions before rerunning setup. ${cause instanceof Error ? cause.message : String(cause)}`,
    };
  }
  try {
    const parsed = clientConfigurationForWrite(
      parseClientConfiguration(original, client.format),
      files.value,
    );
    const ownershipBlocker = registrationOwnershipBlocker(
      client,
      parsed,
      original,
      files.value,
    );
    if (ownershipBlocker !== undefined)
      return { status: "invalid", remediation: ownershipBlocker };
    const historicalBlocker = historicalIdentityBlocker(
      client,
      parsed,
      files.value,
    );
    if (historicalBlocker !== undefined)
      return { status: "invalid", remediation: historicalBlocker.detail };
    const desired = await clientConfigurationDesired(
      client,
      providerEnvironment,
      command,
      parsed,
      files.value,
      resolveProviderRequestBudget,
    );
    const policy = await readClientPolicyBlock(client, parsed, desired);
    if (!policy.ok) {
      throwCleanupFailure(policy.error);
      return {
        status: "invalid",
        remediation: policy.error.detail,
      };
    }
    if (policy.value !== undefined)
      return { status: "invalid", remediation: policy.value };
    const fallback = await readZcodeFallbackServers(client, parsed);
    if (!fallback.ok) {
      if (fallback.error.kind !== "registration_ownership")
        throwCleanupFailure(fallback.error);
      return { status: "invalid", remediation: fallback.error.detail };
    }
    // The fallback is merged into the write, so a historical member living only
    // there must refuse the plan before an already-current document hides it.
    const fallbackBlocker = fallbackHistoricalBlocker(client, fallback.value);
    if (fallbackBlocker !== undefined)
      return { status: "invalid", remediation: fallbackBlocker.detail };
    if (registrationCurrent(parsed, desired))
      return { status: "already_current" };
  } catch (cause: unknown) {
    if (
      cause instanceof RegularFileCleanupFailure ||
      cause instanceof ConfigurationError
    )
      throw cause;
    // Malformed configuration is reported with the invalid remediation.
    void cause;
    return {
      status: "invalid",
      remediation:
        "The existing configuration is malformed. Repair it before setup applies any other changes.",
    };
  }
  const backupSelection = await selectCurrentRecoveryBackup(
    `${client.configPath}.rea.backup`,
    original,
  );
  if (!backupSelection.ok)
    return {
      status: "invalid",
      remediation: backupSelection.error.detail,
    };
  return {
    status: "update",
    backupPath: backupSelection.value.backupPath,
  };
};

const isMissing = (cause: unknown): boolean =>
  cause instanceof Error && "code" in cause && cause.code === "ENOENT";

const throwCleanupFailure = (error: ClientConfigurationFileError): void => {
  if (error.cleanupFailure !== undefined) throw error.cleanupFailure;
};

/** Admit only absent or proven-owned rows that this setup would replace. */
const registrationOwnershipBlocker = (
  client: SetupClient,
  parsed: ClientConfigurationDocument,
  original: string,
  sources: readonly ClientConfigurationSource[] = [],
): string | undefined => {
  // Cordis owns registrations by stable entry ID, including malformed launchers.
  if (parsed.dialect === "dsh") return undefined;
  const name = PRODUCT_IDENTITY.mcpServerKey;
  const entries: { value: unknown; paths: readonly string[] }[] = [];
  const effective = effectiveClientConfiguration(sources, {
    client,
    document: parsed,
  });
  if (effective !== undefined && Object.hasOwn(effective.servers, name))
    entries.push({
      value: effective.servers[name],
      paths: client.configPaths ?? [client.configPath],
    });
  const fragment = parsed.servers[name];
  // A layered policy fragment inherits its launcher. Classify the effective
  // launcher above, but also admit any explicit command this write replaces.
  const inheritsLauncher =
    effective !== undefined &&
    effective !== parsed &&
    typeof fragment === "object" &&
    fragment !== null &&
    !Array.isArray(fragment) &&
    !Object.hasOwn(fragment, "command");
  if (Object.hasOwn(parsed.servers, name) && !inheritsLauncher)
    entries.push({ value: parsed.servers[name], paths: [client.configPath] });
  if (legacyClientServerPath(parsed, name) !== undefined) {
    entries.push({
      value: parsed.legacyServers[name],
      paths: [client.configPath],
    });
    entries.push(
      ...shadowedClientServers(original, parsed, name).legacyServers.map(
        (value) => ({ value, paths: [client.configPath] }),
      ),
    );
  }
  for (const entry of entries) {
    const ownership = clientRegistrationOwnership(entry.value, client);
    if (ownership !== "owned")
      return clientRegistrationOwnershipRemediation(ownership, entry.paths);
  }
  return undefined;
};

/**
 * Product decision: a registration under the historical key that this write
 * cannot remove must not survive beside the current one. OpenCode loads the V1
 * table and the native table together, so leaving `rea` in place registers this
 * product twice: the second entry can shadow or duplicate the one setup just
 * wrote. Removal is refused rather than attempted, because the guard has no
 * independent authority to delete a registration it did not install.
 *
 * This gate is deliberately narrow. It only asks whether a historical member
 * would still be loaded after the write; it introduces no second notion of
 * identity and defers to the same document the ownership admission reads.
 */
type HistoricalIdentityBlocker = {
  readonly reason: "registration_ownership" | "historical_identity";
  readonly detail: string;
};

const historicalIdentityBlocker = (
  client: SetupClient,
  parsed: ClientConfigurationDocument,
  sources: readonly ClientConfigurationSource[] = [],
): HistoricalIdentityBlocker | undefined => {
  // The Harness stores one Cordis entry per document under its stable entry id.
  if (parsed.dialect === "dsh") return undefined;
  const paths = client.configPaths ?? [client.configPath];
  // A member the client does not load is not a second registration. A V1 table
  // spells activation `enabled`, a native V2 entry spells it `disabled`.
  const loads = (
    document: ClientConfigurationDocument,
    fromLegacyTable: boolean,
  ): unknown => {
    const member = fromLegacyTable
      ? document.legacyServers[LEGACY_MCP_SERVER_KEY]
      : document.servers[LEGACY_MCP_SERVER_KEY];
    const present = fromLegacyTable
      ? Object.hasOwn(document.legacyServers, LEGACY_MCP_SERVER_KEY)
      : Object.hasOwn(document.servers, LEGACY_MCP_SERVER_KEY);
    if (!present || member === null || member === undefined) return undefined;
    if (clientServerListedDisabled(document, LEGACY_MCP_SERVER_KEY))
      return undefined;
    if (typeof member === "object" && !Array.isArray(member)) {
      const entry = member as { disabled?: unknown; enabled?: unknown };
      // Each table spells activation its own way: a V1 entry carries `enabled`,
      // a native entry carries `disabled`. Honouring the other field would read
      // a live registration as absent.
      if (fromLegacyTable ? entry.enabled === false : entry.disabled === true)
        return undefined;
    }
    return member;
  };
  // The write target's own V1 member is never removed, so it always survives.
  // Its native member is retired by the same transaction — but only where the
  // serializer can express that removal: the Hermes path upserts the current
  // entry and leaves every other table in place.
  const retiresNativeMember = parsed.dialect !== "hermes";
  const surviving =
    loads(parsed, true) ??
    (retiresNativeMember ? undefined : loads(parsed, false)) ??
    sources
      .filter(({ sourcePath }) => sourcePath !== client.configPath)
      .map((source) => loads(source, true) ?? loads(source, false))
      .find((member) => member !== undefined);
  if (surviving === undefined) return undefined;
  // Ownership comes first: a registration this product does not own is the
  // existing refusal's subject, not a historical-identity one.
  const ownership = clientRegistrationOwnership(surviving, client);
  if (ownership !== "owned")
    return {
      reason: "registration_ownership",
      detail: clientRegistrationOwnershipRemediation(
        ownership,
        paths,
        LEGACY_MCP_SERVER_KEY,
      ),
    };
  return {
    reason: "historical_identity",
    detail: `The configuration read from ${paths.join(", ")} also registers this product under its earlier key "${LEGACY_MCP_SERVER_KEY}". This setup cannot remove that registration safely, so it would leave two registrations of the same product for the client to load at once. No configuration file was changed. Rename or remove the "${LEGACY_MCP_SERVER_KEY}" registration by hand, then rerun setup.`,
  };
};

/**
 * The same question for the ZCode fallback table, which is merged into the write
 * only after the layer sources are read. A member the client does not load is not
 * a registration, and ownership decides before coexistence here too.
 */
const fallbackHistoricalBlocker = (
  client: SetupClient,
  fallbackServers: Readonly<Record<string, unknown>>,
): HistoricalIdentityBlocker | undefined => {
  const member = fallbackServers[LEGACY_MCP_SERVER_KEY];
  if (!Object.hasOwn(fallbackServers, LEGACY_MCP_SERVER_KEY)) return undefined;
  if (member === null || member === undefined) return undefined;
  if (
    typeof member === "object" &&
    !Array.isArray(member) &&
    (member as { disabled?: unknown }).disabled === true
  )
    return undefined;
  const path = client.zcodeFallbackPath ?? client.configPath;
  const ownership = clientRegistrationOwnership(member, client);
  if (ownership !== "owned")
    return {
      reason: "registration_ownership",
      detail: clientRegistrationOwnershipRemediation(
        ownership,
        [path],
        LEGACY_MCP_SERVER_KEY,
      ),
    };
  return {
    reason: "historical_identity",
    detail: `The ZCode fallback configuration ${path} registers this product under its earlier key "${LEGACY_MCP_SERVER_KEY}". This setup cannot remove that registration safely, so it would leave two registrations of the same product for the client to load at once. No configuration file was changed. Rename or remove the "${LEGACY_MCP_SERVER_KEY}" registration by hand, then rerun setup.`,
  };
};

/** Admit the fallback only when the first native ZCode server would suppress it. */
const readZcodeFallbackServers = async (
  client: SetupClient,
  parsed?: ClientConfigurationDocument,
): Promise<
  Result<
    Readonly<Record<string, unknown>>,
    | ClientConfigurationFileError
    | {
        readonly kind: "registration_ownership";
        readonly path: string;
        readonly detail: string;
      }
  >
> => {
  if (
    client.format !== "zcode" ||
    (parsed !== undefined && Object.keys(parsed.servers).length > 0)
  )
    return ok({});
  const path = client.zcodeFallbackPath;
  const detail = `The ZCode fallback configuration ${path ?? "path"} is unresolved, malformed or unreadable. Repair it before rerunning setup: the first native server would suppress that fallback.`;
  if (path === undefined)
    return err({ kind: "unreadable", path: client.configPath, detail });
  const transactionPath = await resolveClientConfigTransactionPath(path);
  if (transactionPath === undefined)
    return err({ kind: "unreadable", path, detail });
  const source = await readConfigurationText(transactionPath);
  if (!source.ok)
    return err({ ...source.error, detail: `${detail} ${source.error.detail}` });
  if (source.value === undefined) return ok({});
  try {
    const parsed = parseZcodeFallbackConfiguration(source.value);
    const ownershipBlocker = registrationOwnershipBlocker(
      { ...client, configPath: path, format: "zcode_fallback" },
      parsed,
      source.value,
    );
    if (ownershipBlocker !== undefined)
      return err({
        kind: "registration_ownership",
        path,
        detail: ownershipBlocker,
      });
    const environment = clientRegistrationEnvironment(parsed);
    if (!environment.ok)
      return err({
        kind: "malformed",
        path,
        detail: `${detail} ${environment.error.settings.map(({ setting, constraint }) => `${setting}: ${constraint}`).join("; ")}`,
      });
    return ok(parsed.servers);
  } catch (cause: unknown) {
    return err({
      kind: "malformed",
      path,
      detail: `${detail} ${cause instanceof Error ? cause.message : String(cause)}`,
    });
  }
};

type ConfigurationRestoreFailure =
  | { readonly kind: "conflict" }
  | {
      readonly kind: "restore";
      readonly path: string;
      readonly detail: string;
    };

const restoreConfig = async (
  publication: ClientConfigurationPublication,
  original: string | undefined,
): Promise<Result<void, ConfigurationRestoreFailure>> => {
  try {
    await publication.restore(original);
    return ok(undefined);
  } catch (cause: unknown) {
    if (isConfigurationConflict(cause) || isMissing(cause))
      return err({ kind: "conflict" });
    return err({
      kind: "restore",
      path: publication.path,
      detail: errorDetail(cause),
    });
  }
};

const rollbackOrReadbackFailure = async (
  publication: ClientConfigurationPublication,
  original: string | undefined,
  backupPath: string | undefined,
): Promise<ClientConfigurationResult> => {
  const rollback = await restoreConfig(publication, original);
  return rollback.ok
    ? {
        status: "failed",
        reason: "readback",
        ...(backupPath === undefined ? {} : { backupPath }),
      }
    : rollbackFailure(rollback.error, backupPath);
};

const rollbackFailure = (
  failure: ConfigurationRestoreFailure,
  backupPath?: string,
): Extract<ClientConfigurationResult, { readonly status: "failed" }> =>
  failure.kind === "conflict"
    ? conflictFailure(backupPath)
    : {
        status: "failed",
        reason: "rollback",
        failure,
        ...(backupPath === undefined ? {} : { backupPath }),
      };

const isConfigurationConflict = (cause: unknown): boolean =>
  cause instanceof RegularFileChangedError ||
  cause instanceof InvalidUtf8FileError;

const conflictFailure = (
  backupPath?: string,
): Extract<ClientConfigurationResult, { readonly status: "failed" }> => ({
  status: "failed",
  reason: "conflict",
  ...(backupPath === undefined ? {} : { backupPath }),
});

const errorDetail = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

/** Whether REA's entry matches, no legacy entry remains, and no client disable list suppresses it. */
const registrationCurrent = (
  parsed: ClientConfigurationDocument,
  desired: unknown,
): boolean => {
  // The Harness projects its registration under the patch entry name rather than the
  // product key, so compare against the member this document actually carries. Using the
  // product key alone made every Harness rerun look stale and plan a redundant update.
  const name = productServerName(parsed);
  return (
    (parsed.dialect !== "dsh" || dshDocument(parsed.document).ready) &&
    clientConfigurationValuesEqual(parsed.servers[name], desired) &&
    !Object.hasOwn(parsed.legacyServers, name) &&
    !clientServerListedDisabled(parsed, name)
  );
};

const clientConfigurationDesired = async (
  client: SetupClient,
  providerEnvironment: SetupProviderEnvironment,
  command: readonly string[],
  parsed: ClientConfigurationDocument | undefined,
  sources: readonly ClientConfigurationSource[],
  resolveProviderRequestBudget?: ProviderRequestBudgetResolver,
): Promise<unknown> => {
  const effective = effectiveClientConfiguration(sources, {
    client,
    document: parsed,
  });
  const format = clientWriteDialect(
    parsed?.dialect ?? client.format ?? "json",
    sources,
  );
  const launcher =
    command.length === 0 ? [PRODUCT_IDENTITY.cliBinary, "mcp"] : command;
  if (format === "dsh") {
    const validated = clientRegistrationEnvironment(
      effective,
      providerEnvironment,
    );
    if (!validated.ok) throw validated.error;
    const desired = (
      parsed === undefined
        ? new DshCordisDocument("")
        : dshDocument(parsed.document)
    ).desired(launcher, providerEnvironment);
    if (!desired.ok) throw desired.error;
    return desired.value;
  }
  const validated = await clientRegistrationEnvironmentDetailsWithBudget(
    effective,
    providerEnvironment,
    "effective",
    client.name === "codex" || client.name === "kimi"
      ? resolveProviderRequestBudget
      : undefined,
  );
  if (!validated.ok) throw validated.error;
  // Preserve explicitly configured server settings, never the ambient process
  // environment. The effective layered view validates precedence and supplies
  // timeout facts; the target file's fragment remains the value being written.
  const environment = clientRegistrationEnvironment(
    parsed,
    providerEnvironment,
    "fragment",
  );
  if (!environment.ok) throw environment.error;
  const registrationEnvironment =
    client.name === "kimi" &&
    snapshotEnvironment(environment.value).REA_MCP_INPUT_SCHEMA_PROFILE ===
      undefined
      ? {
          ...environment.value,
          REA_MCP_INPUT_SCHEMA_PROFILE: "compact",
        }
      : environment.value;
  const registration = refreshClientRegistration(
    client,
    format,
    launcher,
    registrationEnvironment,
    parsed === undefined
      ? undefined
      : effectiveClientServer(parsed, PRODUCT_IDENTITY.mcpServerKey),
    validated.value.timeoutInputs,
  );
  if (!registration.ok) throw registration.error;
  return registration.value;
};
