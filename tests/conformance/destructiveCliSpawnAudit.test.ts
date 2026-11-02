import { readFile, glob, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { expect, it } from "vitest";

/**
 * A test that starts the CLI with a destructive subcommand must either go through the
 * guarded fixture or declare its isolation roots to the child. This audit keeps the
 * denominator honest: a new direct spawn shows up here as a failure instead of silently
 * becoming an unguarded path that edits a developer's real client configuration.
 */
const FIXTURE_GUARDED = [
  "tests/acceptance/setup/duplicateJsonMemberSetup.test.ts",
  "tests/acceptance/setup/hermesAnchoredEntrySetup.test.ts",
  "tests/acceptance/setup/launcherAliasesCli.test.ts",
  "tests/acceptance/setup/piClientSetup.test.ts",
  "tests/acceptance/setup/qwenProfileSetup.test.ts",
  "tests/acceptance/setup/registrationOwnershipSetup.test.ts",
  "tests/acceptance/setup/registrationRuntimeEnvironmentCli.test.ts",
];

/**
 * Direct spawns. Each must carry a marker that proves the child cannot reach a real
 * configuration: declared roots, a dry run, or a command that writes nothing.
 */
const DIRECT_SPAWN_MARKERS = [
  "REA_TEST_ISOLATION_ROOTS",
  "--dry-run",
  "--help",
] as const;

const destructiveSpawn = /rea\.mjs/;
const destructiveVerb = /["'`](setup|uninstall|update)["'`]/;

const candidates = async (): Promise<readonly string[]> => {
  const found: string[] = [];
  for await (const entry of glob("tests/**/*.{ts,mjs}", {
    cwd: process.cwd(),
  })) {
    if (entry.includes("node_modules")) continue;
    const text = await readFile(join(process.cwd(), entry), "utf8");
    if (destructiveSpawn.test(text) && destructiveVerb.test(text))
      found.push(entry.replaceAll("\\", "/"));
  }
  return found.sort();
};

it("accounts for every test that can start a destructive CLI", async () => {
  const found = await candidates();
  const accounted = new Set(FIXTURE_GUARDED);
  const unaccounted = found.filter((entry) => !accounted.has(entry));
  // Anything not on the reviewed fixture list must carry an isolation marker below.
  for (const entry of unaccounted) {
    const text = await readFile(join(process.cwd(), entry), "utf8");
    const marked = DIRECT_SPAWN_MARKERS.some((marker) => text.includes(marker));
    expect(
      marked,
      `${entry} can start a destructive CLI without a guarded fixture or an isolation marker`,
    ).toBe(true);
  }
});

it("keeps the reviewed fixture list free of removed files", async () => {
  const found = new Set(await candidates());
  for (const entry of FIXTURE_GUARDED)
    expect(found.has(entry), `${entry} no longer spawns the CLI`).toBe(true);
});

it("a managed test run declares the roots a destructive CLI may write inside", async () => {
  const declared = process.env.REA_TEST_ISOLATION_ROOTS;
  expect(
    declared,
    "REA_TEST_ISOLATION_ROOTS is missing: this suite ran outside the managed test entry",
  ).toBeTruthy();
  const canonical = await realpath(tmpdir());
  expect(declared?.split(delimiter)).toContain(canonical);
});
