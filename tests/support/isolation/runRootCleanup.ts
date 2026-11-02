import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { rm } from "node:fs/promises";
import {
  dirname,
  isAbsolute,
  resolve,
  sep,
  basename,
  relative,
} from "node:path";
import { tmpdir } from "node:os";

/**
 * Delete the directory this run created, and nothing else.
 *
 * The environment is the wrong authority here: this process exports TMP/TEMP, so
 * `os.tmpdir()` inside teardown points at the run root, not at the system temporary
 * directory that contains it. The runner therefore records the system temporary directory
 * and a per-run identifier before it overrides anything, and teardown trusts only that
 * record plus a marker file on disk.
 */
const RUN_ROOT_PREFIX = "rea-test-run-";
const MARKER = ".rea-run-identifier";

const refuse = (reason: string): never => {
  throw new Error(`Refusing to clean a test run root: ${reason}`);
};

/** The directory must be a real directory, not a link to one. */
const assertPlainDirectory = (root: string): void => {
  const stats = lstatSync(root);
  if (stats.isSymbolicLink()) refuse(`${root} is a symbolic link`);
  if (!stats.isDirectory()) refuse(`${root} is not a directory`);
};

interface RunRecord {
  readonly root: string;
  readonly systemTemp: string;
  readonly runIdentifier: string;
  readonly manifest?: string;
}

/**
 * Resolve what to delete without trusting the environment alone. Vitest's teardown runs in
 * a process that does not receive `test.env`, so the runner also writes a manifest beside
 * the root; either source is only accepted once the on-disk marker agrees with it.
 */
const readRecord = (): RunRecord | undefined => {
  const fromEnvironment: RunRecord | undefined = (() => {
    const root = process.env.REA_TEST_ISOLATION_RUN_ROOT;
    const systemTemp = process.env.REA_TEST_ISOLATION_SYSTEM_TEMP;
    const runIdentifier = process.env.REA_TEST_ISOLATION_RUN_ID;
    if (
      root === undefined ||
      root.trim() === "" ||
      systemTemp === undefined ||
      systemTemp.trim() === "" ||
      runIdentifier === undefined ||
      runIdentifier.trim() === ""
    )
      return undefined;
    return { root, systemTemp, runIdentifier };
  })();
  if (fromEnvironment !== undefined) return fromEnvironment;

  const systemTemp = realpathSync(tmpdir());
  const manifest = `${systemTemp}${sep}.rea-test-run-manifest.json`;
  let raw: string;
  try {
    raw = readFileSync(manifest, "utf8");
  } catch {
    return undefined;
  }
  const parsed = JSON.parse(raw) as Partial<RunRecord>;
  if (
    typeof parsed.root !== "string" ||
    typeof parsed.systemTemp !== "string" ||
    typeof parsed.runIdentifier !== "string"
  )
    refuse(`${manifest} does not describe a run`);
  return {
    root: parsed.root as string,
    systemTemp: parsed.systemTemp as string,
    runIdentifier: parsed.runIdentifier as string,
    manifest,
  };
};

export const teardown = async (): Promise<void> => {
  const record = readRecord();
  if (record === undefined) return;
  const { root, systemTemp, runIdentifier } = record;
  if (systemTemp === "" || runIdentifier === "")
    refuse("the run did not record its temporary directory and identifier");

  const absolute = resolve(root);
  if (!isAbsolute(absolute)) refuse(`${root} is not absolute`);
  if (!basename(absolute).startsWith(RUN_ROOT_PREFIX))
    refuse(`${absolute} does not carry the run-root prefix`);

  // The parent recorded at creation time, not `os.tmpdir()`: this process overrides TMP.
  const recordedParent = realpathSync(systemTemp);
  const actualParent = realpathSync(dirname(absolute));
  if (relative(recordedParent, actualParent) !== "")
    refuse(`${absolute} is not inside the recorded temporary directory`);
  const displacement = relative(recordedParent, absolute);
  if (displacement === "" || displacement.startsWith(`..${sep}`))
    refuse(`${absolute} is the temporary directory itself`);

  assertPlainDirectory(absolute);
  const marker = `${absolute}${sep}${MARKER}`;
  let observed = "";
  try {
    observed = readFileSync(marker, "utf8").trim();
  } catch {
    return refuse(`${absolute} carries no run marker`);
  }
  if (observed !== runIdentifier.trim())
    refuse(`${absolute} belongs to another run`);

  await rm(absolute, { recursive: true, force: true, maxRetries: 3 });
  if (record.manifest !== undefined) await rm(record.manifest, { force: true });
};
