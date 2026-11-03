import { describe, expect, it } from "vitest";
import { resolve } from "node:path";

import {
  parseClientConfiguration,
  type ClientConfigurationDocument,
} from "./ClientConfigurationDocument.js";
import type { ClientConfigurationSource } from "./ClientConfigurationFiles.js";
import {
  commandOwnershipClassifier,
  registrationContext,
  toRegistrationSources,
} from "./ProductRegistrationSources.js";
import { resolveProductRegistration } from "./ProductRegistrationResolution.js";

const json = (servers: Record<string, unknown>) =>
  parseClientConfiguration(JSON.stringify({ mcpServers: servers }), "json");

const source = (
  servers: Record<string, unknown>,
  sourcePath: string,
): ClientConfigurationSource => ({
  ...(json(servers) as ClientConfigurationDocument),
  sourcePath,
});

describe("toRegistrationSources", () => {
  it("makes the written file the document tier and every other file a lower layer", () => {
    const sources = toRegistrationSources(
      [
        source({ rea: { command: "global" } }, "/etc/g.json"),
        source({ xtna: {} }, "/home/c.json"),
      ],
      { targetPath: "/home/c.json" },
    );
    expect(
      sources.map(({ sourcePath, tier, writable }) => [
        sourcePath,
        tier,
        writable,
      ]),
    ).toEqual([
      ["/etc/g.json", "lower-layer", false],
      ["/home/c.json", "document", true],
    ]);
  });

  it("marks a settings file the product does not own as a read-only source", () => {
    const sources = toRegistrationSources(
      [source({}, "/home/system.json"), source({}, "/home/c.json")],
      { targetPath: "/home/c.json", readOnlyPaths: ["/home/system.json"] },
    );
    expect(sources[0]?.tier).toBe("read-only-source");
    expect(sources[1]?.tier).toBe("document");
  });

  it("treats every file as a lower layer when there is no write target", () => {
    const sources = toRegistrationSources([source({}, "/home/c.json")], {
      targetPath: undefined,
    });
    expect(sources[0]?.tier).toBe("lower-layer");
    expect(sources[0]?.writable).toBe(false);
  });

  it("keeps the reader's order so the resolver reports the member it was given", () => {
    const sources = toRegistrationSources(
      [source({ rea: {} }, "/a"), source({ xtna: {} }, "/b")],
      { targetPath: "/b" },
    );
    const resolved = resolveProductRegistration(
      sources,
      registrationContext(() => "owned"),
    );
    // The resolver ranks the document tier first, so the writable member leads.
    expect(resolved.members.map((member) => member.sourcePath)).toEqual([
      "/b",
      "/a",
    ]);
    // Row 13: current in the document tier next to a historical lower layer.
    expect(resolved.duplicate).toBe(true);
    expect(resolved.conflicts).toContainEqual({
      kind: "lower_layer",
      keys: ["rea"],
    });
  });
});

describe("registrationContext", () => {
  it("refuses to retire a TOML member without the caller having to remember §4", () => {
    const toml = parseClientConfiguration(
      `[mcp_servers.rea]\ncommand = "node"\n`,
      "toml",
    );
    const resolved = resolveProductRegistration(
      [
        {
          document: toml,
          tier: "document",
          writable: true,
          sourcePath: "/c.toml",
        },
      ],
      registrationContext(() => "owned"),
    );
    expect(resolved.retire).toEqual([]);
    expect(resolved.target).toBeUndefined();
  });
});

describe("commandOwnershipClassifier", () => {
  const entry = resolve("scripts/rea.mjs");
  const classifier = (currentCommandPath: string | undefined = entry) =>
    commandOwnershipClassifier(
      { name: "claude_code", format: "claude_code" },
      currentCommandPath,
    );

  it("owns a registration that launches this build", () => {
    expect(
      classifier()({ command: process.execPath, args: [entry, "mcp"] }),
    ).toBe("owned");
  });

  it("reports another product's launcher as foreign", () => {
    // Ownership is decided by comparing resolved files: a path that does not exist cannot be
    // compared, so it is `unknown`. The runtime binary exists and is not this build's entry.
    expect(classifier()({ command: process.execPath, args: ["mcp"] })).toBe(
      "foreign",
    );
  });

  it("keeps an unparseable value unknown rather than granting ownership", () => {
    expect(classifier()({ args: ["mcp"] })).toBe("unknown");
    expect(classifier()(undefined)).toBe("unknown");
  });
});
