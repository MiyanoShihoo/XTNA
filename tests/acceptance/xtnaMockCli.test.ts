import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { expect, it } from "vitest";

const run = promisify(execFile);
const script = fileURLToPath(
  new URL("../../scripts/mock-server.mjs", import.meta.url),
);

const har = {
  log: {
    entries: [
      {
        request: { method: "GET", url: "https://api.test/events?limit=2" },
        response: {
          status: 200,
          content: {
            text: JSON.stringify({
              items: [
                { id: 1, kind: "a" },
                { id: 2, kind: "b" },
              ],
              next_cursor: null,
              has_more: false,
            }),
          },
        },
      },
      {
        request: {
          method: "POST",
          url: "https://api.test/events",
          postData: { text: JSON.stringify({ kind: "c" }) },
        },
        response: {
          status: 201,
          content: {
            text: JSON.stringify({
              id: 3,
              kind: "c",
              created_at: "2026-10-30T00:00:00.000Z",
            }),
          },
        },
      },
    ],
  },
};

interface Running {
  readonly base: string;
  readonly child: ChildProcess;
  readonly stop: () => Promise<void>;
}

const start = async (serverPath: string): Promise<Running> => {
  let stderr = "";
  const child = spawn(process.execPath, [serverPath], {
    env: { ...process.env, PORT: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  const port = await new Promise<number>((resolve, reject) => {
    let buffered = "";
    const timer = setTimeout(
      () => reject(new Error(`mock server did not start: ${stderr}`)),
      15_000,
    );
    child.stdout?.on("data", (chunk: Buffer) => {
      buffered += chunk.toString("utf8");
      const line = buffered.split("\n")[0] ?? "";
      if (!line.startsWith("{")) return;
      clearTimeout(timer);
      resolve((JSON.parse(line) as { port: number }).port);
    });
    child.on("error", reject);
  });
  return {
    base: `http://127.0.0.1:${String(port)}`,
    child,
    stop: async () => {
      if (child.exitCode !== null) return;
      const exited = new Promise<void>((resolve) => {
        child.once("exit", () => resolve());
      });
      child.kill();
      await exited;
    },
  };
};

it("generates a SQLite-backed server with cursors and persistence", async () => {
  const root = await mkdtemp(join(tmpdir(), "rea-mock-cli-"));
  const input = join(root, "capture.har");
  const serverPath = join(root, "server.mjs");
  const sqlite = join(root, "state.sqlite");
  await writeFile(input, JSON.stringify(har));
  try {
    const generated = await run(
      process.execPath,
      [
        script,
        "--in",
        input,
        "--out",
        serverPath,
        "--sqlite",
        sqlite,
        "--port",
        "0",
      ],
      { env: process.env },
    );
    const manifest = JSON.parse(generated.stdout) as {
      backend: string;
      sqlite: string;
      paged: string[];
      generatedTimestamps: Record<string, string[]>;
    };
    expect(manifest.backend).toBe("sqlite");
    expect(manifest.sqlite).toBe(sqlite);
    expect(manifest.paged).toEqual(["GET /events"]);
    expect(manifest.generatedTimestamps.events).toEqual(["created_at"]);

    const first = await start(serverPath);
    try {
      const created = await fetch(`${first.base}/events`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "d" }),
      });
      expect(created.status).toBe(201);
      const createdBody = (await created.json()) as { created_at?: string };
      expect(typeof createdBody.created_at).toBe("string");
    } finally {
      await first.stop();
    }

    const second = await start(serverPath);
    try {
      const list = await fetch(`${second.base}/events?limit=1`);
      const page = (await list.json()) as {
        items: { id: number }[];
        next_cursor: string | null;
        has_more: boolean;
      };
      expect(page.items).toHaveLength(1);
      expect(page.has_more).toBe(true);
      expect(typeof page.next_cursor).toBe("string");

      const next = await fetch(
        `${second.base}/events?limit=1&cursor=${String(page.next_cursor)}`,
      );
      const secondPage = (await next.json()) as { items: { id: number }[] };
      expect(secondPage.items.map((item) => item.id)).toEqual([2]);
    } finally {
      await second.stop();
    }
  } finally {
    await rm(root, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 20,
    });
  }
}, 60_000);
