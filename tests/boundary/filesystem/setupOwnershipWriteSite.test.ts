import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import { configureClientConfiguration } from "../../../src/application/SetupClientConfiguration.js";
import { supportedClients } from "../../../src/application/SupportedClients.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import {
  clearClientLocationEnvironment,
  NPX_REGISTRATION_COMMAND,
} from "../../fixtures/clientEnvironment.js";

/**
 * The ownership guard proven here is the one on the write path itself
 * (`configureClientDocument`), not the planning gate `setup` consults first. A
 * document that only the planning gate refuses never reaches `withClientServers`,
 * so an acceptance case driving the CLI cannot tell the two guards apart.
 */

const command = NPX_REGISTRATION_COMMAND;

beforeEach(clearClientLocationEnvironment);

const openCodeClient = async (prefix: string) => {
  const home = await createTestTempDirectory(prefix);
  const client = supportedClients(home).find(({ name }) => name === "opencode");
  if (client === undefined) throw new Error("missing OpenCode client");
  await mkdir(client.markerPath ?? home, { recursive: true });
  return client;
};

/** A V2 owned native entry beside a V1 entry the caller supplies. */
const dualTableDocument = (legacy: unknown): string =>
  JSON.stringify({
    mcp: {
      xtna: legacy,
      servers: { xtna: { type: "local", command: [...command] } },
    },
  });

describe("setup write path ownership admission", () => {
  for (const [identity, legacy] of [
    ["foreign", { type: "local", command: ["other"] }],
    [
      "unknown",
      {
        type: "local",
        command: [process.execPath, "/missing/old-rea/scripts/rea.mjs", "mcp"],
      },
    ],
  ] as const)
    it(`refuses the rewrite when the V1 member beside an owned V2 entry is ${identity}`, async () => {
      const client = await openCodeClient(`rea-setup-write-site-${identity}-`);
      const original = dualTableDocument(legacy);
      await writeFile(client.configPath, original);

      const result = await configureClientConfiguration(client, {}, command);

      expect(result).toMatchObject({
        status: "failed",
        reason: "registration_ownership",
      });
      expect(
        result.status === "failed" && result.reason === "registration_ownership"
          ? result.detail
          : "",
      ).toContain(`${identity} ownership`);
      // Byte-identical, and no artifact of a write attempt beside it.
      expect(
        (await readFile(client.configPath)).equals(Buffer.from(original)),
      ).toBe(true);
      expect(await readdir(dirname(client.configPath))).toEqual([
        "opencode.json",
      ]);
    });

  // Documents a gap, not a decision: the guard is keyed to the current
  // registration name, so an OpenCode V1 member under the historical `rea` key is
  // neither admitted nor retired, and setup reports success while the client keeps
  // loading two registrations of this product. `fails` keeps the finding
  // executable without asserting the current behaviour is correct.
  it.fails("retires or refuses a V1 member registered under the historical key", async () => {
    const client = await openCodeClient("rea-setup-write-site-legacy-key-");
    await writeFile(
      client.configPath,
      JSON.stringify({
        mcp: {
          rea: { type: "local", command: ["rea", "mcp"] },
          servers: { xtna: { type: "local", command: [...command] } },
        },
      }),
    );

    const result = await configureClientConfiguration(client, {}, command);
    const written = JSON.parse(await readFile(client.configPath, "utf8")) as {
      mcp: Record<string, unknown>;
    };
    expect(result.status).toBe("failed");
    expect(written.mcp).not.toHaveProperty("rea");
  });
});
