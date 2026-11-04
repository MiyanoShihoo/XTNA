import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { expect } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import {
  EXPECTED_BACKUP_SUFFIX,
  EXPECTED_MCP_KEY,
} from "../../fixtures/acceptance/productContract.js";
import { expectSetupContract } from "../../support/cli/setupContract.js";
import { cliTest } from "../../support/cli/cliFixture.js";

/**
 * One OpenCode document holding this product in both storage locations:
 * `mcp.<key>` is the V1 table OpenCode still loads, `mcp.servers.<key>` is the
 * native V2 table this setup writes. Every case drives the real `setup` entry
 * point.
 *
 * These cases cover the *planning* gate: a document the planner refuses never
 * reaches the write path. The guard on the write path itself, which is what
 * actually removes a V1 member, is proven separately in
 * `tests/boundary/filesystem/setupOwnershipWriteSite.test.ts`.
 */
const opencodeDocument = (
  legacy: Record<string, unknown>,
  native: Record<string, unknown>,
): string =>
  JSON.stringify({
    mcp: {
      [EXPECTED_MCP_KEY]: legacy,
      servers: { [EXPECTED_MCP_KEY]: native },
    },
  });

const ownedEntry = { type: "local", command: ["rea", "mcp"] } as const;
const foreignEntry = { type: "local", command: ["other"] } as const;
const unknownEntry = {
  type: "local",
  command: [process.execPath, "/missing/old-rea/scripts/rea.mjs", "mcp"],
} as const;

const opencodeSetup = [
  "setup",
  "--client",
  "opencode",
  "--skill=false",
  "--yes",
  "--json",
];

const opencodeRun = async (
  cli: {
    run: (invocation: {
      arguments: readonly string[];
      cwd?: string;
      environment?: NodeJS.ProcessEnv;
    }) => Promise<{ exitCode: number | null; stdout: string; json: unknown }>;
  },
  home: string,
  arguments_: readonly string[],
) => {
  const config = join(home, ".config", "opencode", "opencode.json");
  const result = await cli.run({
    arguments: arguments_,
    cwd: home,
    environment: {
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: join(home, ".config"),
    },
  });
  return { config, result };
};

const prepareHome = async (text: string): Promise<string> => {
  const home = await createTestTempDirectory("rea-setup-dual-table-");
  const config = join(home, ".config", "opencode", "opencode.json");
  await mkdir(dirname(config), { recursive: true });
  await writeFile(config, text);
  return home;
};

/** The configuration directory must hold exactly the named files. */
const expectConfigurationDirectory = async (
  config: string,
  names: readonly string[],
): Promise<void> => {
  expect((await readdir(dirname(config))).sort()).toEqual([...names].sort());
};

cliTest(
  "OpenCode setup blocks a dual-table document whose V1 member is foreign",
  async ({ cli }) => {
    const original = opencodeDocument(foreignEntry, ownedEntry);
    const home = await prepareHome(original);
    const { config, result } = await opencodeRun(cli, home, opencodeSetup);

    expect(result.exitCode, result.stdout).toBe(1);
    expect(result.json).toMatchObject({
      status: "needs_human",
      appliedActions: [],
      remediation: expect.stringContaining("foreign ownership"),
    });
    // The foreign V1 member is untouched and the owned V2 member is not partially written.
    expect((await readFile(config)).equals(Buffer.from(original))).toBe(true);
    await expectConfigurationDirectory(config, ["opencode.json"]);
  },
);

cliTest(
  "OpenCode setup blocks a dual-table document whose V1 member is unknown",
  async ({ cli }) => {
    const original = opencodeDocument(unknownEntry, ownedEntry);
    const home = await prepareHome(original);
    const { config, result } = await opencodeRun(cli, home, opencodeSetup);

    expect(result.exitCode, result.stdout).toBe(1);
    expect(result.json).toMatchObject({
      status: "needs_human",
      appliedActions: [],
      remediation: expect.stringContaining("unknown ownership"),
    });
    expect((await readFile(config)).equals(Buffer.from(original))).toBe(true);
    await expectConfigurationDirectory(config, ["opencode.json"]);
  },
);

cliTest(
  "OpenCode setup proceeds on a dual-table document whose V1 and V2 members are both owned",
  async ({ cli }) => {
    const original = opencodeDocument(ownedEntry, ownedEntry);
    const home = await prepareHome(original);
    const { config, result } = await opencodeRun(cli, home, opencodeSetup);

    // Two owned storage locations is an admission decision only: the remaining
    // write gates still decide the outcome, so only the ownership refusal must
    // be absent here.
    expectSetupContract(result);
    const remediation = (result.json as { remediation?: unknown }).remediation;
    expect(typeof remediation === "string" ? remediation : "").not.toContain(
      "ownership",
    );
    expect(result.json).toMatchObject({
      appliedActions: expect.arrayContaining([`configured_opencode`]),
    });

    // The owned V1 member is retired and the native V2 member carries a launcher
    // OpenCode will load; the document keeps its V2 table rather than gaining a
    // duplicate.
    const document = JSON.parse(await readFile(config, "utf8")) as {
      mcp: Record<string, unknown>;
    };
    expect(document.mcp).not.toHaveProperty(EXPECTED_MCP_KEY);
    const native = document.mcp.servers as Record<string, unknown>;
    const nativeEntry = native[EXPECTED_MCP_KEY] as {
      type?: unknown;
      disabled?: unknown;
      command?: unknown;
    };
    expect(nativeEntry).toMatchObject({ type: "local", disabled: false });
    expect(Array.isArray(nativeEntry.command)).toBe(true);
    expect(nativeEntry.command).not.toEqual(ownedEntry.command);
    // A write happened, so the pre-edit document survives as the backup.
    expect(
      (await readFile(`${config}.${EXPECTED_BACKUP_SUFFIX}.backup`)).equals(
        Buffer.from(original),
      ),
    ).toBe(true);
    await expectConfigurationDirectory(config, [
      "opencode.json",
      `opencode.json.${EXPECTED_BACKUP_SUFFIX}.backup`,
    ]);
  },
);
