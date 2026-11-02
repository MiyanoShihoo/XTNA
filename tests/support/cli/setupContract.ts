import { expect } from "vitest";

/**
 * Exit code this product documents for each setup status (`docs/cli.md`):
 * `0` for `ready`, `1` for `needs_confirmation` or `needs_human`.
 */
const SETUP_STATUS_EXIT: Readonly<Record<string, number>> = {
  ready: 0,
  // A `--dry-run` plan writes nothing and is not a human decision point.
  planned: 0,
  needs_confirmation: 1,
  needs_human: 1,
};

/**
 * Assert the documented setup outcome contract instead of a bare `exitCode === 0`.
 *
 * A zero exit says nothing about whether setup did the right thing, and it is not stable
 * across environments: `needs_human` is the documented result when the surrounding
 * environment lacks an analysis engine, which is exactly the case in these fixtures.
 * This keeps the pairing strict — an unknown status, or an exit code that disagrees with
 * the reported status, still fails — while removing the accidental dependency on which
 * optional engines happen to be installed.
 */
export const expectSetupContract = (run: {
  readonly exitCode: number | null;
  readonly stdout?: string;
  readonly json: unknown;
}): string => {
  const status = (run.json as { status?: unknown }).status;
  expect(typeof status, run.stdout ?? JSON.stringify(run.json)).toBe("string");
  const expected = SETUP_STATUS_EXIT[status as string];
  expect(
    expected,
    `unrecognized setup status: ${String(status)}`,
  ).toBeDefined();
  expect(run.exitCode, run.stdout).toBe(expected);
  return status as string;
};
