import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { expect, it } from "vitest";

const run = promisify(execFile);
const script = fileURLToPath(
  new URL("../../scripts/checkpoint.mjs", import.meta.url),
);

it("branches a checkpoint and restores the branch without changing bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "rea-checkpoint-cli-"));
  const store = join(root, "store");
  const evidence = join(root, "evidence.json");
  const body = '{"evidence_id":"ev_0123456789abcdef"}\n';
  await writeFile(evidence, body);
  const environment = { ...process.env, XTNA_CHECKPOINT_DIR: store };
  try {
    const created = await run(
      process.execPath,
      [script, "create", "--name", "base", "--evidence", evidence],
      { env: environment },
    );
    const parentId = /created (cp_\S+)/u.exec(created.stdout)?.[1];
    expect(parentId).toBeDefined();

    const branched = await run(
      process.execPath,
      [script, "branch", "--id", parentId!, "--name", "alternate"],
      { env: environment },
    );
    const branchId = /-> (cp_\S+)/u.exec(branched.stdout)?.[1];
    expect(branchId).toBeDefined();

    const listed = await run(process.execPath, [script, "list", "--json"], {
      env: environment,
    });
    expect(JSON.parse(listed.stdout)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: branchId,
          name: "alternate",
          parent_id: parentId,
          branch: "alternate",
        }),
      ]),
    );

    const destination = join(root, "restored");
    await run(
      process.execPath,
      [script, "restore", "--id", branchId!, "--dest-dir", destination],
      { env: environment },
    );
    expect(await readFile(join(destination, "evidence.json"), "utf8")).toBe(
      body,
    );
  } finally {
    await rm(root, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 20,
    });
  }
});
