import { describe, expect, it } from "vitest";

import { parseClientConfiguration } from "./ClientConfigurationDocument.js";
import {
  resolveProductRegistration,
  type ProductRegistrationContext,
  type ProductRegistrationSource,
} from "./ProductRegistrationResolution.js";

/**
 * Contract tests for P1 batch 1 (`P1-IDENTITY-CONTRACT.md` §1 D/O, §2, §3 rows 1–13).
 *
 * Expectations are written from the contract, not from the resolver: ownership is supplied
 * by a stub classifier so the test never reads the implementation to decide what to expect.
 */

const CURRENT = "xtna";
const LEGACY = "rea";

const classify =
  (verdict: "owned" | "foreign" | "unknown") =>
  (_value: unknown): "owned" | "foreign" | "unknown" =>
    verdict;

const json = (servers: Record<string, unknown>) =>
  parseClientConfiguration(JSON.stringify({ mcpServers: servers }), "json");

const source = (
  document: ProductRegistrationSource["document"],
  tier: ProductRegistrationSource["tier"] = "document",
  writable = true,
  path = "/tmp/config.json",
): ProductRegistrationSource => ({
  document,
  tier,
  writable,
  sourcePath: path,
});

const context = (
  verdict: "owned" | "foreign" | "unknown" = "owned",
  duplicateDetectable = true,
  canRemove = true,
): ProductRegistrationContext => ({
  classifyOwnership: classify(verdict),
  duplicateDetectable: () => duplicateDetectable,
  dialectCanRemove: () => canRemove,
});

describe("discovery", () => {
  it("1a. finds a current-identity member", () => {
    const result = resolveProductRegistration(
      [source(json({ [CURRENT]: { command: "node" } }))],
      context(),
    );
    expect(result.present).toBe(true);
    expect(result.members).toHaveLength(1);
    expect(result.members[0]).toMatchObject({
      key: CURRENT,
      identity: "current",
      tier: "document",
      writable: true,
    });
  });

  it("1b. finds a historical-identity member", () => {
    const result = resolveProductRegistration(
      [source(json({ [LEGACY]: { command: "node" } }))],
      context(),
    );
    expect(result.members).toHaveLength(1);
    expect(result.members[0]).toMatchObject({
      key: LEGACY,
      identity: "legacy",
    });
  });

  it("1c. finds both and reports a duplicate, current first", () => {
    const result = resolveProductRegistration(
      [
        source(
          json({
            [CURRENT]: { command: "node" },
            [LEGACY]: { command: "node" },
          }),
        ),
      ],
      context(),
    );
    expect(result.members.map((member) => member.key)).toEqual([
      CURRENT,
      LEGACY,
    ]);
    expect(result.duplicate).toBe(true);
    expect(result.conflicts).toContainEqual({
      kind: "duplicate",
      keys: [CURRENT, LEGACY],
    });
  });

  it("1d. reports absence without inventing a member", () => {
    const result = resolveProductRegistration([source(json({}))], context());
    expect(result.present).toBe(false);
    expect(result.members).toHaveLength(0);
    expect(result.primary).toBeUndefined();
  });

  it("2. marks a lower-layer member non-writable and never a retire candidate", () => {
    const result = resolveProductRegistration(
      [
        source(json({ [CURRENT]: { command: "node" } })),
        source(
          json({ [LEGACY]: { command: "old" } }),
          "lower-layer",
          false,
          "/etc/global.json",
        ),
      ],
      context("owned"),
    );
    const lower = result.members.find(
      (member) => member.tier === "lower-layer",
    );
    expect(lower).toMatchObject({ writable: false, identity: "legacy" });
    expect(result.retire.map((member) => member.key)).not.toContain(LEGACY);
    expect(result.conflicts).toContainEqual({
      kind: "lower_layer",
      keys: [LEGACY],
    });
  });

  it("3. keeps an ownership verdict of unknown instead of inferring ownership", () => {
    const result = resolveProductRegistration(
      [source(json({ [LEGACY]: { command: "unparseable" } }))],
      context("unknown"),
    );
    expect(result.members[0]?.ownership).toBe("unknown");
    // The contract forbids treating an unknown member as ours to write or delete.
    expect(result.target).toBeUndefined();
    expect(result.retire).toHaveLength(0);
  });

  it("5. does not claim a duplicate the dialect cannot detect", () => {
    const result = resolveProductRegistration(
      [
        source(
          json({
            [CURRENT]: { command: "node" },
            [LEGACY]: { command: "node" },
          }),
        ),
      ],
      context("owned", false),
    );
    expect(result.members).toHaveLength(2);
    // Members are still discovered; the *duplicate verdict* is what the dialect cannot prove.
    expect(result.duplicate).toBe(false);
    expect(
      result.conflicts.some((conflict) => conflict.kind === "duplicate"),
    ).toBe(false);
  });
});

describe("ownership and authorisation", () => {
  it("9. never lists a foreign member as removable", () => {
    const result = resolveProductRegistration(
      [source(json({ [CURRENT]: { command: "someone-else" } }))],
      context("foreign"),
    );
    expect(result.members[0]?.ownership).toBe("foreign");
    expect(result.retire).toHaveLength(0);
    expect(result.target).toBeUndefined();
  });

  it("10. a legacy-only document exposes the legacy identity (never current)", () => {
    const result = resolveProductRegistration(
      [source(json({ [LEGACY]: { command: "node" } }))],
      context("owned"),
    );
    expect(result.primary?.identity).toBe("legacy");
    expect(result.conflicts).toContainEqual({
      kind: "legacy_identity",
      keys: [LEGACY],
    });
  });

  it("11. marks the duplicate conflict even when both members are owned", () => {
    const result = resolveProductRegistration(
      [
        source(
          json({
            [CURRENT]: { command: "node" },
            [LEGACY]: { command: "node" },
          }),
        ),
      ],
      context("owned"),
    );
    expect(result.duplicate).toBe(true);
  });

  it("an owned writable document member is the only write target", () => {
    const result = resolveProductRegistration(
      [source(json({ [CURRENT]: { command: "node" } }))],
      context("owned"),
    );
    expect(result.target?.key).toBe(CURRENT);
  });

  it("12. retire contains only owned, writable, document-tier historical members", () => {
    const result = resolveProductRegistration(
      [
        source(json({ [CURRENT]: { command: "node" } })),
        source(json({ [LEGACY]: { command: "node" } })),
      ],
      context("owned"),
    );
    expect(result.retire.map((member) => member.key)).toEqual([LEGACY]);
  });
});

describe("source evidence", () => {
  it("13. keeps one member per source and never merges two sources into one", () => {
    const result = resolveProductRegistration(
      [
        source(
          json({ [CURRENT]: { command: "node" } }),
          "document",
          true,
          "/a",
        ),
        source(
          json({ [CURRENT]: { command: "node" } }),
          "lower-layer",
          false,
          "/b",
        ),
      ],
      context("owned"),
    );
    expect(result.members).toHaveLength(2);
    expect(result.members.map((member) => member.sourcePath)).toEqual([
      "/a",
      "/b",
    ]);
  });
});

describe("shape", () => {
  it("23. reports no policy edits in batch 1", () => {
    const result = resolveProductRegistration(
      [source(json({ [CURRENT]: { command: "node" } }))],
      context("owned"),
    );
    expect(result.policyEdits).toEqual([]);
  });

  it("18. adds no field beyond the contract's set", () => {
    const result = resolveProductRegistration([source(json({}))], context());
    const allowed = [
      "conflicts",
      "duplicate",
      "members",
      "policyEdits",
      "present",
      "primary",
      "retire",
      "target",
    ];
    for (const key of Object.keys(result)) expect(allowed).toContain(key);
  });
});

describe("review r6 fixes", () => {
  it("C1. a member in another tier is a duplicate, not only a lower-layer note", () => {
    const result = resolveProductRegistration(
      [
        source(
          json({ [CURRENT]: { command: "node" } }),
          "document",
          true,
          "/a",
        ),
        source(
          json({ [LEGACY]: { command: "node" } }),
          "lower-layer",
          false,
          "/b",
        ),
      ],
      context("owned"),
    );
    expect(result.duplicate).toBe(true);
    expect(result.conflicts).toContainEqual({
      kind: "duplicate",
      keys: [CURRENT, LEGACY],
    });
    expect(result.conflicts).toContainEqual({
      kind: "lower_layer",
      keys: [LEGACY],
    });
  });

  it("H1. a dialect that cannot remove yields no retire candidate", () => {
    const result = resolveProductRegistration(
      [
        source(json({ [CURRENT]: { command: "node" } })),
        source(json({ [LEGACY]: { command: "node" } })),
      ],
      context("owned", true, false),
    );
    expect(result.retire).toHaveLength(0);
  });

  it("H5. an unknown member is reported, not silent", () => {
    const result = resolveProductRegistration(
      [source(json({ [CURRENT]: { command: "?" } }))],
      context("unknown"),
    );
    expect(result.conflicts).toContainEqual({
      kind: "unknown_ownership",
      keys: [CURRENT],
    });
  });

  it("H4. two files holding one member each are not a duplicate", () => {
    const result = resolveProductRegistration(
      [
        source(
          json({ [CURRENT]: { command: "node" } }),
          "document",
          true,
          "/a",
        ),
        source(json({ [LEGACY]: { command: "node" } }), "document", true, "/b"),
      ],
      context("owned"),
    );
    expect(result.members).toHaveLength(2);
    expect(result.duplicate).toBe(false);
  });

  it("C2. the Harness registers under the current identity", () => {
    const harness = parseClientConfiguration(
      JSON.stringify([
        { insert: [{ id: "rea-mcp", config: { serverName: "rea" } }] },
      ]),
      "dsh",
    );
    const result = resolveProductRegistration(
      [source(harness)],
      context("owned"),
    );
    expect(result.members[0]?.identity).toBe("current");
    expect(result.conflicts.some((c) => c.kind === "legacy_identity")).toBe(
      false,
    );
  });
});

/**
 * Second review round. Each case below failed against `9679772`; the expectation comes from the
 * contract clause named in the title, not from the resolver's current behaviour.
 */
describe("review round 2", () => {
  const toml = (text: string) => parseClientConfiguration(text, "toml");
  const tomlCannotRemove = (document: { dialect: string }) =>
    document.dialect !== "toml";

  it("H1. gates retire and target on the member's own document, not on a path lookup", () => {
    // Neither source reports a path, which is legal: `sourcePath` is optional. Re-deriving the
    // document from it made the gate judge `sources[0]` and offer the TOML member for removal.
    const result = resolveProductRegistration(
      [
        {
          document: json({ [CURRENT]: { command: "node" } }),
          tier: "document",
          writable: true,
        },
        {
          document: toml(`[mcp_servers.rea]\ncommand = "node"\n`),
          tier: "document",
          writable: true,
        },
      ],
      {
        classifyOwnership: () => "owned",
        duplicateDetectable: () => true,
        dialectCanRemove: tomlCannotRemove,
      },
    );
    expect(result.members.map((member) => member.key)).toContain(LEGACY);
    // §4: a dialect that cannot remove acceptably never yields a candidate.
    expect(result.retire).toEqual([]);
    // §6: `target` is a write target, so it carries the same gate.
    expect(result.target?.key).toBe(CURRENT);
  });

  it("H1. offers no write target for a TOML document at all", () => {
    const result = resolveProductRegistration(
      [
        source(
          toml(`[mcp_servers.rea]\ncommand = "node"\n`),
          "document",
          true,
          "/codex.toml",
        ),
      ],
      {
        classifyOwnership: () => "owned",
        duplicateDetectable: () => false,
        dialectCanRemove: tomlCannotRemove,
      },
    );
    expect(result.members[0]?.identity).toBe("legacy");
    expect(result.retire).toEqual([]);
    expect(result.target).toBeUndefined();
  });

  it("C1. reports a cross-tier duplicate even when the dialect cannot repeat a key", () => {
    const result = resolveProductRegistration(
      [
        source(
          toml(`[mcp_servers.${CURRENT}]\ncommand = "node"\n`),
          "document",
          true,
          "/codex.toml",
        ),
        source(
          json({ [LEGACY]: { command: "node" } }),
          "lower-layer",
          false,
          "/layers.json",
        ),
      ],
      {
        classifyOwnership: () => "owned",
        // TOML cannot express a repeated table; that says nothing about a pair in two files.
        duplicateDetectable: (document) => document.dialect !== "toml",
        dialectCanRemove: tomlCannotRemove,
      },
    );
    expect(result.duplicate).toBe(true);
    expect(result.conflicts).toContainEqual({
      kind: "duplicate",
      keys: [CURRENT, LEGACY],
    });
    expect(result.conflicts).toContainEqual({
      kind: "lower_layer",
      keys: [LEGACY],
    });
  });

  it("M1. reports a read-only-tier member as lower_layer, never as a policy conflict", () => {
    const result = resolveProductRegistration(
      [
        source(json({ [CURRENT]: { command: "node" } })),
        source(
          json({ [LEGACY]: { command: "node" } }),
          "read-only-source",
          false,
          "/etc/settings.json",
        ),
      ],
      context("owned"),
    );
    // §3 row 9: a member outside the document tier is `lower_layer`.
    expect(result.conflicts).toContainEqual({
      kind: "lower_layer",
      keys: [LEGACY],
    });
    // `policy_in_read_only_tier` is row 3b's *policy list* in a read-only tier (§6 union).
    expect(
      result.conflicts.some(
        (conflict) => conflict.kind === "policy_in_read_only_tier",
      ),
    ).toBe(false);
  });

  it("M4. a member's value does not alias the parsed document", () => {
    const document = json({ [CURRENT]: { command: "node" } });
    const result = resolveProductRegistration(
      [
        {
          document,
          tier: "document",
          writable: true,
          sourcePath: "/tmp/config.json",
        },
      ],
      context("owned"),
    );
    (result.members[0]!.value as { command: string }).command = "MUTATED";
    // A batch-2 write path reads the parsed document; a member must not be able to pre-edit it.
    expect(document.servers[CURRENT]).toMatchObject({ command: "node" });
  });
});
