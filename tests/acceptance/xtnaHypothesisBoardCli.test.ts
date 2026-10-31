import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { expect, it } from "vitest";

const run = promisify(execFile);
const script = fileURLToPath(
  new URL("../../scripts/hypothesis-board.mjs", import.meta.url),
);
const cacheRoot = fileURLToPath(new URL("../../.cache", import.meta.url));

const board = (
  store: string,
  args: readonly string[],
): Promise<{ stdout: string; stderr: string }> =>
  run(process.execPath, [script, ...args, "--store", store], {
    env: process.env,
  });

const command = async (
  store: string,
  id: string,
  payload: unknown,
  root: string,
): Promise<string> => {
  const file = join(root, `cmd-${Date.now()}-${Math.random()}.json`);
  await writeFile(file, JSON.stringify(payload), "utf8");
  const result = await board(store, [
    "command",
    "--id",
    id,
    "--json-file",
    file,
  ]);
  return result.stdout.trim();
};

it("drives the typed hypothesis state machine from the CLI", async () => {
  const root = await mkdtemp(join(cacheRoot, "hypothesis-board-"));
  const store = join(root, "board.json");
  try {
    await board(store, [
      "create",
      "--id",
      "h1",
      "--statement",
      "Loader resolves imports lazily",
      "--checklist",
      "c1=loader symbols:supporting",
      "--checklist",
      "c2=crypto table:contradicting",
    ]);
    expect(
      await command(store, "h1", { kind: "start-investigation" }, root),
    ).toContain("investigating");

    await command(
      store,
      "h1",
      {
        kind: "record-checklist",
        checklist_item_id: "c1",
        disposition: "confirm",
        evidence_ids: ["ev_a"],
      },
      root,
    );
    await command(
      store,
      "h1",
      {
        kind: "record-checklist",
        checklist_item_id: "c2",
        disposition: "dismiss",
        evidence_ids: ["ev_c"],
      },
      root,
    );
    expect(
      await command(
        store,
        "h1",
        { kind: "mark-supported", evidence_ids: ["ev_a"] },
        root,
      ),
    ).toContain("supported");

    await board(store, [
      "create",
      "--id",
      "h2",
      "--statement",
      "Crypto is AES",
      "--checklist",
      "x1=table:supporting",
      "--checklist",
      "x2=entropy:contradicting",
    ]);
    await command(store, "h2", { kind: "start-investigation" }, root);
    expect(
      await command(
        store,
        "h2",
        {
          kind: "record-checklist",
          checklist_item_id: "x2",
          disposition: "confirm",
          evidence_ids: ["ev_b"],
        },
        root,
      ),
    ).toContain("backtracked");

    const record = JSON.parse(await readFile(store, "utf8")) as {
      records: {
        id: string;
        status: string;
        conflicts: { id: string }[];
        statement: string;
      }[];
    };
    const conflicted = record.records.find((entry) => entry.id === "h2");
    expect(conflicted?.conflicts).toHaveLength(1);
    expect(
      await command(
        store,
        "h2",
        {
          kind: "resolve-conflict",
          conflict_id: conflicted?.conflicts[0]?.id,
          resolution: "hypothesis-revised",
          rationale: "entropy indicates compression",
          evidence_ids: ["ev_b"],
          revised_statement: "Crypto may be AES with compressed payloads",
        },
        root,
      ),
    ).toContain("investigating");

    const listed = await board(store, ["list"]);
    expect(listed.stdout).toContain("h1  supported");
    expect(listed.stdout).toContain("h2  investigating");
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5 });
  }
});

it("refuses an invalid transition and leaves the store untouched", async () => {
  const root = await mkdtemp(join(cacheRoot, "hypothesis-board-invalid-"));
  const store = join(root, "board.json");
  try {
    await board(store, [
      "create",
      "--id",
      "h1",
      "--statement",
      "Unproven claim",
      "--checklist",
      "c1=check:supporting",
    ]);
    const before = await readFile(store, "utf8");
    await expect(
      command(
        store,
        "h1",
        { kind: "mark-supported", evidence_ids: ["ev_a"] },
        root,
      ),
    ).rejects.toMatchObject({ code: 3 });
    expect(await readFile(store, "utf8")).toBe(before);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5 });
  }
});
