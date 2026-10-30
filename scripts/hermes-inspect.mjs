#!/usr/bin/env node
/**
 * Report the Hermes bytecode header of a `.hbc` file or React Native bundle.
 *
 * Reads the 60-byte prefix only: magic, bytecode version, source hash and the
 * function/string counters. Tables and AST extraction are not implemented, and
 * the output says so instead of implying more.
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
    "usage: node scripts/hermes-inspect.mjs --in <index.android.bundle|file.hbc> [--json]\n",
  );
  process.exit(2);
}

const { HERMES_HEADER_BYTES, observeHermesBytecode, hermesVersionSupported } =
  await import(
    pathToFileURL(resolve("dist/artifacts/hermes/HermesBytecodeHeader.js")).href
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
  const buffer = Buffer.alloc(HERMES_HEADER_BYTES);
  const { bytesRead } = await handle.read(buffer, 0, HERMES_HEADER_BYTES, 0);
  bytes = buffer.subarray(0, bytesRead);
} finally {
  await handle.close();
}

const observation = observeHermesBytecode(bytes);
const report = {
  path,
  bytes: info.size,
  state: observation.state,
  ...(observation.state === "parsed"
    ? {
        facts: observation.facts,
        versionSupported: hermesVersionSupported(observation.facts.version),
        declaredLengthMatchesFile: observation.facts.fileLength === info.size,
      }
    : observation.state === "not-hermes"
      ? { leadingBytes: observation.leadingBytes }
      : {
          availableBytes: observation.availableBytes,
          neededBytes: observation.neededBytes,
        }),
  limitations: [
    "Header prefix only: the string table, function table and bytecode are not decoded.",
    "No AST is produced; structuring the bytecode is a separate step.",
    "A declared fileLength that differs from the file size is reported, not corrected.",
  ],
};

if (observation.state !== "parsed") process.exitCode = 3;

if (args.includes("--json")) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else if (observation.state === "parsed") {
  const f = observation.facts;
  process.stdout.write(
    [
      `Hermes bytecode: ${path}`,
      `version: ${f.version}${report.versionSupported ? "" : " (outside the known range)"}`,
      `source hash: ${f.sourceHash}`,
      `functions: ${f.functionCount} (global code #${f.globalCodeIndex})`,
      `strings: ${f.stringCount} small, ${f.overflowStringCount} overflow, ${f.identifierCount} identifiers, ${f.stringKindCount} kinds`,
      `string storage: ${f.stringStorageSize} bytes`,
      `declared length: ${f.fileLength} bytes; file: ${info.size} bytes`,
      "limits: header only; tables and AST are not decoded",
    ].join("\n") + "\n",
  );
} else if (observation.state === "truncated") {
  process.stderr.write(
    `truncated: ${observation.availableBytes} of ${observation.neededBytes} header bytes\n`,
  );
} else {
  process.stderr.write(
    `not Hermes bytecode (leading bytes ${observation.leadingBytes})\n`,
  );
}
