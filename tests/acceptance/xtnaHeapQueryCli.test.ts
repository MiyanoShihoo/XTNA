import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { expect, it } from "vitest";

const run = promisify(execFile);
const script = fileURLToPath(
  new URL("../../scripts/heap-query.mjs", import.meta.url),
);
const snapshot = {
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
    node_count: 3,
    edge_count: 2,
  },
  nodes: [3, 1, 1, 100, 2, 0, 0, 3, 1, 2, 50, 0, 0, 0, 4, 2, 3, 20, 0, 0, 0],
  edges: [2, 1, 7, 2, 2, 14],
  strings: ["", "Foo", "bar"],
};

it("prints retained sizes from the dominator tree", async () => {
  const root = await mkdtemp(join(tmpdir(), "rea-heap-cli-"));
  const input = join(root, "app.heapsnapshot");
  await writeFile(input, JSON.stringify(snapshot));
  try {
    const result = await run(
      process.execPath,
      [script, "--in", input, "--dominators", "--json"],
      { env: process.env },
    );
    const parsed = JSON.parse(result.stdout) as {
      nodes: number;
      retained: {
        retained_size: number;
        name: string;
        type: string;
      }[];
    };
    expect(parsed.nodes).toBe(3);
    expect(parsed.retained.map(({ retained_size }) => retained_size)).toEqual([
      170, 50, 20,
    ]);
    expect(parsed.retained[0]).toMatchObject({ name: "Foo", type: "object" });
  } finally {
    await rm(root, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 20,
    });
  }
});
