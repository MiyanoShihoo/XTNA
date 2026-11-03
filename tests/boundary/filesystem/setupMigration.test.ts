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

  // §4 with §3 row 6: the dialect cannot remove the historical member without rewriting the file
  // and dropping the caller's comments, so setup refuses rather than creating a duplicate it could
  // never remove.
  it("refuses to migrate a TOML registration instead of writing a second key", async () => {
    const root = await createTestTempDirectory("rea-setup-migration-toml-");
    const configPath = join(root, "config.toml");
    const client = { name: "codex", format: "toml", configPath } as const;
    const original = `# caller note\n[mcp_servers.${LEGACY_MCP_SERVER_KEY}]\ncommand = "rea"\nargs = ["mcp"]\n`;
    await writeFile(configPath, original);

    const result = await configureClientConfiguration(client, {}, [
      "rea",
      "mcp",
    ]);
    expect(result).toMatchObject({
      status: "failed",
      reason: "registration_ownership",
    });
    if (
      result.status === "failed" &&
      result.reason === "registration_ownership"
    )
      expect(result.detail).toContain("Remove that entry by hand");

    // Nothing was written: no second key, and the caller's comment survives untouched.
    const written = await readFile(configPath, "utf8");
    expect(written).toBe(original);
    expect(written).not.toContain(
      `[mcp_servers.${PRODUCT_IDENTITY.mcpServerKey}]`,
    );
  });
});
