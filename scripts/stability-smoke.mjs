#!/usr/bin/env node
/**
 * End-to-end smoke harness for the analysis utilities.
 *
 * Generates every fixture it needs in a temporary directory, runs each CLI as a
 * child process exactly as a user would, and fails when a tool exits non-zero or
 * stops producing the output it promises.
 */
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repo = resolve(import.meta.dirname, "..");
const work = await mkdtemp(join(tmpdir(), "xtna-smoke-"));

const run = (args, env = {}) =>
  new Promise((resolveRun) => {
    const child = spawn(process.execPath, args, {
      cwd: repo,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString("utf8")));
    child.on("error", (error) =>
      resolveRun({ code: 1, stdout, stderr: `${stderr}${String(error)}` }),
    );
    child.on("close", (code) =>
      resolveRun({ code: code ?? 1, stdout, stderr }),
    );
  });

const leb = (value) => {
  const out = [];
  let current = value;
  do {
    let byte = current & 0x7f;
    current >>>= 7;
    if (current !== 0) byte |= 0x80;
    out.push(byte);
  } while (current !== 0);
  return out;
};
const wasmName = (text) => {
  const bytes = [...new TextEncoder().encode(text)];
  return [...leb(bytes.length), ...bytes];
};
const section = (id, payload) => [id, ...leb(payload.length), ...payload];

await mkdir(join(work, "sdk"), { recursive: true });
await writeFile(
  join(work, "min.js"),
  'const a=!0,b=60*1000;if(false){x()}else{y()};const s="\\x41";',
  "utf8",
);
await writeFile(
  join(work, "capture.har"),
  JSON.stringify({
    log: {
      entries: [
        {
          request: { method: "GET", url: "https://api.test/users" },
          response: {
            status: 200,
            content: { text: JSON.stringify([{ id: 1, name: "Ada" }]) },
          },
        },
        {
          request: {
            method: "POST",
            url: "https://api.test/users",
            postData: { text: '{"name":"New"}' },
          },
          response: { status: 201, content: { text: '{"id":2,"name":"New"}' } },
        },
      ],
    },
  }),
  "utf8",
);
await writeFile(
  join(work, "bridge.wasm"),
  new Uint8Array([
    0x00,
    0x61,
    0x73,
    0x6d,
    0x01,
    0x00,
    0x00,
    0x00,
    ...section(2, [
      ...leb(1),
      ...wasmName("env"),
      ...wasmName("abort"),
      0x00,
      ...leb(0),
    ]),
    ...section(7, [...leb(1), ...wasmName("add"), 0x00, ...leb(0)]),
  ]),
);
await writeFile(
  join(work, "glue.js"),
  "const imports = { env: { abort: abortImpl } };\nWebAssembly.instantiate(bytes, imports);\ninstance.exports.add(1, 2);\n",
  "utf8",
);
await writeFile(
  join(work, "heap.heapsnapshot"),
  JSON.stringify({
    snapshot: {
      meta: {
        node_fields: [
          "type",
          "name",
          "id",
          "self_size",
          "edge_count",
          "trace_node_id",
          "detachedness",
        ],
        node_types: [
          ["hidden", "array", "string", "object", "closure"],
          "string",
          "number",
          "number",
          "number",
          "number",
          "number",
        ],
        edge_fields: ["type", "name_or_index", "to_node"],
        edge_types: [
          ["context", "element", "property", "internal", "hidden"],
          "string_or_number",
          "node",
        ],
      },
      node_count: 2,
      edge_count: 0,
    },
    nodes: [3, 1, 1, 100, 0, 0, 0, 3, 1, 2, 40, 0, 0, 0],
    edges: [],
    strings: ["", "CacheEntry"],
  }),
  "utf8",
);
await writeFile(
  join(work, "ui.json"),
  JSON.stringify([
    { timestamp: 1000, name: "click" },
    { timestamp: 5000, name: "idle" },
  ]),
  "utf8",
);
await writeFile(
  join(work, "ipc.jsonl"),
  JSON.stringify({ timestamp: 1020, name: "ipc:save", traceId: "t1" }),
  "utf8",
);
const binaryPath = join(work, "target.bin");
await writeFile(binaryPath, "not a real binary", "utf8");
await mkdir(join(work, "overlays"), { recursive: true });
const digest = createHash("sha256").update("not a real binary").digest("hex");
await writeFile(
  join(work, "overlays", `${digest}.json`),
  JSON.stringify({
    schema: "xtna.symbol-overlay/1",
    binary_sha256: digest,
    entries: [
      {
        id: "sym_1",
        address_hex: "0x401000",
        address: "4198400",
        name: "parseOrder",
        kind: "function",
        confidence: "inferred",
      },
    ],
  }),
  "utf8",
);
await writeFile(
  join(work, "evidence.json"),
  JSON.stringify({
    records: [
      {
        normalized_result: { pseudocode: "void FUN_401000(void) { return; }" },
      },
    ],
  }),
  "utf8",
);

const checks = [
  [
    "ast:normalize",
    ["scripts/ast-normalize.mjs", "--in", join(work, "min.js"), "--json"],
    /"foldedConstants": *[1-9]/u,
  ],
  [
    "sdk:gen",
    [
      "scripts/sdk-gen.mjs",
      "--in",
      join(work, "capture.har"),
      "--out",
      join(work, "sdk"),
    ],
    /"operations": *2/u,
  ],
  [
    "mock:gen",
    [
      "scripts/mock-server.mjs",
      "--in",
      join(work, "capture.har"),
      "--out",
      join(work, "mock", "server.mjs"),
    ],
    /DELETE \/users\/\{id\}/u,
  ],
  [
    "probe:gen",
    [
      "scripts/probe-gen.mjs",
      "--address",
      "0x401000",
      "--out",
      join(work, "probe.js"),
    ],
    /wrote frida probe/u,
  ],
  [
    "heap:query",
    [
      "scripts/heap-query.mjs",
      "--in",
      join(work, "heap.heapsnapshot"),
      "--name",
      "CacheEntry",
      "--json",
    ],
    /"id": *1/u,
  ],
  [
    "trace:causal",
    [
      "scripts/causal-trace.mjs",
      "--browser",
      join(work, "ui.json"),
      "--ipc",
      join(work, "ipc.jsonl"),
      "--json",
    ],
    /"chains"/u,
  ],
  [
    "wasm:link",
    [
      "scripts/wasm-link.mjs",
      "--wasm",
      join(work, "bridge.wasm"),
      "--js",
      join(work, "glue.js"),
      "--json",
    ],
    /"to": *"add"/u,
  ],
  [
    "overlay:render",
    [
      "scripts/overlay-render.mjs",
      "--binary",
      binaryPath,
      "--evidence",
      join(work, "evidence.json"),
    ],
    /identifier replacements: 1/u,
  ],
];

const results = [];
for (const [name, args, expectation] of checks) {
  const result = await run(args, { XTNA_OVERLAY_DIR: join(work, "overlays") });
  const output = `${result.stdout}\n${result.stderr}`;
  const passes = result.code === 0 && expectation.test(output);
  results.push({
    name,
    ok: passes,
    detail: passes ? "" : output.slice(0, 300),
  });
}

const probeSource = await readFile(join(work, "probe.js"), "utf8").catch(
  () => "",
);
results.push({
  name: "probe:gen output",
  ok: probeSource.includes("Interceptor.attach"),
  detail: probeSource === "" ? "probe.js was not written" : "",
});

await rm(work, { recursive: true, force: true });
for (const row of results)
  process.stdout.write(
    `${row.ok ? "ok  " : "FAIL"} ${row.name}${row.detail === "" ? "" : `\n     ${row.detail.replaceAll("\n", "\n     ")}`}\n`,
  );
const failed = results.filter((row) => !row.ok).length;
process.stdout.write(
  `\n${String(results.length - failed)}/${String(results.length)} utilities healthy\n`,
);
process.exitCode = failed === 0 ? 0 : 1;
