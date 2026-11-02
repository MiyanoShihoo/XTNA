import { isAbsolute, resolve } from "node:path";

import { supportedClients } from "../application/SupportedClients.js";

/** Names one or more roots a test run owns; absent outside a test run. */
export const TEST_ISOLATION_ROOTS_VARIABLE = "REA_TEST_ISOLATION_ROOTS";

/** Commands that can create, rewrite, move or delete a client's files. */
const DESTRUCTIVE_COMMANDS: ReadonlySet<string> = new Set([
  "setup",
  "uninstall",
  "update",
]);

const fold = (path: string, platform: NodeJS.Platform): string =>
  platform === "win32" ? path.toLowerCase() : path;

const inside = (
  path: string,
  root: string,
  platform: NodeJS.Platform,
): boolean => {
  const target = fold(resolve(path), platform);
  const base = fold(resolve(root), platform);
  return (
    target === base ||
    target.startsWith(`${base}\\`) ||
    target.startsWith(`${base}/`)
  );
};

const rootsFrom = (raw: string, platform: NodeJS.Platform): readonly string[] =>
  raw
    .split(platform === "win32" ? ";" : ":")
    .map((value) => value.trim())
    .filter((value) => value !== "" && isAbsolute(value))
    .map((value) => resolve(value));

export class TestIsolationViolation extends Error {
  constructor(
    readonly command: string,
    readonly surface: string,
    readonly roots: readonly string[],
  ) {
    super(
      `Refusing \`${command}\` under test isolation: ${surface} is outside ${roots.join(", ") || "(no root)"}. ` +
        `This process was started by a test run that declared isolated roots; a configuration path from the ambient environment reached it.`,
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
): void => {
  if (!DESTRUCTIVE_COMMANDS.has(command)) return;
  const raw = environment[TEST_ISOLATION_ROOTS_VARIABLE];
  if (raw === undefined || raw.trim() === "") return;
  const roots = rootsFrom(raw, platform);
  const home = environment.HOME ?? environment.USERPROFILE ?? "";
  for (const client of supportedClients(home, platform, environment))
    for (const surface of [client.configPath, ...(client.configPaths ?? [])]) {
      // A relative or unresolved value is rejected by the command itself with a specific
      // diagnostic; overriding that message with an isolation refusal would hide the cause.
      if (typeof surface !== "string" || !isAbsolute(surface)) continue;
      if (!roots.some((root) => inside(surface, root, platform)))
        throw new TestIsolationViolation(command, surface, roots);
    }
};
