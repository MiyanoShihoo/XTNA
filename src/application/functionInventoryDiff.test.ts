import { describe, expect, it } from "vitest";

import {
  diffFunctionInventoryDocuments,
  parseFunctionInventory,
} from "./functionInventoryDiff.js";

describe("function inventory documents", () => {
  it("accepts the three documented inventory shapes", () => {
    for (const value of [
      [],
      { functions: [] },
      { items: [] },
      { evidence: [] },
    ])
      expect(parseFunctionInventory(value).ok).toBe(true);
  });

  it("rejects a document that is not an inventory", () => {
    for (const value of [null, 42, "text", {}, { functions: "no" }]) {
      const parsed = parseFunctionInventory(value);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok)
        expect("operation" in parsed.error && parsed.error.operation).toBe(
          "diff_functions",
        );
    }
  });

  it("rejects a document that declares more than one inventory array", () => {
    const parsed = parseFunctionInventory({ functions: [], items: [] });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok)
      expect(JSON.stringify(parsed.error)).toContain("exactly one is required");
  });

  it("rejects an entry that is not analyze_function Evidence", () => {
    const parsed = parseFunctionInventory([{ nope: true }]);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error.message.length).toBeGreaterThan(0);
  });

  it("diffs two empty inventories without inventing a change", () => {
    const diff = diffFunctionInventoryDocuments([], { functions: [] });
    expect(diff.ok).toBe(true);
    if (diff.ok)
      expect(diff.value.summary).toEqual({
        unchanged: 0,
        changed: 0,
        unknown: 0,
        only_before: 0,
        only_after: 0,
        unpaired: 0,
      });
  });
});
