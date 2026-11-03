import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { configureClientConfiguration } from "../../../src/application/SetupClientConfiguration.js";
import type { SetupClient } from "../../../src/application/SupportedClients.js";
import {
  LEGACY_MCP_SERVER_KEY,
  PRODUCT_IDENTITY,
} from "../../../src/identity.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

/**
 * §3 rows 6 and 10 — the setup side of the migration.
 *
 * A registration an earlier release installed is stored under the historical key. Running setup
 * must leave the client with one current member, not two: keeping both leaves the client loading
 * the historical one, and the duplicate is the state §3 row 10 forbids.
 *
 * §4 bounds this: a dialect whose removal rewrites the whole document and drops the user's
 * comments is not migrated by a silent setup run.
 */

const json = (root: string) =>
  ({
    name: "cursor",
    format: "json",
    configPath: join(root, "config.json"),
  }) as const satisfies SetupClient;

describe("setup migrates an inherited registration", () => {
  it("retires the owned historical member and leaves only the current key", async () => {
    const root = await createTestTempDirectory("rea-setup-migration-");
    const client = json(root);
    await writeFile(
      client.configPath,
      JSON.stringify(
        {
          mcpServers: {
            [LEGACY_MCP_SERVER_KEY]: { command: "rea", args: ["mcp"] },
          },
        },
        null,
        2,
      ),
    );

    expect(
      await configureClientConfiguration(client, {}, ["rea", "mcp"]),
    ).toMatchObject({ status: "configured" });

    const written = JSON.parse(await readFile(client.configPath, "utf8")) as {
      mcpServers: Record<string, unknown>;
    };
    expect(Object.keys(written.mcpServers)).toEqual([
      PRODUCT_IDENTITY.mcpServerKey,
    ]);
  });

  it("keeps both keys in TOML, where removal costs every comment", async () => {
    const root = await createTestTempDirectory("rea-setup-migration-toml-");
    const configPath = join(root, "config.toml");
    const client = { name: "codex", format: "toml", configPath } as const;
    await writeFile(
      configPath,
      `# caller note\n[mcp_servers.${LEGACY_MCP_SERVER_KEY}]\ncommand = "rea"\nargs = ["mcp"]\n`,
    );

    expect(
      await configureClientConfiguration(client, {}, ["rea", "mcp"]),
    ).toMatchObject({
      status: "configured",
    });

    const written = await readFile(configPath, "utf8");
    // §4: the historical member stays, because removing it would drop "# caller note".
    expect(written).toContain("caller note");
    expect(written).toContain(`[mcp_servers.${LEGACY_MCP_SERVER_KEY}]`);
    expect(written).toContain(`[mcp_servers.${PRODUCT_IDENTITY.mcpServerKey}]`);
  });
});
