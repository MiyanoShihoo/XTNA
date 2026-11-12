import { lstatSync, realpathSync } from "node:fs";
import { posix, resolve, win32 } from "node:path";
import { platform as osPlatform } from "node:os";

import {
  testIsolationSurfaces,
  type TestIsolationSurface,
} from "../../../src/cli/testIsolation.js";
import { absoluteCallerPath } from "../../../src/filesystem/callerPath.js";

/**
 * Environment variables that directly select a client configuration, skill, marker or
 * home path. A test that inherits one of these from the developer's shell can point the
 * product at a real file, so a destructive command (`setup`, `uninstall`, `update`) can
 * edit or delete a live configuration.
 *
 * Keep this in sync with `homeDirectoryFromEnvironment()` and the path resolvers used by
 * `SupportedClients.ts` (including its AppData and Hermes helpers); cover new selectors in
 * the isolation diagnostic test. Hermes expands references inside `HERMES_HOME`, whose
 * resolved destination is checked even when the override contains another variable.
 */
export const CONFIG_REDIRECT_KEYS = [
  "APPDATA",
  "CLAUDE_CONFIG_DIR",
  "CODEX_HOME",
  "COPILOT_HOME",
  "DSH_AGENTS_HOME",
  "DSH_HOME",
  "FACTORY_HOME_OVERRIDE",
  "GEMINI_CLI_HOME",
  "GEMINI_CLI_SYSTEM_DEFAULTS_PATH",
  "GEMINI_CLI_SYSTEM_SETTINGS_PATH",
  "GEMINI_CLI_TRUSTED_FOLDERS_PATH",
  "GROK_HOME",
  "HERMES_DATA_DIR_SUFFIX",
  "HERMES_HOME",
  "HOME",
  "HOMEDRIVE",
  "HOMEPATH",
  "KIMI_CODE_HOME",
  "LOCALAPPDATA",
  "OMP_PROFILE",
  "OPENCODE_CONFIG",
  "OPENCODE_CONFIG_DIR",
  "PI_CODING_AGENT_DIR",
  "PI_CONFIG_DIR",
  "PI_PROFILE",
  "QODER_CONFIG_DIR",
  "QWEN_HOME",
  "SAND_DATA_ROOT",
  "USERPROFILE",
  "VSCODE_APPDATA",
  "VSCODE_CWD",
  "VSCODE_PORTABLE",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
] as const;

/** Commands that can create, rewrite, move or delete a client's files. */
const DESTRUCTIVE_COMMANDS = new Set(["setup", "uninstall", "update"]);

export class ConfigIsolationError extends Error {
  constructor(
    readonly command: string,
    readonly offender: string,
    readonly root: string,
  ) {
    super(
      `Refusing destructive "${command}": ${offender} resolves outside the test root ${root}. ` +
        `A configuration, skill or cache path from the ambient environment reached this process. ` +
        `Inspect these environment overrides: ${CONFIG_REDIRECT_KEYS.join("/")}. ` +
        `Path-valued destinations must resolve inside the test root.`,
    );
  }
}

const ownedRoots = new Set<string>();

/**
 * Record a directory this test run created and may therefore write inside. Only
 * registered roots are trusted: `HOME`, `USERPROFILE`, the working directory and the OS
 * temporary directory are *not* implicitly safe, because any of them can hold a real
 * client configuration.
 */
export const registerOwnedRoot = (path: string): void => {
  ownedRoots.add(resolve(path));
};

/** Roots the current test file owns. */
export const registeredRoots = (): readonly string[] => [...ownedRoots];

export const clearOwnedRoots = (): void => {
  ownedRoots.clear();
};

/** Windows comparisons are case-insensitive; other platforms compare byte-exact. */
const fold = (path: string, platform: NodeJS.Platform): string =>
  platform === "win32" ? path.toLowerCase() : path;

const inside = (
  path: string,
  root: string,
  platform: NodeJS.Platform,
  cwd: string,
): boolean => {
  const resolvedTarget = resolveExisting(path, platform, cwd);
  const resolvedBase = resolveExisting(root, platform, cwd);
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

/** Mutation surfaces selected by the same resolver used inside the CLI process. */
export const configuredPaths = (
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = osPlatform(),
  cwd: string = process.cwd(),
  command: string = "setup",
  commandArguments: readonly string[] = [],
): readonly TestIsolationSurface[] =>
  testIsolationSurfaces(command, environment, platform, cwd, commandArguments);

/**
 * Refuse a destructive CLI invocation whose mutation surfaces are not all inside
 * `root`. This runs before the child process starts, so the real file is never opened.
 */
export const assertDestructiveIsolation = (
  command: string,
  roots: readonly string[],
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = osPlatform(),
  cwd: string = process.cwd(),
  commandArguments: readonly string[] = [],
): void => {
  if (!DESTRUCTIVE_COMMANDS.has(command)) return;
  // Explicit roots exist for callers outside the fixture; inside it, only directories a
  // test actually created are trusted. With no root at all, nothing is writable.
  const trusted = roots.length > 0 ? roots : registeredRoots();
  for (const surface of configuredPaths(
    environment,
    platform,
    cwd,
    command,
    commandArguments,
  ))
    if (!trusted.some((root) => inside(surface.path, root, platform, cwd)))
      throw new ConfigIsolationError(
        command,
        `${surface.client} ${surface.kind} ${surface.path}`,
        trusted.join(", ") || "(no owned root)",
      );
};

/**
 * Resolve symlinks and junctions before the containment check. A link inside a trusted
 * root that points outside it must fail, not pass on its spelling.
 */
const resolveExisting = (
  path: string,
  platform: NodeJS.Platform,
  cwd: string,
): string | undefined => {
  const paths = platform === "win32" ? win32 : posix;
  const absolute = absoluteCallerPath(path, { cwd, platform });
  const segments: string[] = [];
  let current = absolute;
  for (let depth = 0; depth < 64; depth += 1) {
    try {
      // Resolve the deepest ancestor that exists, then re-attach the segments that do
      // not exist yet: returning the ancestor alone would compare the wrong path.
      return paths.join(realpathSync(current), ...segments.reverse());
    } catch (cause) {
      if (!isMissingPath(cause)) return undefined;
      try {
        // lstat sees a dangling link even though realpath cannot resolve its target.
        // Reconstructing that spelling from an in-root ancestor would hide the escape.
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
