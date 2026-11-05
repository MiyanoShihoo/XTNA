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
 * The guards proven here sit on the write path itself
 * (`configureClientDocument`), not on the planning gate `setup` consults first.
 * A document that only the planning gate refuses never reaches
 * `withClientServers`, so an acceptance case driving the CLI cannot tell the two
 * apart.
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

/** Assert nothing was written and nothing was left behind. */
const expectUntouched = async (
  configPath: string,
  original: string,
): Promise<void> => {
  expect((await readFile(configPath)).equals(Buffer.from(original))).toBe(true);
  expect(await readdir(dirname(configPath))).toEqual(["opencode.json"]);
};

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
      await expectUntouched(client.configPath, original);
    });
});

/**
 * A registration under the historical key is a live second registration: the
 * client loads it beside the current one after setup writes. The product
 * decision is to block that state rather than report success or delete the
 * historical member on its own authority.
 */
describe("setup write path historical identity guard", () => {
  const cases = [
    [
      "a V1 historical member beside an owned current member",
      {
        mcp: {
          rea: { type: "local", command: ["rea", "mcp"] },
          servers: { xtna: { type: "local", command: [...command] } },
        },
      },
    ],
    [
      "only a V1 historical member, when setup would add the current one",
      { mcp: { servers: {}, rea: { type: "local", command: ["rea", "mcp"] } } },
    ],
    [
      "a foreign V1 historical member",
      { mcp: { servers: {}, rea: { type: "local", command: ["other"] } } },
    ],
  ] as const;

  for (const [name, document] of cases)
    it(`blocks but does not modify the file when it holds ${name}`, async () => {
      const client = await openCodeClient("rea-setup-legacy-identity-");
      const original = JSON.stringify(document);
      await writeFile(client.configPath, original);

      const result = await configureClientConfiguration(client, {}, command);

      expect(result).toMatchObject({
        status: "failed",
        reason: "historical_identity",
      });
      const detail =
        result.status === "failed" && result.reason === "historical_identity"
          ? result.detail
          : "";
      // States the coexistence and points at the historical key; it must not
      // describe two storage locations for one identity as a conflict.
      expect(detail).toContain("rea");
      expect(detail.toLowerCase()).not.toContain("conflict");
      await expectUntouched(client.configPath, original);
    });

  it("still configures a document holding one identity in both storage locations", async () => {
    const client = await openCodeClient("rea-setup-same-identity-");
    const original = JSON.stringify({
      mcp: {
        xtna: { type: "local", command: ["rea", "mcp"] },
        servers: { xtna: { type: "local", command: ["rea", "mcp"] } },
      },
    });
    await writeFile(client.configPath, original);

    const result = await configureClientConfiguration(client, {}, command);

    expect(result.status).toBe("configured");
    const document = JSON.parse(await readFile(client.configPath, "utf8")) as {
      mcp: Record<string, unknown>;
    };
    expect(document.mcp).not.toHaveProperty("xtna");
    expect(document.mcp.servers).toMatchObject({
      xtna: { type: "local", command: [...command] },
    });
  });

  it("keeps reporting an already-current configuration as unchanged", async () => {
    const client = await openCodeClient("rea-setup-current-");
    const original = JSON.stringify({
      mcp: {
        servers: {
          xtna: { type: "local", command: [...command], disabled: false },
        },
      },
    });
    await writeFile(client.configPath, original);

    expect(
      (await configureClientConfiguration(client, {}, command)).status,
    ).toBe("unchanged");
    await expectUntouched(client.configPath, original);
  });
});
