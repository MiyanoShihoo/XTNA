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
    "usage: node scripts/hermes-inspect.mjs --in <index.android.bundle|file.hbc> [--tables] [--json]\n",
  );
  process.exit(2);
}

const { HERMES_HEADER_BYTES, observeHermesBytecode, hermesVersionSupported } =
  await import(
    pathToFileURL(resolve("dist/artifacts/hermes/HermesBytecodeHeader.js")).href
  );
const { readHermesTables } = await import(
  pathToFileURL(resolve("dist/artifacts/hermes/HermesBytecodeTables.js")).href
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

const observation = observeHermesBytecode(bytes);
const withTables = args.includes("--tables");
const tables =
  withTables && observation.state === "parsed"
    ? readHermesTables(bytes)
    : undefined;
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
  ...(tables === undefined
    ? {}
    : tables.ok
      ? {
          tables: {
            strings: tables.value.strings.slice(0, 200),
            functions: tables.value.functions.slice(0, 200),
            truncated: tables.value.truncated,
          },
        }
      : { tablesError: tables.error }),
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
  const tableLines =
    tables !== undefined && tables.ok
      ? [
          `strings: ${String(tables.value.strings.length)} (first: ${tables.value.strings
            .slice(0, 8)
            .map((entry) => entry.value)
            .filter((value) => value.length > 0)
            .join(", ")})`,
          `functions: ${tables.value.functions
            .slice(0, 12)
            .map((entry) => entry.name ?? `#${String(entry.nameStringId)}`)
            .join(", ")}`,
        ]
      : [];
  process.stdout.write(
    [
      `Hermes bytecode: ${path}`,
      `version: ${f.version}${report.versionSupported ? "" : " (outside the known range)"}`,
      `source hash: ${f.sourceHash}`,
      `functions: ${f.functionCount} (global code #${f.globalCodeIndex})`,
      `strings: ${f.stringCount} small, ${f.overflowStringCount} overflow, ${f.identifierCount} identifiers, ${f.stringKindCount} kinds`,
      `string storage: ${f.stringStorageSize} bytes`,
      `declared length: ${f.fileLength} bytes; file: ${info.size} bytes`,
      ...tableLines,
      withTables
        ? "limits: tables decoded; bytecode bodies and AST are not"
        : "limits: header only; use --tables for the string/function tables",
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
