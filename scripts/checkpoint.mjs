#!/usr/bin/env node
/**
 * XTNA investigation checkpoints.
 *
 * A checkpoint freezes the files you name — Evidence bundles and symbol overlay
 * files — into a content-addressed directory with a manifest of their hashes.
 * Restore verifies every hash before writing, so a checkpoint cannot silently
 * return different bytes.
 *
 * It can optionally record a point-in-time process/container observation, but
 * restore only writes files: a process list is evidence, not restorable state.
 */
import { createHash, randomBytes } from "node:crypto";
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const SCHEMA = "xtna.checkpoint/1";
const args = process.argv.slice(2);
const command = args[0];

const valueOf = (name) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};
const valuesOf = (name) => {
  const out = [];
  for (let index = 0; index < args.length; index += 1)
    if (args[index] === `--${name}` && args[index + 1] !== undefined)
      out.push(args[index + 1]);
  return out;
};
const has = (name) => args.includes(`--${name}`);

const root = resolve(
  process.env.XTNA_CHECKPOINT_DIR ?? join(homedir(), ".xtna", "checkpoints"),
);

const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");
const id = () =>
  `cp_${Date.now().toString(36)}_${randomBytes(3).toString("hex")}`;
const checkpointDir = (checkpointId) => join(root, checkpointId);

const fail = (message) => {
  process.stderr.write(`checkpoint: ${message}\n`);
  process.exit(2);
};

const readManifest = async (checkpointId) => {
  const raw = await readFile(
    join(checkpointDir(checkpointId), "manifest.json"),
    "utf8",
  ).catch(() => null);
  if (raw === null) fail(`checkpoint not found: ${checkpointId}`);
  const manifest = JSON.parse(raw);
  if (manifest.schema !== SCHEMA)
    fail(`unsupported checkpoint schema in ${checkpointId}`);
  return manifest;
};

const loadProcessSnapshot = async () => {
  const fromFile = valueOf("processes-from");
  if (fromFile !== undefined) {
    const parsed = JSON.parse(await readFile(resolve(fromFile), "utf8"));
    if (!Array.isArray(parsed.processes))
      fail(`${fromFile} does not contain a processes array`);
    return {
      capturedAt: parsed.capturedAt ?? new Date().toISOString(),
      platform: parsed.platform ?? "unknown",
      processes: parsed.processes,
      containers: Array.isArray(parsed.containers) ? parsed.containers : null,
      limitations: Array.isArray(parsed.limitations) ? parsed.limitations : [],
      source: resolve(fromFile),
    };
  }
  if (!has("processes")) return undefined;
  const { captureProcessSnapshot } = await import(
    pathToFileURL(resolve("dist/application/investigation/ProcessSnapshot.js"))
      .href
  );
  const snapshot = await captureProcessSnapshot();
  return { ...snapshot, source: "live" };
};

const create = async () => {
  const name = valueOf("name") ?? "unnamed";
  const evidencePaths = valuesOf("evidence");
  const overlayDirs = valuesOf("overlay-dir");
  const processSnapshot = await loadProcessSnapshot();
  if (
    evidencePaths.length === 0 &&
    overlayDirs.length === 0 &&
    processSnapshot === undefined
  )
    fail(
      "pass at least one --evidence <file>, --overlay-dir <dir> or --processes",
    );

  const checkpointId = id();
  const target = checkpointDir(checkpointId);
  await mkdir(target, { recursive: true });

  const files = [];
  const overlays = [];

  for (const path of evidencePaths) {
    const absolute = resolve(path);
    const bytes = await readFile(absolute);
    const stored = `${String(files.length)}-${basename(absolute)}`;
    await writeFile(join(target, stored), bytes);
    files.push({
      source: absolute,
      stored,
      sha256: sha256(bytes),
      bytes: bytes.length,
    });
  }

  for (const dir of overlayDirs) {
    const absolute = resolve(dir);
    const names = await readdir(absolute).catch(() => []);
    for (const entry of names.filter((entry) => entry.endsWith(".json"))) {
      const bytes = await readFile(join(absolute, entry));
      const stored = `${String(overlays.length)}-${entry}`;
      await writeFile(join(target, stored), bytes);
      overlays.push({
        source: join(absolute, entry),
        stored,
        sha256: sha256(bytes),
        bytes: bytes.length,
      });
    }
  }

  const manifest = {
    schema: SCHEMA,
    id: checkpointId,
    name,
    created_at: new Date().toISOString(),
    files,
    overlays,
    ...(processSnapshot === undefined ? {} : { processes: processSnapshot }),
  };
  await writeFile(
    join(target, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  process.stdout.write(
    `created ${checkpointId} (${String(files.length)} evidence, ${String(overlays.length)} overlay files` +
      (processSnapshot === undefined
        ? ")\n"
        : `, ${String(processSnapshot.processes.length)} processes)
`),
  );
};

const branch = async () => {
  const parentId = valueOf("id") ?? fail("--id is required");
  const name = valueOf("name");
  if (name === undefined || name.trim().length === 0)
    fail("--name is required");
  const parent = await readManifest(parentId);
  const checkpointId = id();
  const target = checkpointDir(checkpointId);
  await mkdir(target, { recursive: true });
  for (const entry of [...parent.files, ...parent.overlays])
    await copyFile(
      join(checkpointDir(parentId), entry.stored),
      join(target, entry.stored),
    );
  const manifest = {
    ...parent,
    id: checkpointId,
    name,
    parent_id: parentId,
    branch: name,
    created_at: new Date().toISOString(),
  };
  await writeFile(
    join(target, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  process.stdout.write(`branched ${parentId} -> ${checkpointId} (${name})\n`);
};

const list = async () => {
  const entries = await readdir(root).catch(() => []);
  const rows = [];
  for (const entry of entries) {
    const manifest = await readFile(
      join(root, entry, "manifest.json"),
      "utf8",
    ).catch(() => null);
    if (manifest === null) continue;
    const parsed = JSON.parse(manifest);
    rows.push({
      id: parsed.id,
      name: parsed.name,
      created_at: parsed.created_at,
      parent_id: parsed.parent_id ?? null,
      branch: parsed.branch ?? null,
      evidence: parsed.files.length,
      overlays: parsed.overlays.length,
      processes: Array.isArray(parsed.processes?.processes)
        ? parsed.processes.processes.length
        : 0,
    });
  }
  rows.sort((left, right) =>
    String(left.created_at).localeCompare(String(right.created_at)),
  );
  if (has("json")) {
    process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
    return;
  }
  if (rows.length === 0) {
    process.stdout.write("no checkpoints\n");
    return;
  }
  for (const row of rows)
    process.stdout.write(
      `${row.id}  ${String(row.created_at)}  ${row.name}${row.parent_id === null ? "" : `  parent=${String(row.parent_id)}`}  evidence=${String(row.evidence)} overlays=${String(row.overlays)}\n`,
    );
};

const verify = async (manifest, collection) => {
  for (const entry of manifest[collection]) {
    const bytes = await readFile(
      join(checkpointDir(manifest.id), entry.stored),
    );
    if (sha256(bytes) !== entry.sha256)
      fail(`hash mismatch for ${entry.source} in ${manifest.id}`);
  }
};

const restore = async () => {
  const checkpointId = valueOf("id") ?? fail("--id is required");
  const destDir = resolve(valueOf("dest-dir") ?? ".");
  const overlayDest = valueOf("overlay-dir");
  const manifest = await readManifest(checkpointId);

  await verify(manifest, "files");
  await verify(manifest, "overlays");

  await mkdir(destDir, { recursive: true });
  for (const entry of manifest.files)
    await copyFile(
      join(checkpointDir(checkpointId), entry.stored),
      join(destDir, basename(entry.source)),
    );

  if (overlayDest !== undefined) {
    await mkdir(resolve(overlayDest), { recursive: true });
    for (const entry of manifest.overlays)
      await copyFile(
        join(checkpointDir(checkpointId), entry.stored),
        join(resolve(overlayDest), basename(entry.source)),
      );
  }

  process.stdout.write(
    `restored ${String(manifest.files.length)} evidence files to ${destDir}` +
      (overlayDest === undefined
        ? "\n"
        : `, ${String(manifest.overlays.length)} overlays to ${String(overlayDest)}\n`),
  );
};

const compareSet = (before, after) => {
  const beforeBySource = new Map(before.map((entry) => [entry.source, entry]));
  const afterBySource = new Map(after.map((entry) => [entry.source, entry]));
  const bySource = (left, right) => left.source.localeCompare(right.source);
  const added = [];
  const removed = [];
  const changed = [];
  let unchanged = 0;
  for (const [source, entry] of afterBySource) {
    const previous = beforeBySource.get(source);
    if (previous === undefined)
      added.push({ source, sha256: entry.sha256, bytes: entry.bytes });
    else if (previous.sha256 !== entry.sha256)
      changed.push({
        source,
        before: previous.sha256,
        after: entry.sha256,
        bytesBefore: previous.bytes,
        bytesAfter: entry.bytes,
      });
    else unchanged += 1;
  }
  for (const [source, entry] of beforeBySource)
    if (!afterBySource.has(source))
      removed.push({ source, sha256: entry.sha256, bytes: entry.bytes });
  return {
    added: added.sort(bySource),
    removed: removed.sort(bySource),
    changed: changed.sort(bySource),
    unchanged,
  };
};

const diff = async () => {
  const fromId = valueOf("from") ?? fail("--from is required");
  const toId = valueOf("to") ?? fail("--to is required");
  const from = await readManifest(fromId);
  const to = await readManifest(toId);
  const report = {
    schema: "xtna.checkpoint-diff/1",
    from: { id: from.id, name: from.name, created_at: from.created_at },
    to: { id: to.id, name: to.name, created_at: to.created_at },
    evidence: compareSet(from.files, to.files),
    overlays: compareSet(from.overlays, to.overlays),
  };
  if (has("json")) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  const short = (sha) => String(sha).slice(0, 12);
  const lines = [`diff ${from.id} (${from.name}) -> ${to.id} (${to.name})`];
  for (const collection of ["evidence", "overlays"]) {
    const part = report[collection];
    lines.push(
      `${collection}  +${String(part.added.length)} -${String(part.removed.length)} ~${String(part.changed.length)} =${String(part.unchanged)}`,
    );
    for (const entry of part.added)
      lines.push(`  + ${entry.source}  ${short(entry.sha256)}`);
    for (const entry of part.removed)
      lines.push(`  - ${entry.source}  ${short(entry.sha256)}`);
    for (const entry of part.changed)
      lines.push(
        `  ~ ${entry.source}  ${short(entry.before)} -> ${short(entry.after)}  (${String(entry.bytesBefore)} -> ${String(entry.bytesAfter)} bytes)`,
      );
  }
  process.stdout.write(`${lines.join("\n")}\n`);
};

const show = async () => {
  const checkpointId = valueOf("id") ?? fail("--id is required");
  process.stdout.write(
    `${JSON.stringify(await readManifest(checkpointId), null, 2)}\n`,
  );
};

const remove = async () => {
  const checkpointId = valueOf("id") ?? fail("--id is required");
  await readManifest(checkpointId);
  await rm(checkpointDir(checkpointId), { recursive: true, force: true });
  process.stdout.write(`deleted ${checkpointId}\n`);
};

const usage = `usage: node scripts/checkpoint.mjs <command> [options]

  create   --name <text> [--evidence <file>]... [--overlay-dir <dir>]... [--processes | --processes-from <snapshot.json>]
  branch   --id <cp_...> --name <text>
  list     [--json]
  diff     --from <cp_...> --to <cp_...> [--json]
  show     --id <cp_...>
  restore  --id <cp_...> [--dest-dir <dir>] [--overlay-dir <dir>]
  delete   --id <cp_...>

Environment: XTNA_CHECKPOINT_DIR (default ~/.xtna/checkpoints)
`;

const main = async () => {
  if (command === undefined || command === "--help" || command === "-h") {
    process.stdout.write(usage);
    return;
  }
  if (command === "create") return create();
  if (command === "branch") return branch();
  if (command === "list") return list();
  if (command === "diff") return diff();
  if (command === "show") return show();
  if (command === "restore") return restore();
  if (command === "delete") return remove();
  fail(`unknown command: ${command}`);
};

await main();
