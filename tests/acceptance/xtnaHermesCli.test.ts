import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { expect, it } from "vitest";

const run = promisify(execFile);
const script = fileURLToPath(
  new URL("../../scripts/hermes-inspect.mjs", import.meta.url),
);

const MAGIC = 0x1f1903c103bc1fc6n;
const HEADER = 128;

const hermesModule = (strings: readonly string[]): Buffer => {
  const storage = Buffer.concat(
    strings.map((text) => Buffer.from(text, "utf8")),
  );
  const entries: number[] = [];
  let offset = 0;
  for (const text of strings) {
    const bytes = Buffer.from(text, "utf8");
    entries.push((offset << 1) | (bytes.length << 24));
    offset += bytes.length;
  }
  const functions = Buffer.alloc(16);
  functions.writeUInt32LE(1 << 25, 0);
  functions.writeUInt32LE(8 & 0x7fff, 4);
  functions.writeUInt8(0, 15);
  const kinds = Buffer.alloc(4);
  kinds.writeUInt32LE(strings.length, 0);
  const table = Buffer.alloc(strings.length * 4);
  entries.forEach((entry, index) => table.writeUInt32LE(entry, index * 4));
  const total =
    HEADER + functions.length + kinds.length + table.length + storage.length;
  const header = Buffer.alloc(HEADER);
  header.writeBigUInt64LE(MAGIC, 0);
  header.writeUInt32LE(84, 8);
  header.writeUInt32LE(total, 32);
  header.writeUInt32LE(1, 40);
  header.writeUInt32LE(1, 44);
  header.writeUInt32LE(0, 48);
  header.writeUInt32LE(strings.length, 52);
  header.writeUInt32LE(0, 56);
  header.writeUInt32LE(storage.length, 60);
  return Buffer.concat([header, functions, kinds, table, storage]);
};

it("reports a Hermes header with tables and refuses a non-Hermes file", async () => {
  const root = await mkdtemp(join(tmpdir(), "rea-hermes-cli-"));
  const bundle = join(root, "index.android.bundle");
  const plain = join(root, "plain.bin");
  const bytes = hermesModule(["global", "password"]);
  await writeFile(bundle, bytes);
  await writeFile(plain, "not bytecode");
  try {
    const reported = await run(
      process.execPath,
      [script, "--in", bundle, "--json", "--tables"],
      { env: process.env },
    );
    const report = JSON.parse(reported.stdout) as {
      state: string;
      bytes: number;
      facts: { version: number; functionCount: number };
      versionSupported: boolean;
      tables: {
        strings: { value: string }[];
        functions: { name: string | null }[];
      };
      limitations: string[];
    };
    expect(report.state).toBe("parsed");
    expect(report.bytes).toBe(bytes.length);
    expect(report.facts.version).toBe(84);
    expect(report.facts.functionCount).toBe(1);
    expect(report.versionSupported).toBe(true);
    expect(report.tables.strings.map((entry) => entry.value)).toEqual([
      "global",
      "password",
    ]);
    expect(report.tables.functions[0]?.name).toBe("global");
    expect(report.limitations.join(" ")).toContain("AST");

    const text = await run(
      process.execPath,
      [script, "--in", bundle, "--tables"],
      { env: process.env },
    );
    expect(text.stdout).toContain("strings: 2 (first: global, password)");
    expect(text.stdout).toContain("functions: global");

    await expect(
      run(process.execPath, [script, "--in", plain, "--json"], {
        env: process.env,
      }),
    ).rejects.toMatchObject({ code: 3 });
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5 });
  }
});
