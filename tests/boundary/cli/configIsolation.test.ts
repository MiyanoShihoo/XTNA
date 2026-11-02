import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { symlink } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import {
  assertDestructiveIsolation,
  ConfigIsolationError,
  configuredPaths,
} from "../../support/cli/configIsolation.js";
import { cliTest } from "../../support/cli/cliFixture.js";

const CANARY = "rea-mcp: { command: keep-this-entry }\n";

/**
 * A test process inherits the developer's environment. If a redirect such as DSH_HOME is
 * set there, `setup`/`uninstall` would edit a live configuration even though HOME points
 * at a temporary directory. These cases prove the guard refuses before the child starts.
 */
cliTest(
  "refuses a destructive command whose config surface escapes the test root",
  async ({ cli }) => {
    const home = await createTestTempDirectory("rea-isolation-home-");
    // A sibling of the OS temp directory: outside every root the harness allows, and
    // never created because the guard refuses before the child process starts.
    const outside = join(tmpdir(), "..", "rea-isolation-outside", ".dsh");
    const canary = join(outside, "cordis.patch.yml");

    await expect(
      cli.run({
        arguments: ["uninstall", "--json"],
        cwd: home,
        environment: {
          HOME: home,
          USERPROFILE: home,
          DSH_HOME: outside,
        },
      }),
    ).rejects.toBeInstanceOf(ConfigIsolationError);

    // Nothing was spawned, so the path was never created.
    expect(existsSync(canary)).toBe(false);
  },
);

cliTest(
  "allows a destructive command whose config surfaces stay inside the test root",
  async ({ cli }) => {
    const home = await createTestTempDirectory("rea-isolation-home-");
    await expect(
      cli.run({
        arguments: ["uninstall", "--json"],
        cwd: home,
        environment: {
          HOME: home,
          USERPROFILE: home,
          DSH_HOME: join(home, ".dsh"),
        },
      }),
    ).resolves.toMatchObject({ exitCode: expect.any(Number) });
  },
);

it("reports every configuration surface the product would touch", async () => {
  const home = await createTestTempDirectory("rea-isolation-surfaces-");
  const surfaces = configuredPaths(
    home,
    { HOME: home, USERPROFILE: home },
    "win32",
  );
  expect(surfaces.length).toBeGreaterThan(10);
  for (const surface of surfaces)
    expect(surface.path.startsWith(home)).toBe(true);
});

it("refuses when only one of several surfaces escapes", async () => {
  const home = await createTestTempDirectory("rea-isolation-single-");
  expect(() =>
    assertDestructiveIsolation(
      "setup",
      [home],
      {
        HOME: home,
        USERPROFILE: home,
        CLAUDE_CONFIG_DIR: "C:\\Users\\somebody\\.claude",
      },
      "win32",
    ),
  ).toThrow(ConfigIsolationError);
});

it("does not police read-only commands", () => {
  expect(() =>
    assertDestructiveIsolation(
      "doctor",
      ["C:\\\\only"],
      { HOME: "/tmp/only", DSH_HOME: "/somewhere/else" },
      "win32",
    ),
  ).not.toThrow();
});

it("compares Windows paths case-insensitively", () => {
  const root = "C:\\Temp\\Rea-Root";
  expect(() =>
    assertDestructiveIsolation(
      "setup",
      [root],
      {
        HOME: "c:\\temp\\rea-root",
        USERPROFILE: "C:\\TEMP\\REA-ROOT",
        APPDATA: "C:\\TEMP\\REA-ROOT\\AppData\\Roaming",
        LOCALAPPDATA: "C:\\TEMP\\REA-ROOT\\AppData\\Local",
      },
      "win32",
    ),
  ).not.toThrow();
});

it("refuses a symbolic link inside a trusted root that resolves outside it", async () => {
  const root = await createTestTempDirectory("rea-isolation-link-root-");
  const outside = await createTestTempDirectory("rea-isolation-link-target-");
  const link = join(root, "dsh");
  await symlink(outside, link, "junction");
  expect(() =>
    assertDestructiveIsolation(
      "setup",
      [root],
      { HOME: root, USERPROFILE: root, DSH_HOME: link },
      "win32",
    ),
  ).toThrow(ConfigIsolationError);
});

it("allows a not-yet-created path beneath a trusted root", async () => {
  const root = await createTestTempDirectory("rea-isolation-new-");
  expect(() =>
    assertDestructiveIsolation(
      "setup",
      [root],
      { HOME: root, USERPROFILE: root, DSH_HOME: join(root, "fresh", ".dsh") },
      "win32",
    ),
  ).not.toThrow();
});

it("leaves a relative redirect to the product to reject", () => {
  expect(() =>
    assertDestructiveIsolation(
      "setup",
      ["C:\\\\only"],
      {
        HOME: "C:\\\\only",
        USERPROFILE: "C:\\\\only",
        APPDATA: "C:\\\\only\\\\appdata",
        LOCALAPPDATA: "C:\\\\only\\\\local",
        HERMES_HOME: "relative/profile",
      },
      "win32",
    ),
  ).not.toThrow();
});
