import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  buildMockModel,
  renderMockServer,
  type MockServerOptions,
} from "./MockServerGeneration.js";

const har = {
  log: {
    entries: [
      {
        request: { method: "GET", url: "https://api.example.test/users" },
        response: {
          status: 200,
          content: {
            text: JSON.stringify([
              { id: 1, name: "Ada" },
              { id: 2, name: "Grace" },
            ]),
          },
        },
      },
      {
        request: { method: "GET", url: "https://api.example.test/users/1" },
        response: {
          status: 200,
          content: { text: JSON.stringify({ id: 1, name: "Ada" }) },
        },
      },
      {
        request: {
          method: "POST",
          url: "https://api.example.test/users",
          postData: { text: JSON.stringify({ name: "New" }) },
        },
        response: {
          status: 201,
          content: { text: JSON.stringify({ id: 3, name: "New" }) },
        },
      },
    ],
  },
};

const pagedHar = {
  log: {
    entries: [
      {
        request: {
          method: "GET",
          url: "https://api.example.test/events?limit=2",
        },
        response: {
          status: 200,
          content: {
            text: JSON.stringify({
              items: [
                { id: 1, kind: "a" },
                { id: 2, kind: "b" },
              ],
              next_cursor: "eyJvIjoyfQ==",
              has_more: true,
            }),
          },
        },
      },
      {
        request: {
          method: "POST",
          url: "https://api.example.test/events",
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

interface RunningServer {
  readonly base: string;
  readonly backend: string;
  readonly child: ChildProcess;
  readonly stop: () => Promise<void>;
}

const startServer = async (
  directory: string,
  options: MockServerOptions,
): Promise<RunningServer> => {
  const serverPath = join(directory, "server.mjs");
  await writeFile(
    serverPath,
    renderMockServer(buildMockModel(har), { port: 0, ...options }),
    "utf8",
  );
  return spawnServer(serverPath);
};

const spawnServer = async (serverPath: string): Promise<RunningServer> => {
  let stderr = "";
  const child = spawn(process.execPath, [serverPath], {
    env: { ...process.env, PORT: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  const started = new Promise<{ port: number; backend: string }>(
    (resolve, reject) => {
      let buffered = "";
      const timer = setTimeout(
        () => reject(new Error(`server did not start: ${stderr}`)),
        15_000,
      );
      child.stdout?.on("data", (chunk: Buffer) => {
        buffered += chunk.toString("utf8");
        const line = buffered.split("\n")[0] ?? "";
        if (line.startsWith("{")) {
          clearTimeout(timer);
          const parsed = JSON.parse(line) as { port: number; backend: string };
          resolve(parsed);
        }
      });
      child.on("error", reject);
    },
  );
  const { port, backend } = await started;
  const base = `http://127.0.0.1:${String(port)}`;
  return {
    base,
    backend,
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

const request = async (
  server: RunningServer,
  path: string,
  init?: RequestInit,
): Promise<Response> => {
  try {
    return await fetch(`${server.base}${path}`, init);
  } catch (error) {
    throw new Error(`${path} failed: ${String(error)}`);
  }
};

describe("model extraction", () => {
  it("derives routes and seeds collections from recorded responses", () => {
    const model = buildMockModel(har);
    const listed = model.routes.map(
      (route) => `${route.method} ${route.template}`,
    );
    expect(listed).toEqual(
      expect.arrayContaining([
        "GET /users",
        "GET /users/{id}",
        "POST /users",
        "PUT /users/{id}",
        "PATCH /users/{id}",
        "DELETE /users/{id}",
      ]),
    );
    expect(model.seed.users).toHaveLength(2);
    expect(model.pages["GET /users"]).toBeUndefined();
  });

  it("treats numeric and UUID segments as one identifier slot", () => {
    const model = buildMockModel({
      entries: [
        {
          request: {
            method: "GET",
            url: "https://x.test/orders/1f8f0c1e-1111-2222-3333-444455556666",
          },
          response: {
            status: 200,
            content: { text: JSON.stringify({ id: 1 }) },
          },
        },
      ],
    });
    expect(model.routes[0]?.template).toBe("/orders/{id}");
  });

  it("recognizes a captured paged envelope and its items", () => {
    const model = buildMockModel(pagedHar);
    expect(model.pages["GET /events"]).toEqual({
      itemsKey: "items",
      cursorKey: "next_cursor",
      hasMoreKey: "has_more",
      defaultLimit: 2,
    });
    expect(model.seed.events).toHaveLength(2);
  });

  it("records server-generated timestamps observed on create", () => {
    const model = buildMockModel(pagedHar);
    expect(model.timestamps.events).toEqual(["created_at"]);
    expect(buildMockModel(har).timestamps.users).toBeUndefined();
  });
});

describe("generated server", () => {
  it("is a single dependency-free module", () => {
    const source = renderMockServer(buildMockModel(har), { port: 1234 });
    expect(source).toContain('from "node:http"');
    expect(source).not.toContain("node_modules");
    expect(source).toContain('"users"');
    expect(source).toContain("node:sqlite");
  });

  it("serves CRUD over the recorded state", async () => {
    const directory = await mkdtemp(join(tmpdir(), "xtna-mock-"));
    const server = await startServer(directory, { port: 0 });
    try {
      expect(server.backend).toBe("sqlite");

      const list = await request(server, "/users");
      expect(list.status).toBe(200);
      expect((await list.json()) as unknown[]).toHaveLength(2);

      const created = await request(server, "/users", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "New" }),
      });
      expect(created.status).toBe(201);
      const createdBody = (await created.json()) as {
        id: number;
        name: string;
      };
      expect(createdBody.name).toBe("New");
      expect(createdBody.id).toBe(3);

      const read = await request(server, "/users/3");
      expect(read.status).toBe(200);

      const updated = await request(server, "/users/3", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Renamed" }),
      });
      expect(updated.status).toBe(200);
      expect(((await updated.json()) as { name: string }).name).toBe("Renamed");

      const removed = await request(server, "/users/3", { method: "DELETE" });
      expect(removed.status).toBe(204);

      const missing = await request(server, "/users/3");
      expect(missing.status).toBe(404);
    } finally {
      await server.stop();
    }
  }, 30_000);

  it("serves the memory backend when SQLite is not requested", async () => {
    const directory = await mkdtemp(join(tmpdir(), "xtna-mock-"));
    const server = await startServer(directory, { port: 0, backend: "memory" });
    try {
      expect(server.backend).toBe("memory");
      const created = await request(server, "/users", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Mem" }),
      });
      expect(created.status).toBe(201);
      const read = await request(server, "/users/3");
      expect(read.status).toBe(200);
    } finally {
      await server.stop();
    }
  }, 30_000);

  it("persists SQLite state across a restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "xtna-mock-"));
    const sqlite = join(directory, "state.sqlite");
    const serverPath = join(directory, "server.mjs");
    await writeFile(
      serverPath,
      renderMockServer(buildMockModel(har), { port: 0, sqlite }),
      "utf8",
    );

    const first = await spawnServer(serverPath);
    try {
      const created = await request(first, "/users", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Persisted" }),
      });
      expect(created.status).toBe(201);
    } finally {
      await first.stop();
    }

    const second = await spawnServer(serverPath);
    try {
      const list = await request(second, "/users");
      const items = (await list.json()) as { name: string }[];
      expect(items.map((item) => item.name)).toContain("Persisted");
    } finally {
      await second.stop();
    }
  }, 30_000);

  it("pages a captured envelope with an opaque cursor", async () => {
    const directory = await mkdtemp(join(tmpdir(), "xtna-mock-"));
    const serverPath = join(directory, "server.mjs");
    await writeFile(
      serverPath,
      renderMockServer(buildMockModel(pagedHar), { port: 0 }),
      "utf8",
    );
    const server = await spawnServer(serverPath);
    try {
      for (const kind of ["c", "d"]) {
        const created = await request(server, "/events", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ kind }),
        });
        expect(created.status).toBe(201);
        const body = (await created.json()) as { created_at?: string };
        expect(typeof body.created_at).toBe("string");
      }

      const first = await request(server, "/events?limit=2");
      expect(first.status).toBe(200);
      const firstPage = (await first.json()) as {
        items: { id: number }[];
        next_cursor: string | null;
        has_more: boolean;
      };
      expect(firstPage.items).toHaveLength(2);
      expect(firstPage.has_more).toBe(true);
      expect(typeof firstPage.next_cursor).toBe("string");

      const second = await request(
        server,
        `/events?limit=2&cursor=${String(firstPage.next_cursor)}`,
      );
      const secondPage = (await second.json()) as {
        items: { id: number }[];
        has_more: boolean;
      };
      expect(secondPage.items).toHaveLength(2);
      expect(secondPage.has_more).toBe(false);
      expect(
        [...firstPage.items, ...secondPage.items].map((item) => item.id),
      ).toEqual([1, 2, 3, 4]);

      const bad = await request(server, "/events?cursor=not-a-cursor");
      expect(bad.status).toBe(400);
    } finally {
      await server.stop();
    }
  }, 30_000);
});

describe("list view", () => {
  it("filters by field and sorts before paging", async () => {
    const directory = await mkdtemp(join(tmpdir(), "xtna-mock-view-"));
    const server = await startServer(directory, { port: 0 });
    try {
      const seed = (await (await request(server, "/users")).json()) as {
        name: string;
      }[];
      expect(seed.map((item) => item.name)).toEqual(["Ada", "Grace"]);

      const filtered = (await (
        await request(server, "/users?name=Ada")
      ).json()) as { name: string }[];
      expect(filtered.map((item) => item.name)).toEqual(["Ada"]);

      const sorted = (await (
        await request(server, "/users?sort=name&order=desc")
      ).json()) as { name: string }[];
      expect(sorted.map((item) => item.name)).toEqual(["Grace", "Ada"]);

      const unknownField = (await (
        await request(server, "/users?missing=1")
      ).json()) as unknown[];
      expect(unknownField).toEqual([]);
    } finally {
      await server.stop();
    }
  }, 30_000);
});
