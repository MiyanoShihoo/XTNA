/**
 * Hand-written contract for the registration surface the acceptance suite drives.
 *
 * These values are deliberately **not** imported from `src/` or `dist/`. A test whose
 * expectation is read from the implementation cannot detect an implementation regression:
 * rename the key in `identity.ts` and a derived expectation would follow it silently.
 * `tests/conformance/productIdentityContract.test.ts` asserts the product still matches
 * these literals, so drift surfaces as a failure instead of a moving target.
 */

/**
 * The MCP server key this product registers under. Fixtures build their documents with
 * it, and assertions read it back.
 */
export const EXPECTED_MCP_KEY = "xtna";

/**
 * The key earlier releases installed under. Only used where a test deliberately models a
 * pre-rename install; it must never be the expectation for a fresh setup.
 */
export const LEGACY_MCP_KEY = "rea";

/** Suffix this product appends to a configuration it backed up before editing. */
export const EXPECTED_BACKUP_SUFFIX = "rea";

/**
 * Launcher names `package.json` publishes. After the rename this is the current name only;
 * `rea` survives solely as the `scripts/rea.mjs` file name and as a keyword.
 */
export const EXPECTED_BIN_NAMES = ["xtna"] as const;
