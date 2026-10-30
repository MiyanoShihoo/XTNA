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

const hermesHeader = (version: number, functions: number): Buffer => {
  const buffer = Buffer.alloc(60 + 1_024);
  buffer.writeUInt32LE(0xc61fbc3f, 0);
  buffer.writeUInt32LE(version, 4);
  buffer.fill(0x11, 8, 28);
  buffer.writeUInt32LE(60 + 1_024, 28);
  buffer.writeUInt32LE(0, 32);
  buffer.writeUInt32LE(functions, 36);
  buffer.writeUInt32LE(2, 40);
  buffer.writeUInt32LE(9, 44);
  buffer.writeUInt32LE(120, 48);
  buffer.writeUInt32LE(0, 52);
  buffer.writeUInt32LE(2_048, 56);
  return buffer;
};

it("reports a Hermes header and refuses a non-Hermes file", async () => {
  const root = await mkdtemp(join(tmpdir(), "rea-hermes-cli-"));
  const bundle = join(root, "index.android.bundle");
  const plain = join(root, "plain.bin");
  await writeFile(bundle, hermesHeader(96, 42));
  await writeFile(plain, "not bytecode");
  try {
    const reported = await run(
      process.execPath,
      [script, "--in", bundle, "--json"],
      {
        env: process.env,
      },
    );
    const report = JSON.parse(reported.stdout) as {
      state: string;
      bytes: number;
      facts: { version: number; functionCount: number };
      versionSupported: boolean;
      limitations: string[];
    };
    expect(report.state).toBe("parsed");
    expect(report.bytes).toBe(1_084);
    expect(report.facts.version).toBe(96);
    expect(report.facts.functionCount).toBe(42);
    expect(report.versionSupported).toBe(true);
    expect(report.limitations.join(" ")).toContain("No AST");

    await expect(
      run(process.execPath, [script, "--in", plain, "--json"], {
        env: process.env,
      }),
    ).rejects.toMatchObject({ code: 3 });
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5 });
  }
});
