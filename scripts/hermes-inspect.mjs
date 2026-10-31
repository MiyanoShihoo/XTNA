#!/usr/bin/env node
/**
 * Report a Hermes bytecode file: header, tables, disassembly and — with
 * `--ast` — the structured statements recovered from each function body.
 *
 * Every step states what it could not decode instead of implying more.
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
    "usage: node scripts/hermes-inspect.mjs --in <index.android.bundle|file.hbc> [--tables] [--disassemble] [--ast] [--exceptions] [--json]\n",
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
const { disassembleHermes } = await import(
  pathToFileURL(resolve("dist/artifacts/hermes/HermesDisassembly.js")).href
);
const { readHermesExceptionTables } = await import(
  new URL("../dist/artifacts/hermes/HermesExceptionTables.js", import.meta.url)
    .href
);
const { buildHermesAst, renderHermesStatement } = await import(
  pathToFileURL(resolve("dist/artifacts/hermes/HermesAst.js")).href
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

const withAst = args.includes("--ast");
const withExceptions = args.includes("--exceptions");
const withDisassembly = args.includes("--disassemble") || withAst;
const withTables = args.includes("--tables") || withDisassembly;
const observation = observeHermesBytecode(bytes);
const tables =
  withTables && observation.state === "parsed"
    ? readHermesTables(bytes)
    : undefined;
const disassembly =
  withDisassembly && observation.state === "parsed"
    ? disassembleHermes(bytes)
    : undefined;
const exceptions =
  (withExceptions || withAst) && observation.state === "parsed"
    ? readHermesExceptionTables(bytes)
    : undefined;
const ast =
  withAst && disassembly !== undefined && disassembly.ok
    ? buildHermesAst(disassembly.value, bytes)
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
  ...(disassembly === undefined
    ? {}
    : disassembly.ok
      ? {
          decodedFunctions: disassembly.value.decodedFunctions,
          undecodedFunctions: disassembly.value.undecodedFunctions,
          code: disassembly.value.functions.map((fn) => ({
            index: fn.index,
            name: fn.name,
            decoded: fn.decoded,
            instructions: fn.instructions.slice(0, 100),
          })),
        }
      : { disassemblyError: disassembly.error }),
  ...(ast === undefined
    ? {}
    : {
        ast: {
          structuredFunctions: ast.structuredFunctions,
          unstructuredFunctions: ast.unstructuredFunctions,
          functions: ast.functions.map((fn) => ({
            index: fn.index,
            name: fn.name,
            structured: fn.structured,
            blockCount: fn.blocks.length,
            limitations: fn.limitations,
            statements: fn.statements.map((statement) =>
              renderHermesStatement(statement),
            ),
          })),
        },
      }),
  ...(exceptions === undefined
    ? {}
    : exceptions.ok
      ? {
          exceptions: {
            parsedFunctions: exceptions.value.parsedFunctions,
            unknownFunctions: exceptions.value.unknownFunctions,
            functions: exceptions.value.functions.map((fn) => ({
              index: fn.index,
              name: fn.name,
              status: fn.status,
              handlers: fn.handlers,
              ...(fn.reason === undefined ? {} : { reason: fn.reason }),
            })),
          },
        }
      : { exceptionsError: exceptions.error }),
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
    "Only bytecode version 84 has an opcode table here; other versions are refused.",
    "AST recovery covers if/else and while shapes; try/catch handlers, switch tables and cross-block data flow are not recovered.",
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
  const codeLines =
    disassembly !== undefined && disassembly.ok
      ? withAst && ast !== undefined
        ? [
            `ast: ${String(ast.structuredFunctions)}/${String(ast.functions.length)} functions structured`,
            ...ast.functions.flatMap((fn) => [
              `  ${fn.name ?? "#" + String(fn.index)} (${fn.structured ? "structured" : "unstructured"}, ${String(fn.blocks.length)} blocks)`,
              ...fn.statements.map((statement) =>
                renderHermesStatement(statement, 2),
              ),
            ]),
          ]
        : [
            `code: ${String(disassembly.value.decodedFunctions)}/${String(disassembly.value.functions.length)} functions decoded`,
            ...disassembly.value.functions
              .slice(0, 2)
              .flatMap((fn) =>
                fn.instructions
                  .slice(0, 6)
                  .map(
                    (ins) =>
                      `  ${fn.name ?? "#" + String(fn.index)}: ${ins.name} ${ins.operands.join(", ")}`,
                  ),
              ),
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
      ...(exceptions !== undefined && exceptions.ok
        ? [
            `exception tables: ${String(exceptions.value.parsedFunctions)} parsed, ${String(exceptions.value.unknownFunctions.length)} unknown`,
            ...exceptions.value.functions
              .filter((fn) => fn.status === "parsed")
              .flatMap((fn) =>
                fn.handlers.map(
                  (handler) =>
                    `  ${fn.name ?? "#" + String(fn.index)}: [${String(handler.start)},${String(handler.end)}) -> ${String(handler.target)}`,
                ),
              ),
          ]
        : []),
      ...codeLines,
      withAst
        ? "limits: if/else and while only; no try/catch, switch or cross-block data flow"
        : withDisassembly
          ? "limits: instructions decoded; use --ast for structured statements"
          : withTables
            ? "limits: tables decoded; bytecode bodies are not"
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
