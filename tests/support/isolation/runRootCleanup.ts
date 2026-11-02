import { realpathSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, isAbsolute } from "node:path";

/**
 * Remove the directory this run created, and nothing else.
 *
 * The root comes from the environment the runner set. Cleanup refuses to act unless the
 * path is absolute, still exists, and lies strictly beneath the OS temporary directory,
 * so a corrupted or inherited value cannot widen the deletion.
 */
const assertRemovableRoot = (root: string): void => {
  if (!isAbsolute(root))
    throw new Error(`Refusing cleanup of non-absolute run root: ${root}`);
  const canonicalTemp = realpathSync(tmpdir());
  const displacement = relative(canonicalTemp, root);
  if (
    displacement === "" ||
    displacement === ".." ||
    displacement.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
    isAbsolute(displacement)
  )
    throw new Error(
      `Refusing cleanup outside the temporary directory: ${root}`,
    );
};

export const teardown = async (): Promise<void> => {
  const root = process.env.REA_TEST_ISOLATION_RUN_ROOT;
  if (root === undefined || root.trim() === "") return;
  assertRemovableRoot(root);
  await rm(root, { recursive: true, force: true, maxRetries: 3 });
};
