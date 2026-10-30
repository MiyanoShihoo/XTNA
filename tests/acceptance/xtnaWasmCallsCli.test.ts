import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { expect, it } from "vitest";

const run = promisify(execFile);
const script = fileURLToPath(
  new URL("../../scripts/wasm-calls.mjs", import.meta.url),
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
  const bodies = [[0x10, 0x01, 0x10, 0x02], [0x10, 0x02], []];
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
    ...section(3, [0x03, 0x00, 0x00, 0x00]),
    ...section(10, [
      0x03,
      ...bodies.flatMap((body) => [
        ...uleb(body.length + 2),
        0x00,
        ...body,
        0x0b,
      ]),
    ]),
  ]);
};

it("reports direct wasm call edges as JSON and text", async () => {
  const root = await mkdtemp(join(tmpdir(), "rea-wasm-calls-"));
  const wasm = join(root, "module.wasm");
  await writeFile(wasm, moduleBytes());
  const broken = join(root, "broken.bin");
  await writeFile(broken, "not wasm");
  try {
    const json = await run(process.execPath, [script, "--in", wasm, "--json"], {
      env: process.env,
    });
    const graph = JSON.parse(json.stdout) as {
      functions: { index: number }[];
      edges: { from: number; to: number | null; kind: string }[];
      undecodedFunctions: number[];
    };
    expect(graph.functions.map((fact) => fact.index)).toEqual([0, 1, 2]);
    expect(graph.edges).toEqual([
      { from: 0, to: 1, kind: "direct" },
      { from: 0, to: 2, kind: "direct" },
      { from: 1, to: 2, kind: "direct" },
    ]);
    expect(graph.undecodedFunctions).toEqual([]);

    const text = await run(process.execPath, [script, "--in", wasm], {
      env: process.env,
    });
    expect(text.stdout).toContain("functions: 3 defined, 0 imported");
    expect(text.stdout).toContain("edges: 3");
    expect(text.stdout).toContain("f0 -> f1");

    await expect(
      run(process.execPath, [script, "--in", broken, "--json"], {
        env: process.env,
      }),
    ).rejects.toMatchObject({ code: 3 });
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5 });
  }
});
