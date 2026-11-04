import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { readRegistrationSnapshot } from "./RegistrationSnapshot.js";
import type { SetupClient } from "./SupportedClients.js";
import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";

/**
 * The snapshot is the answer doctor, setup and uninstall are meant to share. These cases pin what
 * it must report before any of them consumes it: every tier, the right writability, and the
 * distinction between "one member, two places" and "two members".
 */
const clientWith = (
  configPath: string,
  configPaths: readonly string[],
): SetupClient =>
  ({
    name: "cursor",
    format: "json",
    configPath,
    configPaths,
  }) as SetupClient;

const writeJson = async (path: string, servers: Record<string, unknown>) => {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, JSON.stringify({ mcpServers: servers }), "utf8");
};

describe("registration snapshot", () => {
  it("reports a lower-layer historical member the effective document cannot see", async () => {
    const home = await createTestTempDirectory("rea-snapshot-lower-");
    const target = join(home, "client.json");
    const lower = join(home, "global.json");
    await writeJson(target, { xtna: { command: "xtna", args: ["mcp"] } });
    await writeJson(lower, { rea: { command: "rea", args: ["mcp"] } });

    const snapshot = await readRegistrationSnapshot(
      clientWith(target, [lower, target]),
      { currentCommandPath: undefined },
    );
    expect(snapshot.ok).toBe(true);
    if (!snapshot.ok) return;

    expect(
      snapshot.value.registration.members.map((member) => [
        member.key,
        member.tier,
        member.writable,
      ]),
    ).toEqual([
      ["xtna", "document", true],
      ["rea", "lower-layer", false],
    ]);
    // §3 row 13: the pair is a duplicate, and the lower layer is spelled out.
    expect(snapshot.value.registration.duplicate).toBe(true);
    expect(snapshot.value.registration.conflicts).toContainEqual({
      kind: "lower_layer",
      keys: ["rea"],
    });
  });

  it("never marks a lower-layer member writable", async () => {
    const home = await createTestTempDirectory("rea-snapshot-writable-");
    const target = join(home, "client.json");
    const lower = join(home, "global.json");
    await writeJson(target, {});
    await writeJson(lower, { rea: { command: "rea", args: ["mcp"] } });

    const snapshot = await readRegistrationSnapshot(
      clientWith(target, [lower, target]),
      {},
    );
    expect(snapshot.ok).toBe(true);
    if (!snapshot.ok) return;
    const [member] = snapshot.value.registration.members;
    expect(member).toMatchObject({ tier: "lower-layer", writable: false });
    // Ownership says the value is ours; writability still forbids the write.
    expect(snapshot.value.registration.target).toBeUndefined();
    expect(snapshot.value.registration.retire).toEqual([]);
  });

  it("treats a settings file the caller marks read-only as a read-only source", async () => {
    const home = await createTestTempDirectory("rea-snapshot-readonly-");
    const target = join(home, "client.json");
    const system = join(home, "system.json");
    await writeJson(target, {});
    await writeJson(system, { rea: { command: "rea", args: ["mcp"] } });

    const snapshot = await readRegistrationSnapshot(
      clientWith(target, [system, target]),
      { readOnlyPaths: [system] },
    );
    expect(snapshot.ok).toBe(true);
    if (!snapshot.ok) return;
    expect(snapshot.value.registration.members[0]?.tier).toBe(
      "read-only-source",
    );
    expect(snapshot.value.registration.target).toBeUndefined();
  });

  it("surfaces the targeted document for a writer without granting anything", async () => {
    const home = await createTestTempDirectory("rea-snapshot-document-");
    const target = join(home, "client.json");
    await writeJson(target, { xtna: { command: "xtna", args: ["mcp"] } });

    const snapshot = await readRegistrationSnapshot(
      clientWith(target, [target]),
      {},
    );
    expect(snapshot.ok).toBe(true);
    if (!snapshot.ok) return;
    expect(snapshot.value.document?.servers).toHaveProperty("xtna");
    expect(snapshot.value.sourcePaths).toEqual([target]);
    expect(snapshot.value.registration.members).toHaveLength(1);
    expect(snapshot.value.registration.duplicate).toBe(false);
  });
});
