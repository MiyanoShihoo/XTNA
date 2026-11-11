import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { expect, it, onTestFinished } from "vitest";

import {
  clientSkillDirectories,
  clientUninstallConfigurationPaths,
  supportedClients,
} from "../../../src/application/SupportedClients.js";
import { CLAUDE_DESKTOP_PACKAGE_FAMILY } from "../../../src/application/ClaudeDesktopConfigLocation.js";
import { skillDestinationSelection } from "../../../src/application/SetupSkill.js";
import { PRODUCT_IDENTITY } from "../../../src/identity.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import {
  assertDestructiveIsolation,
  CONFIG_REDIRECT_KEYS,
  ConfigIsolationError,
  configuredPaths,
} from "../../support/cli/configIsolation.js";
import { cliTest } from "../../support/cli/cliFixture.js";

const CANARY = "rea-mcp: { command: keep-this-entry }\n";

const createExternalTestDirectory = async (label: string): Promise<string> => {
  const directory = await mkdtemp(
    join(tmpdir(), `rea-${label}-${randomUUID()}-`),
  );
  onTestFinished(async () => rm(directory, { recursive: true, force: true }));
  return directory;
};

it("names home and indirect path selectors in fail-closed diagnostics", async () => {
  const root = await createTestTempDirectory("rea-isolation-diagnostic-root-");
  const outside = join(tmpdir(), `rea-isolation-diagnostic-${randomUUID()}`);
  const environment = {
    HOME: outside,
    USERPROFILE: root,
    HOMEDRIVE: "Z:",
    HOMEPATH: "\\Users\\outside",
    APPDATA: join(outside, "AppData", "Roaming"),
    LOCALAPPDATA: join(outside, "AppData", "Local"),
    HERMES_DATA_DIR_SUFFIX: "-test",
    VSCODE_CWD: "editor-cwd",
  };
  const expectedKeys = [
    "HOME",
    "USERPROFILE",
    "HOMEDRIVE",
    "HOMEPATH",
    "VSCODE_CWD",
    "APPDATA",
    "LOCALAPPDATA",
    "HERMES_DATA_DIR_SUFFIX",
    "XDG_CACHE_HOME",
  ];
  expect(CONFIG_REDIRECT_KEYS).toEqual(expect.arrayContaining(expectedKeys));

  let diagnostic = "";
  try {
    assertDestructiveIsolation("setup", [root], environment, "linux", root);
  } catch (cause) {
    if (!(cause instanceof ConfigIsolationError)) throw cause;
    diagnostic = cause.message;
  }
  expect(diagnostic).not.toBe("");
  for (const key of expectedKeys) expect(diagnostic).toContain(key);
});

/**
 * A test process inherits the developer's environment. If a redirect such as DSH_HOME is
 * set there, `setup`/`uninstall` would edit a live configuration even though HOME points
 * at a temporary directory. These cases prove the guard refuses before the child starts.
 */
cliTest(
  "refuses setup and uninstall when DSH_AGENTS_HOME escapes the test root",
  async ({ cli }) => {
    const home = await createTestTempDirectory("rea-isolation-home-");
    const outside = join(tmpdir(), `rea-isolation-dsh-${randomUUID()}`);
    for (const command of ["setup", "uninstall"] as const)
      await expect(
        cli.run({
          arguments: [command, "--json"],
          cwd: home,
          environment: {
            HOME: "",
            USERPROFILE: home,
            DSH_AGENTS_HOME: outside,
          },
        }),
      ).rejects.toMatchObject({
        command,
        offender: expect.stringContaining("skill"),
      });
    expect(existsSync(outside)).toBe(false);
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
          HOME: "",
          USERPROFILE: home,
          DSH_HOME: join(home, ".dsh"),
          DSH_AGENTS_HOME: join(home, ".agents-dsh"),
        },
      }),
    ).resolves.toMatchObject({ exitCode: expect.any(Number) });
  },
);

it("reports every configuration surface the product would touch", async () => {
  const home = await createTestTempDirectory("rea-isolation-surfaces-");
  const environment = {
    HOME: "",
    USERPROFILE: home,
    DSH_AGENTS_HOME: join(home, ".agents-dsh"),
    QWEN_HOME: join(home, ".qwen-custom"),
    VSCODE_PORTABLE: join(home, "vscode-portable"),
  };
  const surfaces = configuredPaths(environment, process.platform, home);
  expect(
    surfaces.filter(({ kind }) => kind === "config").length,
  ).toBeGreaterThan(10);
  for (const surface of surfaces)
    expect(surface.path.startsWith(home)).toBe(true);

  const directories = clientSkillDirectories(
    home,
    undefined,
    environment,
    process.platform,
    home,
  ).directories;
  expect(directories.some(({ client }) => client === "shared")).toBe(true);
  expect(
    directories.some(
      ({ client, directory }) =>
        client === "dsh" && directory.startsWith(environment.DSH_AGENTS_HOME),
    ),
  ).toBe(true);
  for (const { directory } of directories)
    expect(surfaces).toContainEqual(
      expect.objectContaining({ kind: "skill", path: directory }),
    );

  const productDestinations = skillDestinationSelection(
    home,
    undefined,
    environment,
    process.platform,
  ).destinations;
  expect(productDestinations.length).toBeGreaterThan(5);
  for (const { path } of productDestinations)
    expect(surfaces).toContainEqual(
      expect.objectContaining({ kind: "skill", path }),
    );
  expect(
    productDestinations.some(({ path }) =>
      path.includes(PRODUCT_IDENTITY.skillName),
    ),
  ).toBe(true);
});

it("guards the Linux Hopper cache only for purge and Hopper installation", async () => {
  const home = await createTestTempDirectory("rea-isolation-hopper-home-");
  const outside = join(tmpdir(), `rea-isolation-hopper-cache-${randomUUID()}`);
  const environment = {
    HOME: "",
    USERPROFILE: home,
    XDG_CACHE_HOME: outside,
  };
  const cachePath = join(outside, "rea", "hopper-releases");
  const ordinarySetup = configuredPaths(environment, "linux", home, "setup");
  const ordinaryUninstall = configuredPaths(
    environment,
    "linux",
    home,
    "uninstall",
  );
  expect(
    [...ordinarySetup, ...ordinaryUninstall].some(
      ({ client, kind }) => client === "hopper" && kind === "cache",
    ),
  ).toBe(false);
  expect(
    configuredPaths(environment, "linux", home, "uninstall", ["--purge-data"]),
  ).toContainEqual({ client: "hopper", kind: "cache", path: cachePath });
  expect(
    configuredPaths(environment, "linux", home, "uninstall", [
      "--purge-data=true",
    ]),
  ).toContainEqual({ client: "hopper", kind: "cache", path: cachePath });
  expect(
    configuredPaths(environment, "linux", home, "setup", ["--install-hopper"]),
  ).toContainEqual({ client: "hopper", kind: "cache", path: cachePath });
  expect(
    configuredPaths(environment, "linux", home, "setup", [
      "--install-hopper=true",
    ]),
  ).toContainEqual({ client: "hopper", kind: "cache", path: cachePath });
  for (const [command, commandArguments] of [
    ["uninstall", ["--purge-data=false"]],
    ["uninstall", ["--no-purge-data"]],
    ["uninstall", ["--purge-data", "false"]],
    ["setup", ["--install-hopper=false"]],
    ["setup", ["--no-install-hopper"]],
    ["setup", ["--install-hopper", "false"]],
    ["setup", ["--install-hopper", "--dry-run"]],
    ["setup", ["--install-hopper=true", "--dry-run=true"]],
  ] as const)
    expect(
      configuredPaths(environment, "linux", home, command, commandArguments),
    ).not.toContainEqual({ client: "hopper", kind: "cache", path: cachePath });

  expect(() =>
    assertDestructiveIsolation("setup", [home], environment, "linux", home),
  ).not.toThrow();
  expect(() =>
    assertDestructiveIsolation("uninstall", [home], environment, "linux", home),
  ).not.toThrow();
  expect(() =>
    assertDestructiveIsolation("setup", [home], environment, "linux", home, [
      "--install-hopper",
      "--dry-run",
    ]),
  ).not.toThrow();
  for (const [command, commandArguments] of [
    ["uninstall", ["--purge-data"]],
    ["uninstall", ["--purge-data=true"]],
    ["setup", ["--install-hopper"]],
    ["setup", ["--install-hopper=true"]],
  ] as const)
    expect(() =>
      assertDestructiveIsolation(
        command,
        [home],
        environment,
        "linux",
        home,
        commandArguments,
      ),
    ).toThrow(
      expect.objectContaining({
        command,
        offender: expect.stringContaining(`hopper cache ${cachePath}`),
      }),
    );
  expect(existsSync(outside)).toBe(false);
});

it("uses both Claude MSIX targets for uninstall containment", async () => {
  const home = await createTestTempDirectory("rea-isolation-claude-msix-");
  const roaming = join(home, "roaming");
  const local = join(home, "local");
  const packageDirectory = join(
    local,
    "Packages",
    CLAUDE_DESKTOP_PACKAGE_FAMILY,
  );
  await mkdir(packageDirectory, { recursive: true });
  const environment = {
    HOME: "",
    USERPROFILE: home,
    APPDATA: roaming,
    LOCALAPPDATA: local,
  };
  const claude = supportedClients(home, "win32", environment, home).find(
    ({ name }) => name === "claude_desktop",
  );
  expect(claude?.msixPackage).toBeDefined();
  if (claude?.msixPackage === undefined)
    throw new Error("Claude MSIX package metadata was not resolved");
  const privatePath = claude.msixPackage.privateConfigPath;
  const appDataPath = claude.msixPackage.appDataConfigPath;
  const setupSurfaces = configuredPaths(environment, "win32", home, "setup");
  const uninstallSurfaces = configuredPaths(
    environment,
    "win32",
    home,
    "uninstall",
  );
  expect(setupSurfaces).toContainEqual(
    expect.objectContaining({ client: "claude_desktop", path: privatePath }),
  );
  expect(
    setupSurfaces.some(
      ({ client, path }) => client === "claude_desktop" && path === appDataPath,
    ),
  ).toBe(false);
  expect(clientUninstallConfigurationPaths(claude)).toEqual(
    expect.arrayContaining([privatePath, appDataPath]),
  );
  expect(uninstallSurfaces).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        client: "claude_desktop",
        kind: "config",
        path: privatePath,
      }),
      expect.objectContaining({
        client: "claude_desktop",
        kind: "config",
        path: appDataPath,
      }),
    ]),
  );
});

it("rejects QWEN_HOME when a cwd-relative destination escapes the invocation root", async () => {
  const root = await createTestTempDirectory("rea-isolation-qwen-relative-");
  const outside = join(tmpdir(), `rea-isolation-qwen-${randomUUID()}`);
  const environment = {
    HOME: "",
    USERPROFILE: root,
    QWEN_HOME: relative(root, outside),
  };
  const paths = configuredPaths(environment, process.platform, root);
  expect(
    paths.some(({ path }) => resolve(root, path).startsWith(outside)),
  ).toBe(true);
  expect(() =>
    assertDestructiveIsolation(
      "setup",
      [root],
      environment,
      process.platform,
      root,
    ),
  ).toThrow(ConfigIsolationError);
  expect(existsSync(outside)).toBe(false);
});

it("resolves OMP and OpenCode relative overrides against the invocation cwd", async () => {
  const root = await createTestTempDirectory("rea-isolation-client-cwd-");
  const environment = {
    HOME: "",
    USERPROFILE: root,
    PI_CODING_AGENT_DIR: "omp-agent",
    OPENCODE_CONFIG: "explicit/opencode.json",
    OPENCODE_CONFIG_DIR: "opencode-profile",
  };
  const paths = configuredPaths(environment, process.platform, root);
  expect(
    paths.find(({ client, kind }) => client === "omp" && kind === "config")
      ?.path,
  ).toBe(join(root, "omp-agent", "mcp.json"));
  const openCodePaths = paths
    .filter(({ client, kind }) => client === "opencode" && kind === "config")
    .map(({ path }) => path);
  expect(openCodePaths).toContain(join(root, "explicit", "opencode.json"));
  expect(openCodePaths).toContain(
    join(root, "opencode-profile", "opencode.json"),
  );
  expect(openCodePaths).toContain(
    join(root, "opencode-profile", "opencode.jsonc"),
  );
  expect(() =>
    assertDestructiveIsolation(
      "setup",
      [root],
      environment,
      process.platform,
      root,
    ),
  ).not.toThrow();
});

it("refuses cwd-relative OMP and OpenCode overrides that escape the test root", async () => {
  const root = await createTestTempDirectory("rea-isolation-client-escape-");
  const outside = join(tmpdir(), `rea-isolation-client-${randomUUID()}`);
  const cases = [
    { PI_CODING_AGENT_DIR: relative(root, outside) },
    { OPENCODE_CONFIG: relative(root, `${outside}.json`) },
    { OPENCODE_CONFIG_DIR: relative(root, outside) },
  ];
  for (const overrides of cases)
    expect(() =>
      assertDestructiveIsolation(
        "setup",
        [root],
        { HOME: "", USERPROFILE: root, ...overrides },
        process.platform,
        root,
      ),
    ).toThrow(ConfigIsolationError);
  expect(existsSync(outside)).toBe(false);
  expect(existsSync(`${outside}.json`)).toBe(false);
});

it.skipIf(process.platform !== "linux")(
  "inner guard rejects a POSIX backslash sibling outside its test root",
  async () => {
    const root = await createTestTempDirectory(
      "rea-isolation-posix-backslash-",
    );
    const escapedRoot = `${root}\\escape`;
    expect(() =>
      assertDestructiveIsolation(
        "setup",
        [root],
        { HOME: "", USERPROFILE: root, CODEX_HOME: escapedRoot },
        "linux",
        root,
      ),
    ).toThrow(ConfigIsolationError);
    expect(existsSync(escapedRoot)).toBe(false);
  },
);

it("includes unresolved skill paths in containment evidence and refuses escape", async () => {
  const root = await createTestTempDirectory("rea-isolation-unresolved-skill-");
  const unresolvedPath = `~rea-unknown-${randomUUID()}/../../rea-outside-${randomUUID()}`;
  const environment = {
    HOME: "",
    USERPROFILE: root,
    HERMES_HOME: unresolvedPath,
  };
  const resolution = clientSkillDirectories(
    root,
    undefined,
    environment,
    process.platform,
    root,
  );
  expect(resolution.unresolved).toContainEqual(
    expect.objectContaining({ client: "hermes", path: unresolvedPath }),
  );
  expect(configuredPaths(environment, process.platform, root)).toContainEqual(
    expect.objectContaining({
      client: "hermes",
      kind: "skill",
      path: unresolvedPath,
    }),
  );
  expect(() =>
    assertDestructiveIsolation(
      "setup",
      [root],
      environment,
      process.platform,
      root,
    ),
  ).toThrow(ConfigIsolationError);
});

it("resolves relative VSCODE_CWD paths against the invocation cwd", async () => {
  const root = await createTestTempDirectory("rea-isolation-vscode-cwd-");
  const environment = {
    HOME: "",
    USERPROFILE: root,
    VSCODE_CWD: "editor-cwd",
    VSCODE_PORTABLE: "../vscode-portable",
  };
  const vscode = configuredPaths(environment, process.platform, root).find(
    ({ client, kind }) => client === "vscode" && kind === "config",
  );
  expect(vscode?.path).toBe(
    join(root, "vscode-portable", "user-data", "User", "mcp.json"),
  );
  expect(() =>
    assertDestructiveIsolation(
      "setup",
      [root],
      environment,
      process.platform,
      root,
    ),
  ).not.toThrow();
});

it("refuses when only one of several surfaces escapes", async () => {
  const home = await createTestTempDirectory("rea-isolation-single-");
  expect(() =>
    assertDestructiveIsolation("setup", [home], {
      HOME: home,
      USERPROFILE: home,
      CLAUDE_CONFIG_DIR: join(
        tmpdir(),
        "rea-isolation-single-outside",
        ".claude",
      ),
    }),
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

it.skipIf(process.platform !== "win32")(
  "compares Windows paths case-insensitively",
  () => {
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
  },
);

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
      process.platform,
    ),
  ).toThrow(ConfigIsolationError);
});

it.skipIf(process.platform === "win32")(
  "refuses setup and uninstall when an in-root dangling config link targets a missing external file",
  async () => {
    const root = await createTestTempDirectory("rea-isolation-dangling-root-");
    const outside = await createTestTempDirectory(
      "rea-isolation-dangling-outside-",
    );
    const externalTarget = join(outside, "not-created.json");
    const link = join(root, "opencode.json");
    await symlink(externalTarget, link);
    const environment = {
      HOME: "",
      USERPROFILE: root,
      OPENCODE_CONFIG: link,
    };

    for (const command of ["setup", "uninstall"] as const)
      expect(() =>
        assertDestructiveIsolation(
          command,
          [root],
          environment,
          process.platform,
          root,
        ),
      ).toThrow(ConfigIsolationError);
    expect(existsSync(externalTarget)).toBe(false);
  },
);

it.skipIf(process.platform === "win32")(
  "refuses setup when a selected skill directory is a dangling external link",
  async () => {
    const root = await createTestTempDirectory(
      "rea-isolation-skill-link-root-",
    );
    const outside = await createTestTempDirectory(
      "rea-isolation-skill-link-outside-",
    );
    const externalTarget = join(outside, "not-created-skill-directory");
    const link = join(root, ".agents", "skills");
    await mkdir(join(root, ".agents"), { recursive: true });
    await symlink(externalTarget, link);
    const environment = { HOME: "", USERPROFILE: root };

    expect(() =>
      assertDestructiveIsolation(
        "setup",
        [root],
        environment,
        process.platform,
        root,
      ),
    ).toThrow(ConfigIsolationError);
    expect(existsSync(externalTarget)).toBe(false);
  },
);

it("includes ZCode's externally redirected same-scope fallback as a config surface", async () => {
  const root = await createTestTempDirectory("rea-isolation-zcode-root-");
  const outside = await createTestTempDirectory("rea-isolation-zcode-outside-");
  await symlink(
    outside,
    join(root, ".agents"),
    process.platform === "win32" ? "junction" : "dir",
  );
  const environment = { HOME: "", USERPROFILE: root };
  const fallback = join(root, ".agents", "mcp.json");
  const surfaces = configuredPaths(environment, process.platform, root);

  expect(surfaces).toContainEqual({
    client: "zcode",
    kind: "config",
    path: fallback,
  });
  for (const command of ["setup", "uninstall"] as const)
    expect(() =>
      assertDestructiveIsolation(
        command,
        [root],
        environment,
        process.platform,
        root,
      ),
    ).toThrow(
      expect.objectContaining({
        command,
        offender: expect.stringContaining("zcode config"),
      }),
    );
  expect(existsSync(join(outside, "mcp.json"))).toBe(false);
});

it("allows a not-yet-created path beneath a trusted root", async () => {
  const root = await createTestTempDirectory("rea-isolation-new-");
  expect(() =>
    assertDestructiveIsolation(
      "setup",
      [root],
      { HOME: root, USERPROFILE: root, DSH_HOME: join(root, "fresh", ".dsh") },
      process.platform,
    ),
  ).not.toThrow();
});

it("CLI guard refuses DSH_AGENTS_HOME outside its root for setup and uninstall", async () => {
  const root = await createTestTempDirectory("rea-cli-guard-dsh-");
  const outside = join(tmpdir(), `rea-cli-guard-dsh-${randomUUID()}`);
  for (const command of ["setup", "uninstall"] as const) {
    const result = spawnSync(
      process.execPath,
      [resolve("scripts/rea.mjs"), command, "--json"],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          PATH: process.env.PATH ?? "",
          SystemRoot: process.env.SystemRoot,
          HOME: "",
          USERPROFILE: root,
          DSH_AGENTS_HOME: outside,
          REA_TEST_ISOLATION_ROOTS: root,
        },
      },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      `Refusing \`${command}\` under test isolation`,
    );
    expect(result.stderr).toContain("skill");
  }
  expect(existsSync(outside)).toBe(false);
});

it("CLI guard resolves QWEN_HOME relative to its cwd and refuses escape", async () => {
  const root = await createTestTempDirectory("rea-cli-guard-qwen-");
  const outside = join(tmpdir(), `rea-cli-guard-qwen-${randomUUID()}`);
  const result = spawnSync(
    process.execPath,
    [resolve("scripts/rea.mjs"), "setup", "--json"],
    {
      cwd: root,
      encoding: "utf8",
      env: {
        PATH: process.env.PATH ?? "",
        SystemRoot: process.env.SystemRoot,
        HOME: "",
        USERPROFILE: root,
        QWEN_HOME: relative(root, outside),
        REA_TEST_ISOLATION_ROOTS: root,
      },
    },
  );
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("Refusing `setup` under test isolation");
  expect(result.stderr).toContain(outside);
  expect(existsSync(outside)).toBe(false);
});

it.skipIf(process.platform !== "linux")(
  "outer CLI guard rejects a POSIX backslash sibling outside its test root",
  async () => {
    const root = await createTestTempDirectory(
      "rea-cli-guard-posix-backslash-",
    );
    const escapedRoot = `${root}\\escape`;
    const result = spawnSync(
      process.execPath,
      [resolve("scripts/rea.mjs"), "setup", "--json"],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          PATH: process.env.PATH ?? "",
          SystemRoot: process.env.SystemRoot,
          HOME: "",
          USERPROFILE: root,
          CODEX_HOME: escapedRoot,
          REA_TEST_ISOLATION_ROOTS: root,
        },
      },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Refusing `setup` under test isolation");
    expect(result.stderr).toContain(escapedRoot);
    expect(existsSync(escapedRoot)).toBe(false);
  },
);

it("CLI guard refuses Hopper cache purge and installation in bare and equals forms", async () => {
  const home = await createTestTempDirectory("rea-cli-guard-hopper-home-");
  const outside = await createExternalTestDirectory("cli-guard-hopper");
  const cachePath = join(outside, "rea", "hopper-releases");
  const marker = join(cachePath, "keep.txt");
  const markerContents = "test-owned Hopper cache marker\n";
  await mkdir(cachePath, { recursive: true });
  await writeFile(marker, markerContents);

  const baseEnvironment = {
    PATH: process.env.PATH ?? "",
    SystemRoot: process.env.SystemRoot,
    HOME: home,
    USERPROFILE: home,
    XDG_CACHE_HOME: outside,
    REA_TEST_ISOLATION_ROOTS: home,
  };
  const invocations = [
    ["uninstall", "--purge-data", "--json"],
    ["uninstall", "--purge-data=true", "--json"],
    ["setup", "--install-hopper", "--yes", "--json"],
    ["setup", "--install-hopper=true", "--yes", "--json"],
  ] as const;
  for (const arguments_ of invocations) {
    const command = arguments_[0];
    const result = spawnSync(
      process.execPath,
      [resolve("scripts/rea.mjs"), ...arguments_],
      {
        cwd: home,
        encoding: "utf8",
        env: baseEnvironment,
      },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      `Refusing \`${command}\` under test isolation`,
    );
    expect(result.stderr).toContain(`hopper cache ${cachePath}`);
  }
  expect(existsSync(marker)).toBe(true);
  expect(await readFile(marker, "utf8")).toBe(markerContents);
});

it("CLI guard follows Hopper dry-run and boolean false semantics", async () => {
  const home = await createTestTempDirectory("rea-cli-guard-hopper-dry-run-");
  const outside = await createExternalTestDirectory("cli-guard-hopper-dry-run");
  const cachePath = join(outside, "rea", "hopper-releases");
  const marker = join(cachePath, "keep.txt");
  const markerContents = "test-owned Hopper cache marker\n";
  await mkdir(cachePath, { recursive: true });
  await writeFile(marker, markerContents);

  const environment = {
    PATH: process.env.PATH ?? "",
    SystemRoot: process.env.SystemRoot,
    HOME: home,
    USERPROFILE: home,
    XDG_CACHE_HOME: outside,
    REA_TEST_ISOLATION_ROOTS: home,
  };
  const script = resolve("scripts/rea.mjs");
  const run = (...arguments_: string[]) =>
    spawnSync(process.execPath, [script, ...arguments_], {
      cwd: home,
      encoding: "utf8",
      env: environment,
    });

  const dryRun = run("setup", "--install-hopper", "--dry-run", "--json");
  expect(dryRun.status).toBe(0);
  expect(dryRun.stderr).not.toContain("hopper cache");

  const negatedInstall = run("setup", "--no-install-hopper", "--yes", "--json");
  expect(negatedInstall.status).toBe(0);
  expect(negatedInstall.stderr).not.toContain("hopper cache");

  const separatedValue = run(
    "setup",
    "--install-hopper",
    "false",
    "--yes",
    "--json",
  );
  expect(separatedValue.status).toBe(1);
  expect(separatedValue.stdout).toContain("Unexpected positional arguments");
  expect(separatedValue.stderr).not.toContain("hopper cache");

  expect(await readFile(marker, "utf8")).toBe(markerContents);
  expect(await readdir(cachePath)).toEqual(["keep.txt"]);
});

it("CLI guard allows ordinary setup and uninstall with an unrelated external XDG cache", async () => {
  const home = await createTestTempDirectory("rea-cli-guard-ordinary-home-");
  const outside = await createExternalTestDirectory("cli-guard-ordinary-cache");
  const cachePath = join(outside, "rea", "hopper-releases");
  const environment = {
    PATH: process.env.PATH ?? "",
    SystemRoot: process.env.SystemRoot,
    HOME: home,
    USERPROFILE: home,
    XDG_CACHE_HOME: outside,
    REA_TEST_ISOLATION_ROOTS: home,
  };
  for (const arguments_ of [
    ["setup", "--dry-run", "--json"],
    ["uninstall", "--json"],
  ]) {
    const result = spawnSync(
      process.execPath,
      [resolve("scripts/rea.mjs"), ...arguments_],
      { cwd: home, encoding: "utf8", env: environment },
    );
    expect(result.stderr).not.toContain("under test isolation");
  }
  expect(existsSync(cachePath)).toBe(false);
});

it.skipIf(process.platform !== "win32")(
  "both guards refuse external Claude MSIX Private and AppData targets",
  async () => {
    const root = await createTestTempDirectory("rea-cli-guard-claude-msix-");
    const home = join(root, "home");
    const roaming = join(root, "roaming");
    const local = join(root, "local");
    await mkdir(home, { recursive: true });
    await mkdir(roaming, { recursive: true });

    const outsideLocal = await createExternalTestDirectory(
      "cli-guard-claude-private",
    );
    const privatePackage = join(
      outsideLocal,
      "Packages",
      CLAUDE_DESKTOP_PACKAGE_FAMILY,
    );
    const privateConfig = join(
      privatePackage,
      "LocalCache",
      "Roaming",
      "Claude",
      "claude_desktop_config.json",
    );
    await mkdir(privatePackage, { recursive: true });
    const setupEnvironment = {
      HOME: home,
      USERPROFILE: home,
      APPDATA: roaming,
      LOCALAPPDATA: outsideLocal,
    };
    expect(() =>
      assertDestructiveIsolation(
        "setup",
        [root],
        setupEnvironment,
        "win32",
        root,
        ["--client", "claude_desktop", "--json"],
      ),
    ).toThrow(
      expect.objectContaining({
        command: "setup",
        offender: expect.stringContaining(privateConfig),
      }),
    );
    const setupResult = spawnSync(
      process.execPath,
      [
        resolve("scripts/rea.mjs"),
        "setup",
        "--client",
        "claude_desktop",
        "--json",
      ],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          PATH: process.env.PATH ?? "",
          SystemRoot: process.env.SystemRoot,
          TEMP: tmpdir(),
          TMP: tmpdir(),
          ...setupEnvironment,
          REA_TEST_ISOLATION_ROOTS: root,
        },
      },
    );
    expect(setupResult.status).toBe(1);
    expect(setupResult.stderr).toContain("claude_desktop config");
    expect(setupResult.stderr).toContain(privateConfig);
    expect(existsSync(privateConfig)).toBe(false);

    const insidePackage = join(
      local,
      "Packages",
      CLAUDE_DESKTOP_PACKAGE_FAMILY,
    );
    const insidePrivateConfig = join(
      insidePackage,
      "LocalCache",
      "Roaming",
      "Claude",
      "claude_desktop_config.json",
    );
    await mkdir(dirname(insidePrivateConfig), { recursive: true });
    await writeFile(insidePrivateConfig, '{"mcp":{"rea":{}}}\n');
    const outsideRoaming = await createExternalTestDirectory(
      "cli-guard-claude-appdata",
    );
    const appDataConfig = join(
      outsideRoaming,
      "Claude",
      "claude_desktop_config.json",
    );
    const appDataContents = '{"mcp":{"rea":{"command":"keep"}}}\n';
    await mkdir(dirname(appDataConfig), { recursive: true });
    await writeFile(appDataConfig, appDataContents);
    const uninstallEnvironment = {
      HOME: home,
      USERPROFILE: home,
      APPDATA: outsideRoaming,
      LOCALAPPDATA: local,
    };
    expect(() =>
      assertDestructiveIsolation(
        "uninstall",
        [root],
        uninstallEnvironment,
        "win32",
        root,
        ["--json"],
      ),
    ).toThrow(
      expect.objectContaining({
        command: "uninstall",
        offender: expect.stringContaining(appDataConfig),
      }),
    );
    const uninstallResult = spawnSync(
      process.execPath,
      [resolve("scripts/rea.mjs"), "uninstall", "--json"],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          PATH: process.env.PATH ?? "",
          SystemRoot: process.env.SystemRoot,
          TEMP: tmpdir(),
          TMP: tmpdir(),
          ...uninstallEnvironment,
          REA_TEST_ISOLATION_ROOTS: root,
        },
      },
    );
    expect(uninstallResult.status).toBe(1);
    expect(uninstallResult.stderr).toContain("claude_desktop config");
    expect(uninstallResult.stderr).toContain(appDataConfig);
    expect(existsSync(insidePrivateConfig)).toBe(true);
    expect(await readFile(appDataConfig, "utf8")).toBe(appDataContents);
  },
);

it("CLI guard refuses cwd-relative OMP and OpenCode overrides outside its root", async () => {
  const root = await createTestTempDirectory("rea-cli-guard-client-cwd-");
  const outside = join(tmpdir(), `rea-cli-guard-client-${randomUUID()}`);
  const cases = [
    { PI_CODING_AGENT_DIR: relative(root, outside) },
    { OPENCODE_CONFIG: relative(root, `${outside}.json`) },
    { OPENCODE_CONFIG_DIR: relative(root, `${outside}-dir`) },
  ];
  for (const overrides of cases) {
    const result = spawnSync(
      process.execPath,
      [resolve("scripts/rea.mjs"), "setup", "--json"],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          PATH: process.env.PATH ?? "",
          SystemRoot: process.env.SystemRoot,
          HOME: "",
          USERPROFILE: root,
          ...overrides,
          REA_TEST_ISOLATION_ROOTS: root,
        },
      },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Refusing `setup` under test isolation");
    expect(result.stderr).toContain(outside);
  }
  expect(existsSync(outside)).toBe(false);
  expect(existsSync(`${outside}.json`)).toBe(false);
  expect(existsSync(`${outside}-dir`)).toBe(false);
});

it("CLI guard refuses a cwd-escaping unresolved Hermes skill path", async () => {
  const root = await createTestTempDirectory("rea-cli-guard-unresolved-skill-");
  const unresolvedPath = `~rea-unknown-${randomUUID()}/../../rea-outside-${randomUUID()}`;
  const result = spawnSync(
    process.execPath,
    [resolve("scripts/rea.mjs"), "setup", "--json"],
    {
      cwd: root,
      encoding: "utf8",
      env: {
        PATH: process.env.PATH ?? "",
        SystemRoot: process.env.SystemRoot,
        HOME: "",
        USERPROFILE: root,
        HERMES_HOME: unresolvedPath,
        REA_TEST_ISOLATION_ROOTS: root,
      },
    },
  );
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("Refusing `setup` under test isolation");
  expect(result.stderr).toContain(unresolvedPath);
});

it.skipIf(process.platform === "win32")(
  "CLI guard refuses setup and uninstall through an in-root dangling config link",
  async () => {
    const root = await createTestTempDirectory("rea-cli-guard-dangling-root-");
    const outside = await createTestTempDirectory(
      "rea-cli-guard-dangling-outside-",
    );
    const externalTarget = join(outside, "not-created.json");
    const link = join(root, "opencode.json");
    await symlink(externalTarget, link);

    for (const command of ["setup", "uninstall"] as const) {
      const result = spawnSync(
        process.execPath,
        [
          resolve("scripts/rea.mjs"),
          command,
          ...(command === "setup" ? ["--dry-run"] : []),
          "--json",
        ],
        {
          cwd: root,
          encoding: "utf8",
          env: {
            PATH: process.env.PATH ?? "",
            SystemRoot: process.env.SystemRoot,
            HOME: "",
            USERPROFILE: root,
            OPENCODE_CONFIG: link,
            REA_TEST_ISOLATION_ROOTS: root,
          },
        },
      );
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        `Refusing \`${command}\` under test isolation`,
      );
      expect(result.stderr).toContain("opencode config");
    }
    expect(existsSync(externalTarget)).toBe(false);
  },
);

it.skipIf(process.platform === "win32")(
  "CLI guard refuses setup before a dangling skill link can create an external directory",
  async () => {
    const root = await createTestTempDirectory(
      "rea-cli-guard-skill-link-root-",
    );
    const outside = await createTestTempDirectory(
      "rea-cli-guard-skill-link-outside-",
    );
    const externalTarget = join(outside, "not-created-skill-directory");
    const link = join(root, ".agents", "skills");
    await mkdir(join(root, ".agents"), { recursive: true });
    await symlink(externalTarget, link);

    const result = spawnSync(
      process.execPath,
      [
        resolve("scripts/rea.mjs"),
        "setup",
        "--skill-client",
        "freebuff",
        "--yes",
        "--json",
      ],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          PATH: process.env.PATH ?? "",
          SystemRoot: process.env.SystemRoot,
          HOME: "",
          USERPROFILE: root,
          REA_TEST_ISOLATION_ROOTS: root,
        },
      },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Refusing `setup` under test isolation");
    expect(result.stderr).toContain("skill");
    expect(existsSync(externalTarget)).toBe(false);
  },
);

it("CLI guard treats ZCode's same-scope fallback as a containment surface", async () => {
  const root = await createTestTempDirectory("rea-cli-guard-zcode-root-");
  const outside = await createTestTempDirectory("rea-cli-guard-zcode-outside-");
  await symlink(
    outside,
    join(root, ".agents"),
    process.platform === "win32" ? "junction" : "dir",
  );

  for (const command of ["setup", "uninstall"] as const) {
    const result = spawnSync(
      process.execPath,
      [resolve("scripts/rea.mjs"), command, "--json"],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          PATH: process.env.PATH ?? "",
          SystemRoot: process.env.SystemRoot,
          HOME: "",
          USERPROFILE: root,
          REA_TEST_ISOLATION_ROOTS: root,
        },
      },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      `Refusing \`${command}\` under test isolation`,
    );
    expect(result.stderr).toContain("zcode config");
  }
  expect(existsSync(join(outside, "mcp.json"))).toBe(false);
});
