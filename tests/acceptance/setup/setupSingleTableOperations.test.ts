import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { expect } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import {
  EXPECTED_BACKUP_SUFFIX,
  EXPECTED_MCP_KEY,
  LEGACY_MCP_KEY,
} from "../../fixtures/acceptance/productContract.js";
import { cliTest } from "../../support/cli/cliFixture.js";

/**
 * Single-table setup through the real CLI entry point. Each case asserts the
 * observable result of one operation: the bytes of the file, the artifacts left
 * beside it, the reported actions and the final client state. Nothing here calls
 * an internal helper and calls it end-to-end.
 */

const claudeSetup = (mode: string): readonly string[] => [
  "setup",
  "--client",
  "claude_code",
  "--skill=false",
  mode,
  "--json",
];

const runClaude = (
  cli: {
    run: (invocation: {
      arguments: readonly string[];
      cwd?: string;
      environment?: NodeJS.ProcessEnv;
    }) => Promise<{ exitCode: number | null; stdout: string; json: unknown }>;
  },
  home: string,
  mode: string,
) =>
  cli.run({
    arguments: claudeSetup(mode),
    cwd: home,
    environment: {
      HOME: home,
      USERPROFILE: home,
      CLAUDE_CONFIG_DIR: home,
    },
  });

const prepareClaudeHome = async (text: string) => {
  const home = await createTestTempDirectory("rea-single-table-");
  const config = join(home, ".claude.json");
  await writeFile(config, text);
  return { home, config };
};

const expectDirectory = async (
  config: string,
  names: readonly string[],
): Promise<void> => {
  expect((await readdir(dirname(config))).sort()).toEqual([...names].sort());
};

cliTest(
  "case 1: an already correct single-table registration is a no-op",
  async ({ cli }) => {
    const configured = JSON.stringify({
      mcpServers: {
        [EXPECTED_MCP_KEY]: {
          command: process.execPath,
          args: [join(process.cwd(), "scripts", "rea.mjs"), "mcp"],
        },
      },
    });
    const { home, config } = await prepareClaudeHome(configured);
    const result = await runClaude(cli, home, "--yes");

    const actions = (result.json as { appliedActions?: unknown })
      .appliedActions;
    expect(Array.isArray(actions) ? actions : ["?"]).not.toContain(
      "configured_claude_code",
    );
    expect((await readFile(config)).equals(Buffer.from(configured))).toBe(true);
    await expectDirectory(config, [".claude.json"]);
  },
);

cliTest(
  "case 2: one owned historical member is migrated and backed up",
  async ({ cli }) => {
    const original = JSON.stringify({
      mcpServers: {
        [LEGACY_MCP_KEY]: {
          command: "npx",
          args: ["-y", "rea-agents@6.6.0", "mcp"],
        },
      },
    });
    const { home, config } = await prepareClaudeHome(original);
    const result = await runClaude(cli, home, "--yes");

    expect(result.exitCode, result.stdout).toBe(0);
    expect(result.json).toMatchObject({
      appliedActions: expect.arrayContaining(["configured_claude_code"]),
    });
    const written = JSON.parse(await readFile(config, "utf8")) as {
      mcpServers: Record<string, unknown>;
    };
    expect(written.mcpServers).not.toHaveProperty(LEGACY_MCP_KEY);
    expect(written.mcpServers[EXPECTED_MCP_KEY]).toMatchObject({
      command: process.execPath,
    });
    expect(
      (await readFile(`${config}.${EXPECTED_BACKUP_SUFFIX}.backup`)).equals(
        Buffer.from(original),
      ),
    ).toBe(true);
  },
);

for (const [identity, entry] of [
  ["foreign", { command: "other-server", args: ["mcp"] }],
  [
    "unknown",
    {
      command: process.execPath,
      args: ["/missing/old-rea/scripts/rea.mjs", "mcp"],
    },
  ],
] as const)
  cliTest(
    `case ${identity === "foreign" ? 3 : 4}: a ${identity} single-table member blocks without writing`,
    async ({ cli }) => {
      const original = JSON.stringify({
        mcpServers: { [EXPECTED_MCP_KEY]: entry },
      });
      const { home, config } = await prepareClaudeHome(original);
      const result = await runClaude(cli, home, "--yes");

      expect(result.exitCode, result.stdout).toBe(1);
      expect(result.json).toMatchObject({
        status: "needs_human",
        appliedActions: [],
        remediation: expect.stringContaining(`${identity} ownership`),
      });
      expect((await readFile(config)).equals(Buffer.from(original))).toBe(true);
      await expectDirectory(config, [".claude.json"]);
    },
  );

cliTest(
  "case 6: a dialect that cannot remove a historical member blocks and keeps the file",
  async ({ cli }) => {
    const home = await createTestTempDirectory("rea-single-table-toml-");
    const config = join(home, ".codex", "config.toml");
    await mkdir(dirname(config), { recursive: true });
    const original = [
      "# caller comment that a rewrite would drop",
      'model = "gpt-5"',
      "",
      `[mcp_servers.${LEGACY_MCP_KEY}]`,
      'command = "npx"',
      'args = ["-y", "rea-agents@6.6.0", "mcp"]',
      "",
    ].join("\n");
    await writeFile(config, original);

    const result = await cli.run({
      arguments: [
        "setup",
        "--client",
        "codex",
        "--skill=false",
        "--yes",
        "--json",
      ],
      cwd: home,
      environment: { HOME: home, USERPROFILE: home },
    });

    expect(result.exitCode, result.stdout).toBe(1);
    expect(result.json).toMatchObject({
      status: "needs_human",
      appliedActions: [],
      remediation: expect.stringContaining("drops the comments"),
    });
    expect((await readFile(config)).equals(Buffer.from(original))).toBe(true);
    await expectDirectory(config, ["config.toml"]);
  },
);

cliTest(
  "case 7: a configuration edited after the plan is re-read instead of overwritten from the plan",
  async ({ cli }) => {
    // The plan is produced from one read; the edit below lands between the plan
    // and the write. Applying must not restore the pre-edit content.
    const original = JSON.stringify({
      mcpServers: {
        [LEGACY_MCP_KEY]: {
          command: "npx",
          args: ["-y", "rea-agents@6.6.0", "mcp"],
        },
      },
      theme: "before",
    });
    const { home, config } = await prepareClaudeHome(original);
    const planned = await runClaude(cli, home, "--dry-run");
    expect(planned.exitCode, planned.stdout).toBe(0);

    const edited = JSON.stringify({
      ...JSON.parse(original),
      theme: "after",
      editedByCaller: true,
    });
    await writeFile(config, edited);
    const applied = await runClaude(cli, home, "--yes");

    expect(applied.exitCode, applied.stdout).toBe(0);
    const written = JSON.parse(await readFile(config, "utf8")) as Record<
      string,
      unknown
    >;
    // The caller's later values survive: the write re-read the file rather than
    // replaying the bytes it planned against.
    expect(written).toMatchObject({ theme: "after", editedByCaller: true });
    expect(
      (written.mcpServers as Record<string, unknown>)[EXPECTED_MCP_KEY],
    ).toBeDefined();
  },
);

cliTest(
  "case 5: an unwritable configuration target is refused instead of written through",
  async ({ cli }) => {
    const home = await createTestTempDirectory("rea-single-table-unwritable-");
    const config = join(home, ".claude.json");
    // A directory where the client reads a file: the write cannot produce a
    // regular file here, and setup must say so rather than replace or nest into it.
    await mkdir(config, { recursive: true });
    await writeFile(join(config, "occupied"), "caller data\n");

    const result = await runClaude(cli, home, "--yes");

    expect(result.exitCode, result.stdout).toBe(1);
    expect(result.json).toMatchObject({ status: "needs_human" });
    const remediation = (result.json as { remediation?: unknown }).remediation;
    expect(typeof remediation === "string" ? remediation : "").not.toBe("");
    expect((await readdir(config)).sort()).toEqual(["occupied"]);
    expect(await readFile(join(config, "occupied"), "utf8")).toBe(
      "caller data\n",
    );
  },
);

cliTest(
  "case 8: a failing backup leaves the original configuration untouched",
  async ({ cli }) => {
    const original = JSON.stringify({
      mcpServers: {
        [LEGACY_MCP_KEY]: {
          command: "npx",
          args: ["-y", "rea-agents@6.6.0", "mcp"],
        },
      },
    });
    const { home, config } = await prepareClaudeHome(original);
    // A directory where the backup must be created makes the backup step fail
    // after the plan is accepted.
    const backup = `${config}.${EXPECTED_BACKUP_SUFFIX}.backup`;
    await mkdir(backup, { recursive: true });

    const result = await runClaude(cli, home, "--yes");

    expect(result.exitCode, result.stdout).toBe(1);
    expect((await readFile(config)).equals(Buffer.from(original))).toBe(true);
    expect(
      (result.json as { appliedActions?: unknown }).appliedActions,
    ).toEqual([]);
  },
);
