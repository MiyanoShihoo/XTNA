import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

it("diffs two checkpoints by source path and hash", async () => {
  const root = await mkdtemp(join(tmpdir(), "rea-checkpoint-diff-"));
  const store = join(root, "store");
  const evidence = join(root, "evidence.json");
  const overlays = join(root, "overlays");
  await mkdir(overlays, { recursive: true });
  await writeFile(evidence, '{"step":1}\n');
  await writeFile(join(overlays, "old.json"), '{"a":1}\n');
  const environment = { ...process.env, XTNA_CHECKPOINT_DIR: store };
  try {
    const first = await run(
      process.execPath,
      [
        script,
        "create",
        "--name",
        "one",
        "--evidence",
        evidence,
        "--overlay-dir",
        overlays,
      ],
      { env: environment },
    );
    const firstId = /created (cp_\S+)/u.exec(first.stdout)?.[1];

    await writeFile(evidence, '{"step":2}\n');
    await writeFile(join(overlays, "new.json"), '{"b":2}\n');
    await rm(join(overlays, "old.json"));
    const second = await run(
      process.execPath,
      [
        script,
        "create",
        "--name",
        "two",
        "--evidence",
        evidence,
        "--overlay-dir",
        overlays,
      ],
      { env: environment },
    );
    const secondId = /created (cp_\S+)/u.exec(second.stdout)?.[1];

    const diffed = await run(
      process.execPath,
      [script, "diff", "--from", firstId!, "--to", secondId!, "--json"],
      { env: environment },
    );
    const report = JSON.parse(diffed.stdout) as {
      evidence: {
        changed: { source: string; before: string; after: string }[];
        unchanged: number;
      };
      overlays: {
        added: { source: string }[];
        removed: { source: string }[];
      };
    };
    expect(report.evidence.changed).toHaveLength(1);
    expect(report.evidence.changed[0]?.source).toBe(evidence);
    expect(report.evidence.changed[0]?.before).not.toBe(
      report.evidence.changed[0]?.after,
    );
    expect(report.evidence.unchanged).toBe(0);
    expect(report.overlays.added.map((entry) => entry.source)).toEqual([
      join(overlays, "new.json"),
    ]);
    expect(report.overlays.removed.map((entry) => entry.source)).toEqual([
      join(overlays, "old.json"),
    ]);

    const human = await run(
      process.execPath,
      [script, "diff", "--from", firstId!, "--to", secondId!],
      { env: environment },
    );
    expect(human.stdout).toContain("diff cp_");
    expect(human.stdout).toContain("evidence  +0 -0 ~1 =0");
  } finally {
    await rm(root, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 20,
    });
  }
});

it("records a process snapshot without pretending to restore it", async () => {
  const root = await mkdtemp(join(tmpdir(), "rea-checkpoint-proc-"));
  const store = join(root, "store");
  const evidence = join(root, "evidence.json");
  const snapshot = join(root, "snapshot.json");
  await writeFile(evidence, '{"step":1}\n');
  await writeFile(
    snapshot,
    JSON.stringify({
      capturedAt: "2026-10-30T00:00:00.000Z",
      platform: "win32",
      processes: [
        { pid: 1, ppid: null, name: "a.exe", rssBytes: 1024 },
        { pid: 2, ppid: 1, name: "b.exe", rssBytes: 2048 },
      ],
      containers: [{ id: "c1", image: "nginx", status: "Up", names: "web" }],
      limitations: ["point-in-time"],
    }),
  );
  const environment = { ...process.env, XTNA_CHECKPOINT_DIR: store };
  try {
    const created = await run(
      process.execPath,
      [
        script,
        "create",
        "--name",
        "with-processes",
        "--evidence",
        evidence,
        "--processes-from",
        snapshot,
      ],
      { env: environment },
    );
    expect(created.stdout).toContain("2 processes");
    const id = /created (cp_\S+)/u.exec(created.stdout)?.[1];

    const shown = await run(process.execPath, [script, "show", "--id", id!], {
      env: environment,
    });
    const manifest = JSON.parse(shown.stdout) as {
      processes: {
        processes: unknown[];
        containers: unknown[];
        source: string;
      };
    };
    expect(manifest.processes.processes).toHaveLength(2);
    expect(manifest.processes.containers).toHaveLength(1);
    expect(manifest.processes.source).toBe(snapshot);

    const listed = await run(process.execPath, [script, "list", "--json"], {
      env: environment,
    });
    expect(JSON.parse(listed.stdout)).toEqual(
      expect.arrayContaining([expect.objectContaining({ id, processes: 2 })]),
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
