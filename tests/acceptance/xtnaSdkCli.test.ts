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
