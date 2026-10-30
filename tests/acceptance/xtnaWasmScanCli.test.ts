import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { expect, it } from "vitest";

const run = promisify(execFile);
const script = fileURLToPath(
  new URL("../../scripts/wasm-scan.mjs", import.meta.url),
);

const uleb = (value: number): number[] => {
  const bytes: number[] = [];
  let rest = value;
  do {
    let byte = rest & 0x7f;
    rest >>>= 7;
    if (rest !== 0) byte |= 0x80;
    bytes.push(byte);
  } while (rest !== 0);
  return bytes;
};

const section = (id: number, body: number[]): number[] => [
  id,
  ...uleb(body.length),
  ...body,
];

const moduleBytes = (): Buffer => {
  const bodies = [[0x10, 0x01], []];
  return Buffer.from([
    0x00,
    0x61,
    0x73,
    0x6d,
    0x01,
    0x00,
    0x00,
    0x00,
    ...section(1, [0x01, 0x60, 0x00, 0x00]),
    ...section(3, [0x02, 0x00, 0x00]),
    ...section(10, [
      0x02,
      ...bodies.flatMap((body) => [
        ...uleb(body.length + 2),
        0x00,
        ...body,
        0x0b,
      ]),
    ]),
  ]);
};

it("scans a directory for wasm modules by magic", async () => {
  const root = await mkdtemp(join(tmpdir(), "rea-wasm-scan-cli-"));
  await writeFile(join(root, "module.wasm"), moduleBytes());
  await writeFile(join(root, "renamed.bin"), moduleBytes());
  await writeFile(join(root, "readme.txt"), "not a module");
  try {
    const json = await run(process.execPath, [script, "--in", root, "--json"], {
      env: process.env,
    });
    const report = JSON.parse(json.stdout) as {
      modules: { edges: number }[];
      skippedNonWasm: number;
      truncated: boolean;
    };
    expect(report.modules).toHaveLength(2);
    expect(report.modules.map((module) => module.edges)).toEqual([1, 1]);
    expect(report.skippedNonWasm).toBe(1);
    expect(report.truncated).toBe(false);

    const text = await run(process.execPath, [script, "--in", root], {
      env: process.env,
    });
    expect(text.stdout).toContain("modules: 2");
    expect(text.stdout).toContain("edges=1");
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5 });
  }
});
