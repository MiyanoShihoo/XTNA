import { describe, expect, it } from "vitest";

import { authorizeCommand } from "./CommandAuthority.js";

describe("command authority tiers", () => {
  it("admits L1 reads and keeps a dry run observation-only", () => {
    expect(
      authorizeCommand({ operation: "list", authority: "read-only" }),
    ).toMatchObject({ allowed: true, executed: true, tier: "L1" });
    expect(
      authorizeCommand({
        operation: "list",
        authority: "read-only",
        dryRun: true,
      }),
    ).toMatchObject({ allowed: true, executed: false, tier: "L1" });
  });

  it("requires an isolated admission for L2 writes", () => {
    expect(
      authorizeCommand({ operation: "write", authority: "write" }),
    ).toMatchObject({ allowed: false, executed: false, tier: "L2" });
    expect(
      authorizeCommand({
        operation: "write",
        authority: "write",
        sandboxed: true,
      }),
    ).toMatchObject({ allowed: true, executed: true, tier: "L2" });
  });

  it("requires approval and a diff preview for L3 destructive work", () => {
    expect(
      authorizeCommand({ operation: "delete", authority: "destructive" }),
    ).toMatchObject({ allowed: false, tier: "L3" });
    expect(
      authorizeCommand({
        operation: "delete",
        authority: "destructive",
        approved: true,
      }),
    ).toMatchObject({ allowed: false, tier: "L3" });
    expect(
      authorizeCommand({
        operation: "delete",
        authority: "destructive",
        approved: true,
        diffPreview: "- old\n+ new",
      }),
    ).toMatchObject({ allowed: true, executed: true, tier: "L3" });
  });

  it("plans write and destructive operations without executing on dry run", () => {
    expect(
      authorizeCommand({
        operation: "write",
        authority: "write",
        dryRun: true,
      }),
    ).toMatchObject({ allowed: true, executed: false, tier: "L2" });
    expect(
      authorizeCommand({
        operation: "delete",
        authority: "destructive",
        dryRun: true,
      }),
    ).toMatchObject({ allowed: true, executed: false, tier: "L3" });
  });
});
