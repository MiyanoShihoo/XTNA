#!/usr/bin/env node
/** Evidence-backed symbol hypotheses with an explicit persistence boundary. */
import { createHash } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const command = args[0];
const flags = {};
const evidence = [];
for (let index = 1; index < args.length; index += 1) {
  const arg = args[index];
  if (!arg?.startsWith("--")) continue;
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    flags[arg.slice(2)] = true;
    continue;
  }
  if (arg === "--evidence") evidence.push(value);
  else flags[arg.slice(2)] = value;
  index += 1;
}

const directory = resolve(
  process.env.XTNA_SYMBOL_HYPOTHESIS_DIR ??
    join(homedir(), ".xtna", "symbol-hypotheses"),
);
const fail = (message) => {
  process.stderr.write(`symbol-hypothesis: ${message}\n`);
  process.exit(2);
};
const resultFailure = (result) => {
  if (result._tag === "InvalidSymbolHypothesis") fail(result.reason);
  if (result._tag === "SymbolOverlayConflict")
    fail(`an entry already exists at ${result.address_hex}`);
  fail(String(result.cause ?? "symbol hypothesis storage failed"));
};

const binaryDigest = async (value) => {
  if (value === undefined) fail("--binary is required");
  if (/^[a-f0-9]{64}$/u.test(value)) return value;
  const path = resolve(value);
  const info = await stat(path).catch(() => null);
  if (info === null || !info.isFile())
    fail(`--binary must be a file or sha256 digest: ${value}`);
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
};

const loadStore = async () => {
  const { SymbolOverlayStore } = await import(
    pathToFileURL(resolve("dist/application/overlays/SymbolOverlayStore.js"))
      .href
  );
  const opened = await SymbolOverlayStore.open(directory);
  if (!opened.ok) resultFailure(opened.error);
  return opened.value;
};

const add = async () => {
  if (typeof flags.address !== "string") fail("--address is required");
  if (typeof flags.name !== "string") fail("--name is required");
  if (typeof flags.rationale !== "string") fail("--rationale is required");
  if (evidence.length === 0) fail("at least one --evidence is required");
  const store = await loadStore();
  const committed = await store.commit({
    target_sha256: await binaryDigest(flags.binary),
    address_hex: flags.address,
    name: flags.name,
    rationale: flags.rationale,
    evidenceIds: evidence,
    ...(typeof flags.signature === "string"
      ? { signature: flags.signature }
      : {}),
  });
  if (!committed.ok) resultFailure(committed.error);
  process.stdout.write(
    `added ${committed.value.name} at ${committed.value.address_hex}\n`,
  );
};

const list = async () => {
  const store = await loadStore();
  const target = await binaryDigest(flags.binary);
  const entries = store.list(target);
  if (flags.json === true) {
    process.stdout.write(`${JSON.stringify(entries, null, 2)}\n`);
    return;
  }
  if (entries.length === 0) {
    process.stdout.write("no symbol hypotheses\n");
    return;
  }
  for (const entry of entries)
    process.stdout.write(
      `${entry.address_hex.padEnd(12)} ${entry.name}  ${entry.rationale}\n`,
    );
};

const exportMapping = async () => {
  const format = flags.format ?? "ghidra";
  if (!["ghidra", "ida", "vscode"].includes(format))
    fail("--format must be ghidra, ida, or vscode");
  const store = await loadStore();
  const target = await binaryDigest(flags.binary);
  const exported = store.exportMapping(target, format);
  if (!exported.ok) resultFailure(exported.error);
  if (typeof flags.out === "string") {
    await writeFile(resolve(flags.out), exported.value, "utf8");
    process.stdout.write(`wrote ${format} mapping to ${resolve(flags.out)}\n`);
  } else process.stdout.write(exported.value);
};

const usage = `usage: node scripts/symbol-hypothesis.mjs <command> [options]

  add    --binary <path|sha256> --address 0xADDR --name NAME
         --rationale "why this symbol is supported" --evidence ev_...
         [--signature "type or signature"]
  list   --binary <path|sha256> [--json]
  export --binary <path|sha256> [--format ghidra|ida|vscode] [--out file]

Environment: XTNA_SYMBOL_HYPOTHESIS_DIR (default ~/.xtna/symbol-hypotheses)
`;

const main = async () => {
  if (command === undefined || command === "--help" || command === "-h") {
    process.stdout.write(usage);
    return;
  }
  if (command === "add") return add();
  if (command === "list") return list();
  if (command === "export") return exportMapping();
  fail(`unknown command: ${command}`);
};
await main();
