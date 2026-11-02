import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";

const CLEANUP = pathToFileURL(
  resolve("tests/support/isolation/runRootCleanup.ts"),
).href;

/** Run the teardown in its own process, exactly as the runner does. */
const teardown = (environment: Record<string, string>): number | null =>
  spawnSync(
    process.execPath,
    [
      "--experimental-strip-types",
      "--input-type=module",
      "-e",
      `const m = await import(${JSON.stringify(CLEANUP)}); await m.teardown();`,
    ],
    {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH ?? "",
        SystemRoot: process.env.SystemRoot,
        ...environment,
      },
    },
  ).status;

const makeRun = (
  identifier = "run-a",
): { root: string; systemTemp: string } => {
  const systemTemp = mkdtempSync(join(tmpdir(), "rea-cleanup-guard-"));
  const root = join(systemTemp, "rea-test-run-fixture");
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, ".rea-run-identifier"), identifier);
  return { root, systemTemp };
};

it("removes the run root when its identity matches", () => {
  const { root, systemTemp } = makeRun("run-a");
  const status = teardown({
    REA_TEST_ISOLATION_RUN_ROOT: root,
    REA_TEST_ISOLATION_SYSTEM_TEMP: systemTemp,
    REA_TEST_ISOLATION_RUN_ID: "run-a",
  });
  expect(status).toBe(0);
  expect(existsSync(root)).toBe(false);
  expect(existsSync(systemTemp)).toBe(true);
});

it("refuses a directory that carries no run marker", () => {
  const systemTemp = mkdtempSync(join(tmpdir(), "rea-cleanup-guard-"));
  const root = join(systemTemp, "rea-test-run-unmarked");
  mkdirSync(root, { recursive: true });
  const status = teardown({
    REA_TEST_ISOLATION_RUN_ROOT: root,
    REA_TEST_ISOLATION_SYSTEM_TEMP: systemTemp,
    REA_TEST_ISOLATION_RUN_ID: "run-a",
  });
  expect(status).not.toBe(0);
  expect(existsSync(root)).toBe(true);
});

it("refuses a directory that belongs to another run", () => {
  const { root, systemTemp } = makeRun("run-b");
  const status = teardown({
    REA_TEST_ISOLATION_RUN_ROOT: root,
    REA_TEST_ISOLATION_SYSTEM_TEMP: systemTemp,
    REA_TEST_ISOLATION_RUN_ID: "run-a",
  });
  expect(status).not.toBe(0);
  expect(existsSync(root)).toBe(true);
});

it("refuses a target redirected outside the recorded temporary directory", () => {
  const { root } = makeRun("run-a");
  const otherTemp = mkdtempSync(join(tmpdir(), "rea-cleanup-other-"));
  const status = teardown({
    REA_TEST_ISOLATION_RUN_ROOT: root,
    REA_TEST_ISOLATION_SYSTEM_TEMP: otherTemp,
    REA_TEST_ISOLATION_RUN_ID: "run-a",
  });
  expect(status).not.toBe(0);
  expect(existsSync(root)).toBe(true);
});

it("refuses a symbolic link in place of the run root", () => {
  const { root, systemTemp } = makeRun("run-a");
  const link = join(systemTemp, "rea-test-run-link");
  symlinkSync(root, link, "junction");
  const status = teardown({
    REA_TEST_ISOLATION_RUN_ROOT: link,
    REA_TEST_ISOLATION_SYSTEM_TEMP: systemTemp,
    REA_TEST_ISOLATION_RUN_ID: "run-a",
  });
  expect(status).not.toBe(0);
  expect(existsSync(root)).toBe(true);
});

it("refuses when the target is the temporary directory itself", () => {
  const { systemTemp } = makeRun("run-a");
  const status = teardown({
    REA_TEST_ISOLATION_RUN_ROOT: systemTemp,
    REA_TEST_ISOLATION_SYSTEM_TEMP: systemTemp,
    REA_TEST_ISOLATION_RUN_ID: "run-a",
  });
  expect(status).not.toBe(0);
  expect(existsSync(systemTemp)).toBe(true);
});
