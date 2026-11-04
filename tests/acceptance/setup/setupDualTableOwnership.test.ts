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
 * point; none of them calls the ownership predicate directly.
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

cliTest(
  "OpenCode setup blocks a dual-table document whose V1 member is foreign",
  async ({ cli }) => {
    const original = opencodeDocument(foreignEntry, ownedEntry);
    const home = await prepareHome(original);
    const { config, result } = await opencodeRun(cli, home, opencodeSetup);

    expect(result.exitCode, result.stdout).toBe(1);
    expect(result.json).toMatchObject({
      status: "needs_human",
      plannedActions: [],
      appliedActions: [],
      remediation: expect.stringContaining("foreign ownership"),
    });
    // The foreign V1 member is untouched and the owned V2 member is not partially written.
    expect(await readFile(config, "utf8")).toBe(original);
    await expect(
      readFile(`${config}.${EXPECTED_BACKUP_SUFFIX}.backup`),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(
      (await readdir(home)).filter((name) => name.includes(".recovery")),
    ).toEqual([]);
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
      plannedActions: [],
      appliedActions: [],
      remediation: expect.stringContaining("unknown ownership"),
    });
    expect(await readFile(config, "utf8")).toBe(original);
    await expect(
      readFile(`${config}.${EXPECTED_BACKUP_SUFFIX}.backup`),
    ).rejects.toMatchObject({ code: "ENOENT" });
  },
);

cliTest(
  "OpenCode setup proceeds on a dual-table document whose V1 and V2 members are both owned",
  async ({ cli }) => {
    const original = opencodeDocument(ownedEntry, ownedEntry);
    const home = await prepareHome(original);
    const { config, result } = await opencodeRun(cli, home, opencodeSetup);

    // Two storage locations both proven owned is an admission decision only: the
    // remaining write gates still decide the outcome, so only the ownership
    // refusal must be absent here.
    const status = expectSetupContract(result);
    expect(status).not.toBe("failed");
    const remediation = (result.json as { remediation?: unknown }).remediation;
    const remediationText = typeof remediation === "string" ? remediation : "";
    expect(remediationText).not.toContain("ownership");
    expect(result.json).toMatchObject({ plannedActions: expect.any(Array) });

    // The owned V1 member is retired and the native V2 member carries the current
    // launcher; the document keeps its V2 table rather than gaining a duplicate.
    const document = JSON.parse(await readFile(config, "utf8")) as {
      mcp: Record<string, unknown>;
    };
    expect(document.mcp).not.toHaveProperty(EXPECTED_MCP_KEY);
    const native = document.mcp.servers as Record<string, unknown>;
    const nativeEntry = native[EXPECTED_MCP_KEY] as { command?: unknown };
    expect(Array.isArray(nativeEntry.command)).toBe(true);
    expect(nativeEntry.command).not.toEqual(ownedEntry.command);
    // A write happened, so the pre-edit document survives as the backup.
    expect(
      await readFile(`${config}.${EXPECTED_BACKUP_SUFFIX}.backup`, "utf8"),
    ).toBe(original);
  },
);
