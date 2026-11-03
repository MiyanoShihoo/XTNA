import { describe, expect, it } from "vitest";

import {
  effectiveProductServer,
  parseClientConfiguration,
  productServerName,
} from "./ClientConfigurationDocument.js";

/**
 * `productServerName` and `effectiveProductServer` must name the *same* member. They are two
 * derivations of one fact, and an independent review found a case where they disagreed: a null
 * current key next to a real historical one made the name say `xtna` while the value came from
 * `rea`, so a deny-list entry for `rea` was never consulted.
 */
const json = (servers: Record<string, unknown>) =>
  parseClientConfiguration(JSON.stringify({ mcpServers: servers }), "json");

describe("productServerName", () => {
  it("names the current key when it is the only registration", () => {
    expect(productServerName(json({ xtna: { command: "node" } }))).toBe("xtna");
  });

  it("names the historical key when that is the only registration", () => {
    expect(productServerName(json({ rea: { command: "node" } }))).toBe("rea");
  });

  it("prefers the current key when both are registered", () => {
    expect(
      productServerName(
        json({ xtna: { command: "node" }, rea: { command: "node" } }),
      ),
    ).toBe("xtna");
  });

  it("ignores a null current key, exactly as the value reader does", () => {
    const parsed = json({ xtna: null, rea: { command: "node" } });
    // The reader resolves through the historical member, so the name must too.
    expect(productServerName(parsed)).toBe("rea");
    expect(effectiveProductServer(parsed)).toMatchObject({ command: "node" });
  });

  it("reads an OpenCode V1 projection as the registered location", () => {
    // v2 keeps the managed table under `mcp.servers`; every other key there is a V1 server.
    const parsed = parseClientConfiguration(
      JSON.stringify({
        mcp: {
          servers: { other: { command: "node" } },
          rea: { command: "node" },
        },
      }),
      "opencode",
    );
    expect(parsed.dialect).toBe("opencode_v2");
    expect(productServerName(parsed)).toBe("rea");
    expect(effectiveProductServer(parsed)).toMatchObject({ command: "node" });
  });

  it("falls back to the current key so a caller always has a target name", () => {
    const parsed = json({});
    expect(productServerName(parsed)).toBe("xtna");
    expect(effectiveProductServer(parsed)).toBeUndefined();
  });
});
