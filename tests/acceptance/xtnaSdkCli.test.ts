import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { expect, it } from "vitest";

const run = promisify(execFile);
const script = fileURLToPath(
  new URL("../../scripts/sdk-gen.mjs", import.meta.url),
);
const har = {
  log: {
    entries: [
      {
        request: { method: "GET", url: "https://api.test/users/42" },
        response: {
          status: 200,
          content: { text: JSON.stringify({ id: 42, name: "Ada" }) },
        },
      },
      {
        request: {
          method: "POST",
          url: "https://api.test/users?notify=true",
          postData: { text: JSON.stringify({ name: "Ada" }) },
        },
        response: {
          status: 201,
          content: { text: JSON.stringify({ id: 7, name: "Ada" }) },
        },
      },
    ],
  },
};

it("writes clients and a runnable generated Python smoke test", async () => {
  const root = await mkdtemp(join(tmpdir(), "rea-sdk-cli-"));
  const input = join(root, "capture.har");
  const output = join(root, "generated");
  await writeFile(input, JSON.stringify(har));
  try {
    const generated = await run(
      process.execPath,
      [script, "--in", input, "--out", output, "--lang", "both"],
      { env: process.env },
    );
    const manifest = JSON.parse(generated.stdout) as { files: string[] };
    expect(manifest.files).toEqual(
      expect.arrayContaining([
        join(output, "client.ts"),
        join(output, "client.test.ts"),
        join(output, "client.py"),
        join(output, "test_client.py"),
      ]),
    );
    expect(await readFile(join(output, "client.test.ts"), "utf8")).toContain(
      "generated client smoke",
    );
    const tested = await run("python", ["-m", "unittest", "test_client.py"], {
      cwd: output,
      env: process.env,
    });
    expect(tested.stderr).toContain("OK");
  } finally {
    await rm(root, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 20,
    });
  }
});

it("walks paginated responses with the generated Python client", async () => {
  const { createServer } = await import("node:http");
  const directory = await mkdtemp(join(tmpdir(), "rea-sdk-pages-"));
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const cursor = url.searchParams.get("cursor");
    const body =
      cursor === null
        ? { items: [{ id: 1 }, { id: 2 }], next_cursor: "c2" }
        : { items: [{ id: 3 }], next_cursor: null };
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port =
    typeof address === "object" && address !== null ? address.port : 0;
  try {
    const capture = join(directory, "capture.har");
    await writeFile(
      capture,
      JSON.stringify({
        log: {
          entries: [
            {
              request: {
                method: "GET",
                url: "https://api.test/events?limit=2",
              },
              response: {
                status: 200,
                content: {
                  text: JSON.stringify({
                    items: [{ id: 1 }, { id: 2 }],
                    next_cursor: "c2",
                  }),
                },
              },
            },
            {
              request: {
                method: "GET",
                url: "https://api.test/events?limit=2&cursor=c2",
              },
              response: {
                status: 200,
                content: {
                  text: JSON.stringify({
                    items: [{ id: 3 }],
                    next_cursor: null,
                  }),
                },
              },
            },
          ],
        },
      }),
    );
    const output = join(directory, "client");
    await run(
      process.execPath,
      [
        script,
        "--in",
        capture,
        "--out",
        output,
        "--lang",
        "py",
        "--base-url",
        `http://127.0.0.1:${String(port)}`,
      ],
      { env: process.env },
    );
    const tested = await run(
      "python",
      [
        "-c",
        "from client import ApiClient\n" +
          "client = ApiClient()\n" +
          "pages = client.get_events_pages({'limit': 2})\n" +
          "print(len(pages))\n" +
          "print([item['id'] for page in pages for item in page['items']])",
      ],
      { cwd: output, env: process.env },
    );
    expect(tested.stdout).toContain("2");
    expect(tested.stdout).toContain("[1, 2, 3]");
  } finally {
    server.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 5 });
  }
});
