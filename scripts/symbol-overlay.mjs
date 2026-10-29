#!/usr/bin/env node
/**
 * XTNA symbol overlay.
 *
 * Keeps analyst-proposed names, types and comments outside the evidence ledger,
 * keyed by the exact binary digest. The overlay never rewrites Evidence; it is a
 * projection that can be exported into Ghidra or IDA and regenerated at will.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const SCHEMA = "xtna.symbol-overlay/1";
const CONFIDENCE = new Set(["observed", "inferred", "guessed"]);
const KINDS = new Set([
  "function",
  "data",
  "struct",
  "field",
  "label",
  "import",
]);

const args = process.argv.slice(2);
const command = args[0];
const flags = {};
const positional = [];
for (let index = 1; index < args.length; index += 1) {
  const arg = args[index];
  if (arg.startsWith("--")) {
    const next = args[index + 1];
    if (next === undefined || next.startsWith("--")) flags[arg.slice(2)] = true;
    else {
      flags[arg.slice(2)] = next;
      index += 1;
    }
  } else positional.push(arg);
}

const overlayDir = resolve(
  process.env.XTNA_OVERLAY_DIR ?? join(homedir(), ".xtna", "overlays"),
);

const fail = (message) => {
  process.stderr.write(`symbol-overlay: ${message}\n`);
  process.exit(2);
};

const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");

const binaryDigest = async (value) => {
  if (value === undefined) fail("--binary is required");
  if (/^[0-9a-f]{64}$/u.test(value)) return value;
  const path = resolve(value);
  const info = await stat(path).catch(() => null);
  if (info === null || !info.isFile())
    fail(`--binary must be an existing file or a sha256 digest: ${value}`);
  return sha256(await readFile(path));
};

const parseAddress = (value) => {
  if (value === undefined) fail("--address is required");
  const text = String(value).trim().toLowerCase();
  if (!/^0x[0-9a-f]{1,16}$/u.test(text)) fail(`invalid address: ${value}`);
  return { hex: text, value: BigInt(text) };
};

const validateName = (value) => {
  if (value === undefined) fail("--name is required");
  const name = String(value);
  if (!/^[A-Za-z_][A-Za-z0-9_:@.?$]{0,127}$/u.test(name))
    fail(`invalid symbol name: ${name}`);
  return name;
};

const overlayPath = (digest) => join(overlayDir, `${digest}.json`);

const load = async (digest) => {
  const raw = await readFile(overlayPath(digest), "utf8").catch(() => null);
  if (raw === null)
    return { schema: SCHEMA, binary_sha256: digest, entries: [] };
  const parsed = JSON.parse(raw);
  if (parsed.schema !== SCHEMA || parsed.binary_sha256 !== digest)
    fail(`overlay file does not match ${digest}`);
  return parsed;
};

const save = async (overlay) => {
  await mkdir(overlayDir, { recursive: true });
  const sorted = {
    ...overlay,
    entries: [...overlay.entries].sort((a, b) =>
      a.address_hex === b.address_hex
        ? a.name.localeCompare(b.name)
        : a.address_hex.localeCompare(b.address_hex),
    ),
  };
  await writeFile(
    overlayPath(overlay.binary_sha256),
    `${JSON.stringify(sorted, null, 2)}\n`,
    "utf8",
  );
  return sorted;
};

const entryId = (digest, addressHex, name) =>
  `sym_${sha256(Buffer.from(`${digest}\0${addressHex}\0${name}`, "utf8")).slice(0, 16)}`;

const add = async () => {
  const digest = await binaryDigest(flags.binary);
  const address = parseAddress(flags.address);
  const name = validateName(flags.name);
  const kind = flags.kind ?? "function";
  if (!KINDS.has(kind)) fail(`invalid --kind: ${String(kind)}`);
  const confidence = flags.confidence ?? "inferred";
  if (!CONFIDENCE.has(confidence))
    fail(`invalid --confidence: ${String(confidence)}`);
  const type =
    flags.type === undefined || flags.type === true ? null : String(flags.type);
  const comment =
    flags.comment === undefined || flags.comment === true
      ? null
      : String(flags.comment);
  const evidence = flags.evidence === undefined ? [] : [String(flags.evidence)];

  const overlay = await load(digest);
  const id = entryId(digest, address.hex, name);
  const existing = overlay.entries.find((entry) => entry.id === id);
  if (existing !== undefined) {
    Object.assign(existing, {
      kind,
      type,
      comment,
      confidence,
      evidence_ids: evidence,
    });
  } else {
    overlay.entries.push({
      id,
      address_hex: address.hex,
      address: address.value.toString(),
      name,
      kind,
      type,
      comment,
      confidence,
      evidence_ids: evidence,
      created_at: new Date().toISOString(),
    });
  }
  const saved = await save(overlay);
  process.stdout.write(
    `${existing ? "updated" : "added"} ${name} @ ${address.hex} (${String(saved.entries.length)} total)\n`,
  );
};

const list = async () => {
  const digest = await binaryDigest(flags.binary);
  const overlay = await load(digest);
  if (flags.json === true) {
    process.stdout.write(`${JSON.stringify(overlay, null, 2)}\n`);
    return;
  }
  if (overlay.entries.length === 0) {
    process.stdout.write("no symbols\n");
    return;
  }
  for (const entry of overlay.entries)
    process.stdout.write(
      `${entry.address_hex.padEnd(12)} ${entry.kind.padEnd(9)} ${entry.confidence.padEnd(9)} ${entry.name}${entry.type ? `  :: ${entry.type}` : ""}\n`,
    );
};

const removeEntry = async () => {
  const digest = await binaryDigest(flags.binary);
  if (flags.id === undefined) fail("--id is required");
  const overlay = await load(digest);
  const before = overlay.entries.length;
  overlay.entries = overlay.entries.filter((entry) => entry.id !== flags.id);
  const saved = await save(overlay);
  process.stdout.write(
    `removed ${String(before - saved.entries.length)} entry\n`,
  );
};

const ghidraExport = (overlay) => {
  const lines = [
    "# Generated by XTNA symbol overlay. Apply in Ghidra's Script Manager.",
    "# Renames only; no bytes are modified.",
    "from ghidra.program.model.symbol import SourceType",
    "",
    "def xtna_apply():",
    "    listing = currentProgram.getListing()",
    "    symbolTable = currentProgram.getSymbolTable()",
  ];
  if (overlay.entries.length === 0) lines.push("    pass");
  for (const entry of overlay.entries) {
    const address = Number.parseInt(entry.address, 10).toString(16);
    lines.push(
      `    # ${entry.confidence}${entry.type ? ` :: ${entry.type}` : ""}`,
    );
    lines.push(`    addr = toAddr(0x${address})`);
    lines.push(
      entry.kind === "function"
        ? `    fn = getFunctionAt(addr) or createFunction(addr, None); fn.setName(${JSON.stringify(entry.name)}, SourceType.USER_DEFINED)`
        : `    symbolTable.createLabel(addr, ${JSON.stringify(entry.name)}, SourceType.USER_DEFINED)`,
    );
    if (entry.comment !== null)
      lines.push(
        `    listing.setComment(addr, 0, ${JSON.stringify(entry.comment)})`,
      );
  }
  lines.push("", "xtna_apply()", "");
  return lines.join("\n");
};

const idaExport = (overlay) => {
  const lines = [
    "# Generated by XTNA symbol overlay. Run with File > Script file in IDA.",
    "# Renames only; no bytes are modified.",
    "",
  ];
  if (overlay.entries.length === 0) lines.push("# no symbols");
  for (const entry of overlay.entries) {
    const address = Number.parseInt(entry.address, 10).toString(16);
    lines.push(`# ${entry.confidence}`);
    lines.push(`MakeName(0x${address}, ${JSON.stringify(entry.name)});`);
    if (entry.comment !== null)
      lines.push(`MakeComm(0x${address}, ${JSON.stringify(entry.comment)});`);
  }
  lines.push("");
  return lines.join("\n");
};

const exportCommand = async () => {
  const digest = await binaryDigest(flags.binary);
  const format = flags.format ?? "ghidra";
  const overlay = await load(digest);
  const text =
    format === "ghidra"
      ? ghidraExport(overlay)
      : format === "ida"
        ? idaExport(overlay)
        : null;
  if (text === null) fail("--format must be ghidra or ida");
  if (typeof flags.out === "string") {
    await writeFile(resolve(flags.out), text, "utf8");
    process.stdout.write(
      `wrote ${String(overlay.entries.length)} symbols to ${String(flags.out)}\n`,
    );
    return;
  }
  process.stdout.write(text);
};

const show = async () => {
  const files = await readdir(overlayDir).catch(() => []);
  const rows = [];
  for (const file of files.filter((name) => name.endsWith(".json"))) {
    const overlay = JSON.parse(await readFile(join(overlayDir, file), "utf8"));
    rows.push(
      `${overlay.binary_sha256.slice(0, 12)}…  ${String(overlay.entries.length).padStart(4)} symbols`,
    );
  }
  process.stdout.write(
    rows.length === 0 ? "no overlays\n" : `${rows.join("\n")}\n`,
  );
};

const usage = `usage: node scripts/symbol-overlay.mjs <command> [options]

  add     --binary <path|sha256> --address 0xADDR --name NAME
          [--kind function|data|struct|field|label|import]
          [--type "signature"] [--comment "text"]
          [--confidence observed|inferred|guessed] [--evidence ev_...]
  list    --binary <path|sha256> [--json]
  remove  --binary <path|sha256> --id sym_...
  export  --binary <path|sha256> [--format ghidra|ida] [--out file]
  overlays

Environment: XTNA_OVERLAY_DIR (default ~/.xtna/overlays)
`;

const main = async () => {
  if (command === undefined || command === "--help" || command === "-h") {
    process.stdout.write(usage);
    return;
  }
  if (command === "add") return add();
  if (command === "list") return list();
  if (command === "remove") return removeEntry();
  if (command === "export") return exportCommand();
  if (command === "overlays") return show();
  fail(`unknown command: ${command}`);
};

await main();
