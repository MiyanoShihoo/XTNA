import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { platform as osPlatform } from "node:os";

import { supportedClients } from "../../../src/application/SupportedClients.js";

/**
 * Every environment variable that can redirect a client configuration, skill or
 * marker path. A test that inherits one of these from the developer's shell points the
 * product at a real file, so a destructive command (`setup`, `uninstall`, `update`) can
 * edit or delete a live configuration.
 *
 * The list is derived from `src/application/SupportedClients.ts`; when that file starts
 * honouring another override, add it here too — `CONFIG_REDIRECT_KEYS` is asserted against
 * the resolver below by the negative test.
 */
export const CONFIG_REDIRECT_KEYS = [
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
  "HERMES_HOME",
  "KIMI_CODE_HOME",
  "OMP_PROFILE",
  "OPENCODE_CONFIG",
  "OPENCODE_CONFIG_DIR",
  "PI_CODING_AGENT_DIR",
  "PI_CONFIG_DIR",
  "PI_PROFILE",
  "QODER_CONFIG_DIR",
  "QWEN_HOME",
  "SAND_DATA_ROOT",
  "VSCODE_APPDATA",
  "VSCODE_PORTABLE",
  "XDG_CONFIG_HOME",
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
        `A configuration path from the ambient environment reached this process. ` +
        `Choose a temporary root and set every ${CONFIG_REDIRECT_KEYS.join("/")} value inside it.`,
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
const fold = (path: string): string =>
  osPlatform() === "win32" ? path.toLowerCase() : path;

const inside = (path: string, root: string): boolean => {
  const target = fold(resolve(path));
  const base = fold(resolve(root));
  return (
    target === base ||
    target.startsWith(`${base}\\`) ||
    target.startsWith(`${base}/`)
  );
};

/** Every configuration surface the product would read or write for this environment. */
export const configuredPaths = (
  root: string,
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = osPlatform(),
): readonly { readonly client: string; readonly path: string }[] => {
  const home = environment.HOME ?? environment.USERPROFILE ?? root;
  return supportedClients(home, platform, environment).flatMap((client) => {
    const paths = [client.configPath, ...(client.configPaths ?? [])];
    return paths
      .filter((value): value is string => typeof value === "string")
      .map((value) => ({ client: client.name, path: value }));
  });
};

/**
 * Refuse a destructive CLI invocation whose configuration surfaces are not all inside
 * `root`. This runs before the child process starts, so the real file is never opened.
 */
export const assertDestructiveIsolation = (
  command: string,
  roots: readonly string[],
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = osPlatform(),
): void => {
  if (!DESTRUCTIVE_COMMANDS.has(command)) return;
  // A non-absolute override is rejected by the product with its own diagnostic (for
  // example "absolute HERMES_HOME"). Resolving it here would replace that message with an
  // isolation refusal, so leave the whole invocation to the product in that case.
  if (
    CONFIG_REDIRECT_KEYS.some((key) => {
      const value = environment[key];
      return (
        typeof value === "string" && value.trim() !== "" && !isAbsolute(value)
      );
    })
  )
    return;
  // Explicit roots exist for callers outside the fixture; inside it, only directories a
  // test actually created are trusted. With no root at all, nothing is writable.
  const trusted = roots.length > 0 ? roots : registeredRoots();
  for (const surface of configuredPaths(
    environment.HOME ?? environment.USERPROFILE ?? ".",
    environment,
    platform,
  ))
    // A relative or unresolved value is not a real location: the product rejects it on
    // its own terms, and policing it here would hide that diagnostic.
    if (
      isAbsolute(surface.path) &&
      !trusted.some((root) => inside(resolveExisting(surface.path), root))
    )
      throw new ConfigIsolationError(
        command,
        `${surface.client} config ${surface.path}`,
        trusted.join(", ") || "(no owned root)",
      );
};

/**
 * Resolve symlinks and junctions before the containment check. A link inside a trusted
 * root that points outside it must fail, not pass on its spelling.
 */
const resolveExisting = (path: string): string => {
  const absolute = resolve(path);
  const segments: string[] = [];
  let current = absolute;
  for (let depth = 0; depth < 64; depth += 1) {
    try {
      // Resolve the deepest ancestor that exists, then re-attach the segments that do
      // not exist yet: returning the ancestor alone would compare the wrong path.
      return join(realpathSync(current), ...segments.reverse());
    } catch {
      const parent = dirname(current);
      if (parent === current) return absolute;
      segments.push(basename(current));
      current = parent;
    }
  }
  return absolute;
};
