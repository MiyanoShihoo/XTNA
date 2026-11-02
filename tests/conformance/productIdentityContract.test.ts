import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { PRODUCT_IDENTITY } from "../../src/identity.js";
import {
  EXPECTED_BIN_NAMES,
  EXPECTED_MCP_KEY,
} from "../fixtures/acceptance/productContract.js";

/**
 * The acceptance suite states its expectations as hand-written literals. This test is the
 * other half of that arrangement: it fails when the product drifts from the contract, so a
 * rename cannot silently satisfy tests that derived their expectation from the product.
 */
describe("product identity contract", () => {
  it("registers under the contracted MCP server key", () => {
    expect(PRODUCT_IDENTITY.mcpServerKey).toBe(EXPECTED_MCP_KEY);
  });

  it("publishes exactly the contracted launcher names", async () => {
    const manifest = JSON.parse(
      await readFile(join(process.cwd(), "package.json"), "utf8"),
    ) as { bin?: Record<string, string> };
    expect(Object.keys(manifest.bin ?? {}).sort()).toEqual(
      [...EXPECTED_BIN_NAMES].sort(),
    );
  });
});
