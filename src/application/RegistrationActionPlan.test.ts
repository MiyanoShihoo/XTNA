import { describe, expect, it } from "vitest";

import { decideRegistrationAction } from "./RegistrationActionPlan.js";
import {
  parseClientConfiguration,
  type ClientConfigurationDocument,
} from "./ClientConfigurationDocument.js";
import {
  resolveProductRegistration,
  type ProductRegistration,
  type ProductRegistrationContext,
  type ProductRegistrationSource,
  type RegistrationOwnership,
} from "./ProductRegistrationResolution.js";

/**
 * Contract §3, rows 6–13. Each case builds the registration through the real resolver and then
 * asks the action phase what the verb may do, so the expectation is the contract row rather than
 * the plan's own branch shape.
 *
 * Rows 14 (`unparseable`) and 15 (manual-only dialect) are reported by the configuration reader
 * before a registration exists; they cannot be expressed here and are covered by the status
 * layer, not by this table.
 */

const json = (servers: Record<string, unknown>, serversKey = "mcpServers") =>
  parseClientConfiguration(JSON.stringify({ [serversKey]: servers }), "json");

const toml = (text: string) => parseClientConfiguration(text, "toml");

const source = (
  document: ClientConfigurationDocument,
  tier: ProductRegistrationSource["tier"] = "document",
  writable = true,
  sourcePath = "/tmp/config.json",
): ProductRegistrationSource => ({ document, tier, writable, sourcePath });

const context = (
  ownership: RegistrationOwnership = "owned",
  canRemove = true,
): ProductRegistrationContext => ({
  classifyOwnership: () => ownership,
  duplicateDetectable: () => true,
  dialectCanRemove: () => canRemove,
});

const plan = (
  sources: readonly ProductRegistrationSource[],
  verb: "setup" | "uninstall",
  ctx: ProductRegistrationContext = context(),
): ReturnType<typeof decideRegistrationAction> =>
  decideRegistrationAction(
    resolveProductRegistration(sources, ctx) as ProductRegistration,
    verb,
  );

const bothKeys = () =>
  json({ xtna: { command: "node" }, rea: { command: "node" } });

describe("§3 row 6 — historical only, owned, document tier", () => {
  it("migrates on setup", () => {
    const result = plan([source(json({ rea: { command: "node" } }))], "setup");
    expect(result.action).toBe("MIGRATE");
    // Row 6 has no document-tier current member yet, so the plan names the key to create.
    expect(result.writeKey).toBe("xtna");
    expect(result.retire.map((member) => member.key)).toEqual(["rea"]);
  });

  it("blocks the migration in TOML, where removal costs every comment", () => {
    const result = plan(
      [
        source(
          toml(`[mcp_servers.rea]\ncommand = "node"\n`),
          "document",
          true,
          "/c.toml",
        ),
      ],
      "setup",
      context("owned", false),
    );
    expect(result.action).toBe("BLOCK");
    expect(result.retire).toEqual([]);
  });

  it("deletes on uninstall", () => {
    const result = plan(
      [source(json({ rea: { command: "node" } }))],
      "uninstall",
    );
    expect(result.action).toBe("DELETE");
    expect(result.retire.map((member) => member.key)).toEqual(["rea"]);
  });
});

describe("§3 rows 7/8 — historical only, not ours", () => {
  it.each(["foreign", "unknown"] as const)(
    "blocks setup for %s ownership",
    (ownership) => {
      const result = plan(
        [source(json({ rea: { command: "node" } }))],
        "setup",
        context(ownership),
      );
      expect(result.action).toBe("BLOCK");
      expect(result.retire).toEqual([]);
    },
  );

  it("retains on uninstall", () => {
    const result = plan(
      [source(json({ rea: { command: "node" } }))],
      "uninstall",
      context("foreign"),
    );
    expect(result.action).toBe("RETAIN");
    expect(result.retire).toEqual([]);
  });
});

describe("§3 row 9 — historical only, lower layer", () => {
  it("blocks setup because the file cannot be rewritten", () => {
    const result = plan(
      [
        source(
          json({ rea: { command: "node" } }),
          "lower-layer",
          false,
          "/etc/global.json",
        ),
      ],
      "setup",
    );
    expect(result.action).toBe("BLOCK");
  });
});

describe("§3 rows 10–12b — both identities in the document tier", () => {
  it("row 10 setup migrates to the current member only", () => {
    const result = plan([source(bothKeys())], "setup");
    expect(result.action).toBe("MIGRATE");
    expect(result.target?.key).toBe("xtna");
    expect(result.retire.map((member) => member.key)).toEqual(["rea"]);
  });

  it("row 10 uninstall deletes both and declares only the current key", () => {
    const result = plan([source(bothKeys())], "uninstall");
    expect(result.action).toBe("DELETE");
    expect(result.retire.map((member) => member.key).sort()).toEqual([
      "rea",
      "xtna",
    ]);
    expect(result.policyEdits).toEqual([
      { list: "deny", key: "xtna", outcome: "removed" },
    ]);
  });

  it("row 11 setup blocks when the historical member is not ours", () => {
    const result = plan(
      [
        {
          document: json({
            xtna: { command: "node" },
            rea: { command: "someone" },
          }),
          tier: "document",
          writable: true,
          sourcePath: "/a",
        },
      ],
      "setup",
      {
        classifyOwnership: (_value, key) =>
          key === "rea" ? "foreign" : "owned",
        duplicateDetectable: () => true,
        dialectCanRemove: () => true,
      },
    );
    expect(result.action).toBe("BLOCK");
  });

  it("row 12 uninstall deletes only the historical member when the current one is not ours", () => {
    const result = plan(
      [
        {
          document: json({
            xtna: { command: "someone" },
            rea: { command: "node" },
          }),
          tier: "document",
          writable: true,
          sourcePath: "/a",
        },
      ],
      "uninstall",
      {
        classifyOwnership: (_value, key) =>
          key === "xtna" ? "foreign" : "owned",
        duplicateDetectable: () => true,
        dialectCanRemove: () => true,
      },
    );
    expect(result.action).toBe("DELETE");
    expect(result.retire.map((member) => member.key)).toEqual(["rea"]);
  });

  it("row 12b uninstall retains everything when neither member is ours", () => {
    const result = plan([source(bothKeys())], "uninstall", context("foreign"));
    expect(result.action).toBe("RETAIN");
    expect(result.retire).toEqual([]);
  });
});

describe("§3 row 13 — current in document, historical below it", () => {
  it("retains both and names the file on uninstall", () => {
    const result = plan(
      [
        source(json({ xtna: { command: "node" } }), "document", true, "/a"),
        source(
          json({ rea: { command: "node" } }),
          "lower-layer",
          false,
          "/etc/global.json",
        ),
      ],
      "uninstall",
    );
    expect(result.action).toBe("BLOCK");
    expect(result.retire).toEqual([]);
    expect(result.reason).toContain("/etc/global.json");
  });
});

describe("nothing to do", () => {
  it("is a no-op when no registration exists", () => {
    const empty = plan([source(json({}))], "setup");
    expect(empty.action).toBe("NOOP");
  });

  it("is a no-op for setup when the current member is already in place", () => {
    const result = plan([source(json({ xtna: { command: "node" } }))], "setup");
    expect(result.action).toBe("RETAIN");
  });

  it("deletes the current member on uninstall", () => {
    const result = plan(
      [source(json({ xtna: { command: "node" } }))],
      "uninstall",
    );
    expect(result.action).toBe("DELETE");
    expect(result.retire.map((member) => member.key)).toEqual(["xtna"]);
  });

  it("never writes when ownership is unknown anywhere", () => {
    const result = plan(
      [source(json({ rea: { command: "node" } }))],
      "uninstall",
      context("unknown"),
    );
    expect(result.action).toBe("BLOCK");
    expect(result.retire).toEqual([]);
  });
});
