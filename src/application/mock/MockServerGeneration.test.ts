import { spawn } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { buildMockModel, renderMockServer } from "./MockServerGeneration.js";

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
});

describe("generated server", () => {
  it("is a single dependency-free module", () => {
    const source = renderMockServer(buildMockModel(har), { port: 1234 });
    expect(source).toContain('from "node:http"');
    expect(source).not.toContain("node_modules");
    expect(source).toContain('"users"');
  });

  it("serves CRUD over the recorded state", async () => {
    const directory = await mkdtemp(join(tmpdir(), "xtna-mock-"));
    const serverPath = join(directory, "server.mjs");
    await writeFile(
      serverPath,
      renderMockServer(buildMockModel(har), { port: 0 }),
      "utf8",
    );
    let stderr = "";
    const child = spawn(process.execPath, [serverPath], {
      env: { ...process.env, PORT: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    try {
      const port = await new Promise<number>((resolve, reject) => {
        let buffered = "";
        const timer = setTimeout(
          () => reject(new Error(`server did not start: ${stderr}`)),
          15_000,
        );
        child.stdout.on("data", (chunk: Buffer) => {
          buffered += chunk.toString("utf8");
          const line = buffered.split("\n")[0] ?? "";
          if (line.startsWith("{")) {
            clearTimeout(timer);
            resolve(JSON.parse(line).port as number);
          }
        });
        child.on("error", reject);
      });
      const base = `http://127.0.0.1:${String(port)}`;
      const request = async (path: string, init?: RequestInit) => {
        try {
          return await fetch(`${base}${path}`, init);
        } catch (error) {
          throw new Error(
            `${path} failed: ${String(error)}; server stderr: ${stderr}`,
          );
        }
      };

      const list = await request("/users");
      expect(list.status).toBe(200);
      expect((await list.json()) as unknown[]).toHaveLength(2);

      const created = await request("/users", {
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

      const read = await request("/users/3");
      expect(read.status).toBe(200);

      const removed = await request("/users/3", { method: "DELETE" });
      expect(removed.status).toBe(204);

      const missing = await request("/users/3");
      expect(missing.status).toBe(404);
    } finally {
      child.kill();
    }
  }, 30_000);
});
