import { resolve } from "node:path";
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

const inside = (path: string, root: string): boolean => {
  const target = resolve(path);
  const base = resolve(root);
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
  const home = environment.HOME ?? environment.USERPROFILE ?? roots[0] ?? ".";
  for (const surface of configuredPaths(home, environment, platform))
    if (!roots.some((root) => inside(surface.path, root)))
      throw new ConfigIsolationError(
        command,
        `${surface.client} config ${surface.path}`,
        roots.join(", "),
      );
};
