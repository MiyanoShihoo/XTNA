#!/usr/bin/env node
/**
 * XTNA investigation checkpoints.
 *
 * A checkpoint freezes the files you name — Evidence bundles and symbol overlay
 * files — into a content-addressed directory with a manifest of their hashes.
 * Restore verifies every hash before writing, so a checkpoint cannot silently
 * return different bytes.
 *
 * It does not snapshot a running process or a container; only files you pass.
 */
import { createHash, randomBytes } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

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
    if (args[index] === `--${name}` && args[index + 1] !== undefined) out.push(args[index + 1]);
  return out;
};
const has = (name) => args.includes(`--${name}`);

const root = resolve(process.env.XTNA_CHECKPOINT_DIR ?? join(homedir(), ".xtna", "checkpoints"));

const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");
const id = () => `cp_${Date.now().toString(36)}_${randomBytes(3).toString("hex")}`;
const checkpointDir = (checkpointId) => join(root, checkpointId);

const fail = (message) => {
  process.stderr.write(`checkpoint: ${message}\n`);
  process.exit(2);
};

const readManifest = async (checkpointId) => {
  const raw = await readFile(join(checkpointDir(checkpointId), "manifest.json"), "utf8").catch(() => null);
  if (raw === null) fail(`checkpoint not found: ${checkpointId}`);
  const manifest = JSON.parse(raw);
  if (manifest.schema !== SCHEMA) fail(`unsupported checkpoint schema in ${checkpointId}`);
  return manifest;
};

const create = async () => {
  const name = valueOf("name") ?? "unnamed";
  const evidencePaths = valuesOf("evidence");
  const overlayDirs = valuesOf("overlay-dir");
  if (evidencePaths.length === 0 && overlayDirs.length === 0)
    fail("pass at least one --evidence <file> or --overlay-dir <dir>");

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
    files.push({ source: absolute, stored, sha256: sha256(bytes), bytes: bytes.length });
  }

  for (const dir of overlayDirs) {
    const absolute = resolve(dir);
    const names = await readdir(absolute).catch(() => []);
    for (const entry of names.filter((entry) => entry.endsWith(".json"))) {
      const bytes = await readFile(join(absolute, entry));
      const stored = `${String(overlays.length)}-${entry}`;
      await writeFile(join(target, stored), bytes);
      overlays.push({ source: join(absolute, entry), stored, sha256: sha256(bytes), bytes: bytes.length });
    }
  }

  const manifest = {
    schema: SCHEMA,
    id: checkpointId,
    name,
    created_at: new Date().toISOString(),
    files,
    overlays,
  };
  await writeFile(join(target, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  process.stdout.write(
    `created ${checkpointId} (${String(files.length)} evidence, ${String(overlays.length)} overlay files)\n`,
  );
};

const list = async () => {
  const entries = await readdir(root).catch(() => []);
  const rows = [];
  for (const entry of entries) {
    const manifest = await readFile(join(root, entry, "manifest.json"), "utf8").catch(() => null);
    if (manifest === null) continue;
    const parsed = JSON.parse(manifest);
    rows.push({
      id: parsed.id,
      name: parsed.name,
      created_at: parsed.created_at,
      evidence: parsed.files.length,
      overlays: parsed.overlays.length,
    });
  }
  rows.sort((left, right) => String(left.created_at).localeCompare(String(right.created_at)));
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
      `${row.id}  ${String(row.created_at)}  ${row.name}  evidence=${String(row.evidence)} overlays=${String(row.overlays)}\n`,
    );
};

const verify = async (manifest, collection) => {
  for (const entry of manifest[collection]) {
    const bytes = await readFile(join(checkpointDir(manifest.id), entry.stored));
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
    await copyFile(join(checkpointDir(checkpointId), entry.stored), join(destDir, basename(entry.source)));

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
      (overlayDest === undefined ? "\n" : `, ${String(manifest.overlays.length)} overlays to ${String(overlayDest)}\n`),
  );
};

const show = async () => {
  const checkpointId = valueOf("id") ?? fail("--id is required");
  process.stdout.write(`${JSON.stringify(await readManifest(checkpointId), null, 2)}\n`);
};

const remove = async () => {
  const checkpointId = valueOf("id") ?? fail("--id is required");
  await readManifest(checkpointId);
  await rm(checkpointDir(checkpointId), { recursive: true, force: true });
  process.stdout.write(`deleted ${checkpointId}\n`);
};

const usage = `usage: node scripts/checkpoint.mjs <command> [options]

  create   --name <text> [--evidence <file>]... [--overlay-dir <dir>]...
  list     [--json]
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
  if (command === "list") return list();
  if (command === "show") return show();
  if (command === "restore") return restore();
  if (command === "delete") return remove();
  fail(`unknown command: ${command}`);
};

await main();
