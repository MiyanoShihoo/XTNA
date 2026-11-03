import { describe, expect, it } from "vitest";

import { PRODUCT_IDENTITY } from "../identity.js";

import { parseClientConfiguration } from "./ClientConfigurationDocument.js";
import type { SetupClient } from "./SupportedClients.js";
import { clientRegistrationRemoval } from "./Uninstall.js";

/**
 * §3 rows 10–13 from the uninstall side, at the level where the decision is made: which members
 * this run may remove, and which refusal keeps the rest.
 *
 * The entry installed by this build is the one the ownership classifier calls `owned`, so the
 * fixture launches the same script the product ships.
 */
// A registration that names this product's own CLI binary is owned regardless of where the
// binary resolves; a script launcher is only owned when it is the entry this build runs, which a
// fixture path cannot be.
const owned = () => ({ command: PRODUCT_IDENTITY.cliBinary, args: ["mcp"] });
const foreign = () => ({ command: process.execPath, args: ["other", "mcp"] });

const client = (): SetupClient =>
  ({
    name: "cursor",
    format: "json",
    configPath: "/tmp/config.json",
  }) as SetupClient;

const decide = (servers: Record<string, unknown>) => {
  const text = JSON.stringify({ mcpServers: servers });
  return clientRegistrationRemoval(
    parseClientConfiguration(text, "json"),
    text,
    client(),
  );
};

describe("uninstall removal decision", () => {
  it("removes the current member", () => {
    const result = decide({ xtna: owned() });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toMatchObject({ removeNative: true });
  });

  it("removes the historical member when it is the only one", () => {
    const result = decide({ rea: owned() });
    expect(result.ok).toBe(true);
    // The historical key is the name this document registers under, so it is the native edit.
    if (result.ok) expect(result.value).toMatchObject({ removeNative: true });
  });

  it("leaves a foreign registration alone", () => {
    const result = decide({ xtna: foreign() });
    expect(result.ok).toBe(true);
    if (result.ok)
      expect(result.value).toMatchObject({
        removeNative: false,
        legacyPath: undefined,
      });
  });

  it.todo(
    "row 10: removes both members when both belong to this product (needs a multi-key removal)",
  );
});
