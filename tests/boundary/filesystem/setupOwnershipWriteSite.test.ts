import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, dirname } from "node:path";

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
  expect(await readdir(dirname(configPath))).toEqual([basename(configPath)]);
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
      // Names the historical key; it must not describe two storage locations for
      // one identity as a conflict.
      expect(detail).toContain(`"${"rea"}"`);
      expect(detail.toLowerCase()).not.toContain("conflict");
      await expectUntouched(client.configPath, original);
    });

  // Ownership is decided first: a historical registration this product does not
  // own is the existing ownership refusal's subject, not a coexistence one.
  it("refuses a foreign V1 historical member as an ownership refusal", async () => {
    const client = await openCodeClient("rea-setup-legacy-foreign-");
    const original = JSON.stringify({
      mcp: { servers: {}, rea: { type: "local", command: ["other"] } },
    });
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
    ).toContain("foreign ownership");
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

describe("setup write path historical identity guard — activation and dialect", () => {
  // A native historical member is the one case the write retires itself, so the
  // guard must not refuse it: the migration that works has to stay available.
  it("migrates a native historical member instead of refusing it", async () => {
    const client = await openCodeClient("rea-setup-native-legacy-");
    await writeFile(
      client.configPath,
      JSON.stringify({
        mcp: { servers: { rea: { type: "local", command: ["rea", "mcp"] } } },
      }),
    );

    expect(
      (await configureClientConfiguration(client, {}, command)).status,
    ).toBe("configured");
    const document = JSON.parse(await readFile(client.configPath, "utf8")) as {
      mcp: { servers: Record<string, unknown> };
    };
    expect(document.mcp.servers).not.toHaveProperty("rea");
    expect(document.mcp.servers.xtna).toMatchObject({ type: "local" });
  });

  // A member the client does not load is not a second registration.
  it("does not refuse a historical member the client is told not to load", async () => {
    const client = await openCodeClient("rea-setup-legacy-disabled-");
    const original = JSON.stringify({
      mcp: {
        rea: { type: "local", command: ["rea", "mcp"], enabled: false },
        servers: {},
      },
    });
    await writeFile(client.configPath, original);

    expect(
      (await configureClientConfiguration(client, {}, command)).status,
    ).toBe("configured");
  });

  // A V1 entry spells activation `enabled`; `disabled` on that table is not an
  // activation field, so the member is still loaded.
  it("still blocks a V1 historical member that only carries a native spelling of disabled", async () => {
    const client = await openCodeClient("rea-setup-legacy-native-spelling-");
    const original = JSON.stringify({
      mcp: {
        rea: { type: "local", command: ["rea", "mcp"], disabled: true },
        servers: {},
      },
    });
    await writeFile(client.configPath, original);

    expect(
      await configureClientConfiguration(client, {}, command),
    ).toMatchObject({ status: "failed", reason: "historical_identity" });
    await expectUntouched(client.configPath, original);
  });

  // The Hermes serializer upserts the current entry and leaves every other table
  // in place, so a native historical member is not retired by that write.
  it("retires an owned historical Hermes table in the same write", async () => {
    const home = await createTestTempDirectory("rea-setup-hermes-legacy-");
    const client = supportedClients(home).find(({ name }) => name === "hermes");
    if (client === undefined) throw new Error("missing Hermes client");
    await mkdir(dirname(client.configPath), { recursive: true });
    const original = [
      "# caller comment that the writer must keep",
      "mcp_servers:",
      "  rea:",
      "    command: npx",
      "    args:",
      "      - -y",
      "      - rea-agents@6.6.0",
      "      - mcp",
      "",
    ].join("\n");
    await writeFile(client.configPath, original);

    const result = await configureClientConfiguration(client, {}, command);

    expect(result.status).toBe("configured");
    const written = await readFile(client.configPath, "utf8");
    expect(written).toContain("# caller comment that the writer must keep");
    expect(written).not.toContain("rea-agents");
    expect(written).toContain("xtna");
  });

  // A Hermes table spells activation `enabled`, so a member the client is told
  // not to load is not a registration.
  it("does not refuse an unloaded Hermes historical table", async () => {
    const home = await createTestTempDirectory("rea-setup-hermes-disabled-");
    const client = supportedClients(home).find(({ name }) => name === "hermes");
    if (client === undefined) throw new Error("missing Hermes client");
    await mkdir(dirname(client.configPath), { recursive: true });
    await writeFile(
      client.configPath,
      [
        "mcp_servers:",
        "  rea:",
        "    command: npx",
        "    args:",
        "      - -y",
        "      - rea-agents@6.6.0",
        "      - mcp",
        "    enabled: false",
        "",
      ].join("\n"),
    );

    expect(
      (await configureClientConfiguration(client, {}, command)).status,
    ).toBe("configured");
  });

  // The fallback membership check must classify ownership before coexistence.
  it("reports a foreign historical member in the ZCode fallback as an ownership refusal", async () => {
    const home = await createTestTempDirectory("rea-setup-zcode-foreign-");
    const client = supportedClients(home).find(({ name }) => name === "zcode");
    if (client === undefined) throw new Error("missing ZCode client");
    const fallbackPath = client.zcodeFallbackPath;
    if (fallbackPath === undefined) throw new Error("missing ZCode fallback");
    await mkdir(dirname(fallbackPath), { recursive: true });
    const fallback = JSON.stringify({
      mcpServers: { rea: { command: "other-product" } },
    });
    await writeFile(fallbackPath, fallback);

    const result = await configureClientConfiguration(client, {}, command);

    expect(result).toMatchObject({
      status: "failed",
      reason: "registration_ownership",
    });
    expect(
      result.status === "failed" && result.reason === "registration_ownership"
        ? result.detail
        : "",
    ).toContain(`"${"rea"}"`);
    expect((await readFile(fallbackPath)).equals(Buffer.from(fallback))).toBe(
      true,
    );
  });

  // The fallback table is merged into the write after the layers are read, so it
  // needs its own admission before any byte is written.
  it("refuses a historical member that lives only in the ZCode fallback", async () => {
    const home = await createTestTempDirectory("rea-setup-zcode-fallback-");
    const client = supportedClients(home).find(({ name }) => name === "zcode");
    if (client === undefined) throw new Error("missing ZCode client");
    const fallbackPath = client.zcodeFallbackPath;
    if (fallbackPath === undefined) throw new Error("missing ZCode fallback");
    await mkdir(dirname(fallbackPath), { recursive: true });
    const fallback = JSON.stringify({
      mcpServers: { rea: { command: "rea", args: ["mcp"] } },
    });
    await writeFile(fallbackPath, fallback);

    const result = await configureClientConfiguration(client, {}, command);

    expect(result).toMatchObject({
      status: "failed",
      reason: "historical_identity",
    });
    expect((await readFile(fallbackPath)).equals(Buffer.from(fallback))).toBe(
      true,
    );
    await expect(readFile(client.configPath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
