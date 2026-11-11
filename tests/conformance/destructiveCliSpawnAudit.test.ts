import { readFile, glob } from "node:fs/promises";
import { basename, delimiter, join } from "node:path";
import ts from "typescript6";
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
  // Its dead rea.mjs path is ownership-fixture data; actual setup runs use the
  // cliTest fixture, which checks isolation before spawning and owns the temp home.
  "tests/acceptance/setup/setupDualTableOwnership.test.ts",
];

/** Application-level lifecycle tests do not start the CLI at all. */
const APPLICATION_ONLY = ["tests/boundary/filesystem/clientLifecycle.test.ts"];

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

const codeWithoutComments = (source: string): string => {
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    false,
    ts.LanguageVariant.Standard,
    source,
  );
  const tokens: string[] = [];
  for (
    let kind = scanner.scan();
    kind !== ts.SyntaxKind.EndOfFileToken;
    kind = scanner.scan()
  ) {
    if (
      kind === ts.SyntaxKind.SingleLineCommentTrivia ||
      kind === ts.SyntaxKind.MultiLineCommentTrivia
    )
      continue;
    tokens.push(scanner.getTokenText());
  }
  return tokens.join(" ");
};

it("ignores comment prose while retaining template-literal command tokens", () => {
  const prose = codeWithoutComments("// `setup` in prose mentions rea.mjs");
  expect(destructiveSpawn.test(prose)).toBe(false);
  expect(destructiveVerb.test(prose)).toBe(false);

  const arguments_ = codeWithoutComments(
    "const args = [`setup`]; const entry = `rea.mjs`;",
  );
  expect(destructiveSpawn.test(arguments_)).toBe(true);
  expect(destructiveVerb.test(arguments_)).toBe(true);
});

const candidates = async (): Promise<readonly string[]> => {
  const found: string[] = [];
  for await (const entry of glob("tests/**/*.{ts,mjs}", {
    cwd: process.cwd(),
  })) {
    if (entry.includes("node_modules")) continue;
    const source = await readFile(join(process.cwd(), entry), "utf8");
    if (!destructiveSpawn.test(source) || !destructiveVerb.test(source))
      continue;
    const text = codeWithoutComments(source);
    if (destructiveSpawn.test(text) && destructiveVerb.test(text))
      found.push(entry.replaceAll("\\", "/"));
  }
  return found.sort();
};

it("accounts for every test that can start a destructive CLI", async () => {
  const found = await candidates();
  const accounted = new Set([...FIXTURE_GUARDED, ...APPLICATION_ONLY]);
  const unaccounted = found.filter((entry) => !accounted.has(entry));
  // Anything not on the reviewed fixture list must carry an isolation marker below.
  for (const entry of unaccounted) {
    const text = codeWithoutComments(
      await readFile(join(process.cwd(), entry), "utf8"),
    );
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

it("keeps application-only lifecycle tests free of CLI spawn entrypoints", async () => {
  const cliEntryPoint =
    /\b(?:spawn|spawnSync|execFile|execFileSync|execa|cliTest|createTestCli)\s*\(|\bcli\.run\s*\(/u;
  for (const entry of APPLICATION_ONLY) {
    const text = codeWithoutComments(
      await readFile(join(process.cwd(), entry), "utf8"),
    );
    expect(text, `${entry} must not start the CLI`).not.toMatch(cliEntryPoint);
    expect(text, `${entry} must not import child_process`).not.toContain(
      "node:child_process",
    );
  }
});

it("a managed test run declares only the root it created", async () => {
  const declared = process.env.REA_TEST_ISOLATION_ROOTS;
  const runRoot = process.env.REA_TEST_ISOLATION_RUN_ROOT;
  expect(
    declared,
    "REA_TEST_ISOLATION_ROOTS is missing: this suite ran outside the managed test entry",
  ).toBeTruthy();
  expect(
    runRoot,
    "REA_TEST_ISOLATION_RUN_ROOT is missing: the run did not create its own root",
  ).toBeTruthy();
  // The declared root is this run's own directory, not the whole OS temp directory: a
  // sibling process writing elsewhere in temp must not be treated as test-owned.
  const roots = (declared ?? "").split(delimiter);
  expect(roots).toEqual([runRoot]);
  expect(basename(runRoot ?? "")).toMatch(/^rea-test-run-/u);
});
