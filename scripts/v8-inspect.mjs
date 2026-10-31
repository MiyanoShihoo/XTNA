#!/usr/bin/env node
/**
 * Report a V8 snapshot container without executing V8 or loading a matching
 * build. This is a bounded header/section inventory; payload semantics remain
 * unknown and are labelled as such.
 *
 * usage: node scripts/v8-inspect.mjs --in <snapshot_blob.bin|v8_context_snapshot.bin> [--json]
 */
import { open, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const flag = (name) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};

const input = flag("in");
if (input === undefined) {
  process.stderr.write(
    "usage: node scripts/v8-inspect.mjs --in <snapshot_blob.bin|v8_context_snapshot.bin> [--json]\n",
  );
  process.exit(2);
}

const { observeV8Snapshot } = await import(
  pathToFileURL(resolve("dist/artifacts/v8/V8Snapshot.js")).href
);

const path = resolve(input);
const info = await stat(path);
if (!info.isFile()) {
  process.stderr.write(`${path} is not a regular file\n`);
  process.exit(2);
}

const handle = await open(path, "r");
let bytes;
try {
  const buffer = Buffer.alloc(Math.min(info.size, 16 * 1024 * 1024));
  const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
  bytes = buffer.subarray(0, bytesRead);
} finally {
  await handle.close();
}

const observation = observeV8Snapshot(bytes, info.size);
if (args.includes("--json")) {
  process.stdout.write(`${JSON.stringify(observation, null, 2)}\n`);
} else {
  process.stdout.write(`V8 snapshot: ${observation.state}\n`);
  if (observation.kind !== undefined)
    process.stdout.write(`kind: ${observation.kind}\n`);
  if (observation.v8Version !== undefined)
    process.stdout.write(`V8 version: ${observation.v8Version}\n`);
  if (observation.formatVersion !== undefined)
    process.stdout.write(
      `format version: ${String(observation.formatVersion)}\n`,
    );
  if (observation.flags !== undefined)
    process.stdout.write(`flags: ${String(observation.flags)}\n`);
  if (observation.magic !== undefined)
    process.stdout.write(
      `magic: ${observation.magic} @ ${String(observation.magicOffset)}\n`,
    );
  if (observation.checksum !== undefined)
    process.stdout.write(`checksum: ${observation.checksum}\n`);
  if (observation.sections !== undefined) {
    process.stdout.write(`sections: ${String(observation.sections.length)}\n`);
    for (const entry of observation.sections)
      process.stdout.write(
        `  #${String(entry.index)} offset=${String(entry.offset)} ` +
          `payload=${String(entry.payloadLength)} complete=${String(entry.complete)}\n`,
      );
  }
  process.stdout.write(
    `coverage: ${String(observation.coverage.bytesExamined)}/${String(observation.coverage.fileBytes)} bytes\n`,
  );
  process.stdout.write("unknowns:\n");
  for (const unknown of observation.unknowns)
    process.stdout.write(`  - ${unknown}\n`);
  process.stdout.write("limitations:\n");
  for (const limitation of observation.limitations)
    process.stdout.write(`  - ${limitation}\n`);
}
process.exitCode = observation.state === "parsed" ? 0 : 2;
