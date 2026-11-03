import { describe, expect, it } from "vitest";

import {
  dialectCanDetectDuplicate,
  dialectCanRemoveHistorical,
} from "./RegistrationDialectCapability.js";
import {
  parseClientConfiguration,
  type ClientConfigurationDocument,
} from "./ClientConfigurationDocument.js";

/**
 * Contract §4 and §1 D. The expectation for every row comes from the contract table, not from
 * the implementation: a dialect is listed here because the contract says so.
 */
const document = (dialect: ClientConfigurationDocument["dialect"]) =>
  ({ dialect }) as ClientConfigurationDocument;

describe("dialectCanRemoveHistorical (§4)", () => {
  it.each(["toml", "grok"] as const)(
    "blocks %s because the only removal path drops every comment",
    (dialect) => {
      expect(dialectCanRemoveHistorical(document(dialect))).toBe(false);
    },
  );

  it.each([
    "json",
    "claude_code",
    "vscode",
    "copilot_cli",
    "opencode",
    "opencode_v2",
    "commandcode",
    "omp",
    "pi",
    "kimi",
    "hermes",
    "zcode",
    "zcode_fallback",
    "dsh",
  ] as const)("allows %s to delete a member", (dialect) => {
    expect(dialectCanRemoveHistorical(document(dialect))).toBe(true);
  });
});

describe("dialectCanDetectDuplicate (§1 D)", () => {
  it.each(["toml", "grok"] as const)(
    "refuses to claim a duplicate in %s, which cannot repeat a table",
    (dialect) => {
      expect(dialectCanDetectDuplicate(document(dialect))).toBe(false);
    },
  );

  it("refuses to claim a duplicate in Hermes YAML, which the shared helper skips", () => {
    expect(dialectCanDetectDuplicate(document("hermes"))).toBe(false);
  });

  it("refuses to claim a duplicate in the Harness projection of one entry", () => {
    expect(dialectCanDetectDuplicate(document("dsh"))).toBe(false);
  });

  it("claims a duplicate only where both keys can coexist", () => {
    expect(dialectCanDetectDuplicate(document("json"))).toBe(true);
    expect(dialectCanDetectDuplicate(document("opencode_v2"))).toBe(true);
  });

  it("agrees with the parsed document rather than the caller's label", () => {
    const parsed = parseClientConfiguration(
      JSON.stringify({ mcpServers: { xtna: { command: "node" } } }),
      "json",
    );
    expect(dialectCanRemoveHistorical(parsed)).toBe(true);
    expect(dialectCanDetectDuplicate(parsed)).toBe(true);
  });
});
