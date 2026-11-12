import { lstatSync, realpathSync } from "node:fs";
import { posix, win32 } from "node:path";

import {
  clientSkillDirectories,
  clientUninstallConfigurationPaths,
  supportedClients,
} from "../application/SupportedClients.js";
import { linuxHopperReleaseCacheDirectory } from "../application/LinuxHopperCacheDirectory.js";
import { homeDirectoryFromEnvironment } from "../config/homeDirectory.js";
import {
  absoluteCallerPath,
  appendCallerPath,
} from "../filesystem/callerPath.js";
import { PRODUCT_IDENTITY } from "../identity.js";

/** Names one or more roots a test run owns; absent outside a test run. */
export const TEST_ISOLATION_ROOTS_VARIABLE = "REA_TEST_ISOLATION_ROOTS";

/** Commands that can create, rewrite, move or delete a client's files. */
const DESTRUCTIVE_COMMANDS: ReadonlySet<string> = new Set([
  "setup",
  "uninstall",
  "update",
]);

export interface TestIsolationSurface {
  readonly client: string;
  readonly kind: "config" | "skill" | "cache";
  readonly path: string;
}

const fold = (path: string, platform: NodeJS.Platform): string =>
  platform === "win32" ? path.toLowerCase() : path;

const resolveExisting = (
  path: string,
  platform: NodeJS.Platform,
): string | undefined => {
  const paths = platform === "win32" ? win32 : posix;
  const absolute = absoluteCallerPath(path, { platform });
  const segments: string[] = [];
  let current = absolute;
  for (let depth = 0; depth < 64; depth += 1) {
    try {
      return paths.join(realpathSync(current), ...segments.reverse());
    } catch (cause) {
      if (!isMissingPath(cause)) return undefined;
      try {
        // A dangling symlink cannot be canonicalized, but its spelling must not
        // be reconstructed from an in-root ancestor and admitted as contained.
        if (lstatSync(current).isSymbolicLink()) return undefined;
      } catch (inspectionError) {
        if (!isMissingPath(inspectionError)) return undefined;
      }
      const parent = paths.dirname(current);
      if (parent === current) return undefined;
      segments.push(paths.basename(current));
      current = parent;
    }
  }
  return undefined;
};

const isMissingPath = (cause: unknown): boolean =>
  typeof cause === "object" &&
  cause !== null &&
  "code" in cause &&
  (cause.code === "ENOENT" || cause.code === "ENOTDIR");

const inside = (
  path: string,
  root: string,
  platform: NodeJS.Platform,
): boolean => {
  const resolvedTarget = resolveExisting(path, platform);
  const resolvedBase = resolveExisting(root, platform);
  if (resolvedTarget === undefined || resolvedBase === undefined) return false;
  const target = fold(resolvedTarget, platform);
  const base = fold(resolvedBase, platform);
  const paths = platform === "win32" ? win32 : posix;
  const relativeTarget = paths.relative(base, target);
  return (
    relativeTarget === "" ||
    (!paths.isAbsolute(relativeTarget) &&
      relativeTarget !== ".." &&
      !relativeTarget.startsWith(`..${paths.sep}`))
  );
};

const rootsFrom = (
  raw: string,
  platform: NodeJS.Platform,
): readonly string[] => {
  const paths = platform === "win32" ? win32 : posix;
  return raw
    .split(platform === "win32" ? ";" : ":")
    .map((value) => value.trim())
    .filter((value) => value !== "" && paths.isAbsolute(value))
    .map((value) => paths.resolve(value));
};

/** Match Incur's boolean argv coercion without accepting non-true values. */
const hasEnabledBooleanOption = (
  commandArguments: readonly string[],
  flag: string,
): boolean =>
  commandArguments.some((argument, index) => {
    if (argument === `${flag}=true`) return true;
    if (argument !== flag) return false;
    const next = commandArguments[index + 1];
    // Incur treats a following word as a positional, not a boolean value.
    // These commands reject surplus positionals before any work is applied.
    return next === undefined || next.startsWith("-");
  });

/**
 * Enumerate the exact surfaces a destructive command may mutate. Uninstall
 * shares the application's MSIX-aware path resolver; the Hopper cache is added
 * only for Linux purge or an explicitly requested Hopper installation (plus an
 * interactive setup that can offer and approve that installation).
 */
export const testIsolationSurfaces = (
  command: string,
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  cwd: string,
  commandArguments: readonly string[] = [],
  mayPromptForHopper = false,
): readonly TestIsolationSurface[] => {
  const home = homeDirectoryFromEnvironment(environment, platform);
  const configurations = supportedClients(
    home,
    platform,
    environment,
    cwd,
  ).flatMap((client) => {
    const configPaths =
      command === "uninstall"
        ? clientUninstallConfigurationPaths(client)
        : [client.configPath, ...(client.configPaths ?? [])];
    return [
      ...configPaths,
      ...(client.zcodeFallbackPath === undefined
        ? []
        : [client.zcodeFallbackPath]),
    ]
      .filter(
        (surface): surface is string =>
          typeof surface === "string" && surface.length > 0,
      )
      .map((path) => ({ client: client.name, kind: "config" as const, path }));
  });
  const skillResolution = clientSkillDirectories(
    home,
    undefined,
    environment,
    platform,
    cwd,
  );
  const skills = [
    ...skillResolution.directories.flatMap(({ client, directory }) => [
      { client, kind: "skill" as const, path: directory },
      {
        client,
        kind: "skill" as const,
        path: appendCallerPath(directory, PRODUCT_IDENTITY.skillName, platform),
      },
    ]),
    ...skillResolution.unresolved.map(({ client, path }) => ({
      client,
      kind: "skill" as const,
      path,
    })),
  ];
  const dryRun =
    command === "setup" &&
    hasEnabledBooleanOption(commandArguments, "--dry-run");
  const needsHopperCache =
    platform === "linux" &&
    ((command === "uninstall" &&
      hasEnabledBooleanOption(commandArguments, "--purge-data")) ||
      (command === "setup" &&
        !dryRun &&
        (hasEnabledBooleanOption(commandArguments, "--install-hopper") ||
          mayPromptForHopper)));
  const hopperCache = needsHopperCache
    ? linuxHopperReleaseCacheDirectory(environment, home)
    : undefined;
  const caches: readonly TestIsolationSurface[] =
    hopperCache?.ok === true
      ? [{ client: "hopper", kind: "cache", path: hopperCache.value }]
      : [];
  return [...configurations, ...skills, ...caches];
};

export class TestIsolationViolation extends Error {
  constructor(
    readonly command: string,
    readonly surface: string,
    readonly roots: readonly string[],
  ) {
    super(
      `Refusing \`${command}\` under test isolation: ${surface} is outside ${roots.join(", ") || "(no root)"}. ` +
        `This process was started by a test run that declared isolated roots; a configuration, skill or cache path from the ambient environment reached it.`,
    );
  }
}

/**
 * Refuse a destructive command when this process was started by a test run that declared
 * isolated roots. The variable is only set by the test runner, so a normal user's
 * `setup`, `uninstall` or `update` never reaches this check and keeps its usual behaviour.
 *
 * This is the outer layer of the guard: it applies inside the CLI process, so it protects
 * every spawn route — the fixture, a direct `node scripts/rea.mjs`, or any future caller
 * that inherits the run's environment — not only the callers that remember to ask.
 */
export const assertTestIsolation = (
  command: string,
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  commandArguments: readonly string[] = [],
  mayPromptForHopper = false,
): void => {
  if (!DESTRUCTIVE_COMMANDS.has(command)) return;
  const raw = environment[TEST_ISOLATION_ROOTS_VARIABLE];
  if (raw === undefined || raw.trim() === "") return;
  const roots = rootsFrom(raw, platform);
  for (const surface of testIsolationSurfaces(
    command,
    environment,
    platform,
    process.cwd(),
    commandArguments,
    mayPromptForHopper,
  ))
    if (!roots.some((root) => inside(surface.path, root, platform)))
      throw new TestIsolationViolation(
        command,
        `${surface.client} ${surface.kind} ${surface.path}`,
        roots,
      );
};
