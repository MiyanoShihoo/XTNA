import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  DEFAULT_READ_ONLY_TOOLS,
  validatePanelQuery,
} from "../../scripts/lib/panel-query-policy.mjs";

const script = fileURLToPath(
  new URL("../../scripts/panel-serve.mjs", import.meta.url),
);

const TOKEN = "panel-test-token";

interface FakeMcp {
  readonly url: string;
  readonly calls: { name: string; args: unknown }[];
  close: () => Promise<void>;
}

/** A minimal streamable-HTTP MCP server: initialize, initialized, tools/call. */
const startFakeMcp = async (): Promise<FakeMcp> => {
  const calls: { name: string; args: unknown }[] = [];
  const server = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => {
      raw += chunk;
    });
    request.on("end", () => {
      const message = JSON.parse(raw || "{}");
      if (message.method === "initialize") {
        response.writeHead(200, {
          "content-type": "application/json",
          "mcp-session-id": "fake-session",
        });
        response.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            result: {
              protocolVersion: "2025-06-18",
              capabilities: { tools: {} },
              serverInfo: { name: "fake", version: "1.0.0" },
            },
          }),
        );
        return;
      }
      if (message.method === "notifications/initialized") {
        response.writeHead(202).end();
        return;
      }
      if (message.method === "tools/call") {
        calls.push({
          name: message.params.name,
          args: message.params.arguments,
        });
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            result: {
              content: [
                { type: "text", text: `ran ${String(message.params.name)}` },
              ],
              isError: false,
            },
          }),
        );
        return;
      }
      response.writeHead(404).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port =
    typeof address === "object" && address !== null ? address.port : 0;
  return {
    url: `http://127.0.0.1:${String(port)}/mcp`,
    calls,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
};

interface Panel {
  readonly port: number;
  readonly child: ReturnType<typeof spawn>;
  readonly stderrText: () => string;
}

const startPanel = (args: readonly string[]): Promise<Panel> =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      env: { ...process.env, TMP: process.env.TMP },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let buffer = "";
    let errors = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      errors += chunk.toString("utf8");
    });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`panel did not start: ${buffer}`));
    }, 20_000);
    child.stdout?.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const line = buffer
        .split("\n")
        .find((entry) => entry.trim().startsWith("{"));
      if (line === undefined) return;
      clearTimeout(timer);
      const parsed = JSON.parse(line) as { port: number };
      resolve({ port: parsed.port, child, stderrText: () => errors });
    });
    child.on("error", reject);
  });

const stopPanel = async (panel: Panel) => {
  panel.child.kill();
  await new Promise((resolve) => setTimeout(resolve, 50));
};

const bundle = {
  artifacts: [
    {
      format: "pe",
      architecture: "x86-64",
      digest: { sha256: "b".repeat(64) },
    },
  ],
  records: [],
  providers: [],
  unknowns: [],
};

describe("panel query policy", () => {
  it("accepts an allowlisted tool with bounded scalar arguments", () => {
    expect(
      validatePanelQuery({
        tool: "analyze_function",
        args: { procedure: "0x140001008" },
      }),
    ).toEqual({
      ok: true,
      tool: "analyze_function",
      args: { procedure: "0x140001008" },
      tier: "read",
    });
  });

  it("refuses a tool outside the allowlist", () => {
    const verdict = validatePanelQuery({
      tool: "install_adb_package",
      args: {},
    });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.reason).toContain("not allowlisted");
  });

  it("refuses arguments that select files, processes or shells", () => {
    for (const key of ["path", "binaryPath", "command", "url", "script"]) {
      const verdict = validatePanelQuery({
        tool: "read_bytes",
        args: { [key]: "x" },
      });
      expect(verdict.ok, key).toBe(false);
    }
  });

  it("refuses nested values and control characters", () => {
    expect(
      validatePanelQuery({
        tool: "read_bytes",
        args: { address: { nested: 1 } },
      }).ok,
    ).toBe(false);
    expect(
      validatePanelQuery({ tool: "read_bytes", args: { address: "0x1\u0000" } })
        .ok,
    ).toBe(false);
  });

  it("offers a read-only default surface", () => {
    expect(DEFAULT_READ_ONLY_TOOLS).toContain("analyze_function");
    expect(DEFAULT_READ_ONLY_TOOLS).not.toContain("install_adb_package");
    expect(DEFAULT_READ_ONLY_TOOLS).not.toContain("instrument_with_frida");
  });
});

describe("panel query relay", () => {
  let fake: FakeMcp;
  let panel: Panel;
  let root: string;
  let logPath: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "rea-panel-query-"));
    const evidence = join(root, "bundle.json");
    logPath = join(root, "queries.jsonl");
    await writeFile(evidence, JSON.stringify(bundle));
    fake = await startFakeMcp();
    panel = await startPanel([
      "--evidence",
      evidence,
      "--port",
      "0",
      "--mcp-url",
      fake.url,
      "--query-token",
      TOKEN,
      "--query-log",
      logPath,
    ]);
  }, 40_000);

  afterAll(async () => {
    if (panel !== undefined) await stopPanel(panel);
    if (fake !== undefined) await fake.close();
    if (root !== undefined)
      await rm(root, { recursive: true, force: true, maxRetries: 5 });
  });

  const url = (path: string) => `http://127.0.0.1:${String(panel.port)}${path}`;

  it("advertises the allowlisted tools", async () => {
    const response = await fetch(url("/api/query"));
    const payload = (await response.json()) as {
      enabled: boolean;
      tools: string[];
    };
    expect(payload.enabled).toBe(true);
    expect(payload.tools).toContain("analyze_function");
  });

  it("requires the operator token", async () => {
    const response = await fetch(url("/api/query"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        tool: "analyze_function",
        args: { procedure: "0x1" },
      }),
    });
    expect(response.status).toBe(401);
    expect(fake.calls).toHaveLength(0);
  });

  it("refuses a cross-origin browser request even with a token", async () => {
    const response = await fetch(url("/api/query"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-xtna-token": TOKEN,
        origin: "http://evil.example",
      },
      body: JSON.stringify({
        tool: "analyze_function",
        args: { procedure: "0x1" },
      }),
    });
    expect(response.status).toBe(403);
    expect(fake.calls).toHaveLength(0);
  });

  it("refuses a non-allowlisted tool", async () => {
    const response = await fetch(url("/api/query"), {
      method: "POST",
      headers: { "content-type": "application/json", "x-xtna-token": TOKEN },
      body: JSON.stringify({ tool: "install_adb_package", args: {} }),
    });
    expect(response.status).toBe(400);
    expect(fake.calls).toHaveLength(0);
  });

  it("relays one read-only call and logs it", async () => {
    const response = await fetch(url("/api/query"), {
      method: "POST",
      headers: { "content-type": "application/json", "x-xtna-token": TOKEN },
      body: JSON.stringify({
        tool: "analyze_function",
        args: { procedure: "0x140001008" },
      }),
    });
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      ok: boolean;
      result: { content: { text: string }[] };
    };
    expect(payload.ok).toBe(true);
    expect(payload.result.content[0]?.text).toBe("ran analyze_function");
    expect(fake.calls).toEqual([
      { name: "analyze_function", args: { procedure: "0x140001008" } },
    ]);
    const log = await readFile(logPath, "utf8");
    expect(log).toContain('"tool":"analyze_function"');
    expect(log).toContain('"ok":true');
  });
});

describe("panel without a relay", () => {
  it("answers 404 and advertises nothing", async () => {
    const root = await mkdtemp(join(tmpdir(), "rea-panel-noquery-"));
    const evidence = join(root, "bundle.json");
    await writeFile(evidence, JSON.stringify(bundle));
    const panel = await startPanel(["--evidence", evidence, "--port", "0"]);
    try {
      const response = await fetch(
        `http://127.0.0.1:${String(panel.port)}/api/query`,
      );
      expect(response.status).toBe(404);
      const payload = (await response.json()) as { error: string };
      expect(payload.error).toContain("disabled");
    } finally {
      await stopPanel(panel);
      await rm(root, { recursive: true, force: true, maxRetries: 5 });
    }
  }, 40_000);
});

const waitForApproval = async (
  panel: Panel,
): Promise<{ id: string; code: string }> => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const matches = [
      ...panel.stderrText().matchAll(/APPROVAL (\S+) tool=\S+ code=(\d{6})/gu),
    ];
    const match = matches.at(-1);
    if (match !== undefined)
      return { id: match[1] as string, code: match[2] as string };
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("approval line never appeared");
};

describe("write tools need an explicit flag and terminal approval", () => {
  let fake: FakeMcp;
  let panel: Panel;
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "rea-panel-write-"));
    const evidence = join(root, "bundle.json");
    await writeFile(evidence, JSON.stringify(bundle));
    fake = await startFakeMcp();
    panel = await startPanel([
      "--evidence",
      evidence,
      "--port",
      "0",
      "--mcp-url",
      fake.url,
      "--query-token",
      TOKEN,
      "--allow-write-tools",
      "set_comment",
    ]);
  }, 40_000);

  afterAll(async () => {
    if (panel !== undefined) await stopPanel(panel);
    if (fake !== undefined) await fake.close();
    if (root !== undefined)
      await rm(root, { recursive: true, force: true, maxRetries: 5 });
  });

  const post = (body: unknown) =>
    fetch(`http://127.0.0.1:${String(panel.port)}/api/query`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-xtna-token": TOKEN },
      body: JSON.stringify(body),
    });

  it("refuses a write tool that was not named on the command line", async () => {
    const response = await post({
      tool: "set_bookmark",
      args: { address: "0x1" },
    });
    expect(response.status).toBe(400);
    expect(fake.calls).toHaveLength(0);
  });

  it("parks an allowed write tool until the terminal code is entered", async () => {
    const response = await post({
      tool: "set_comment",
      args: { address: "0x140001008", comment: "entry" },
    });
    expect(response.status).toBe(202);
    const pending = (await response.json()) as {
      status: string;
      requestId: string;
    };
    expect(pending.status).toBe("pending");
    expect(fake.calls).toHaveLength(0);
    const approval = await waitForApproval(panel);
    expect(approval.id).toBe(pending.requestId);

    const wrong = await post({
      tool: "set_comment",
      args: { address: "0x140001008", comment: "entry" },
      confirm: { requestId: pending.requestId, code: "000000" },
    });
    expect(wrong.status).toBe(403);
    expect(fake.calls).toHaveLength(0);

    const parked = await post({
      tool: "set_comment",
      args: { address: "0x140001008", comment: "entry" },
    });
    const second = (await parked.json()) as { requestId: string };
    const secondApproval = await waitForApproval(panel);
    expect(secondApproval.id).toBe(second.requestId);
    const approved = await post({
      tool: "set_comment",
      args: { address: "0x140001008", comment: "entry" },
      confirm: { requestId: second.requestId, code: secondApproval.code },
    });
    expect(approved.status).toBe(200);
    expect(fake.calls).toEqual([
      {
        name: "set_comment",
        args: { address: "0x140001008", comment: "entry" },
      },
    ]);

    const replay = await post({
      tool: "set_comment",
      args: { address: "0x140001008", comment: "entry" },
      confirm: { requestId: second.requestId, code: secondApproval.code },
    });
    expect(replay.status).toBe(403);
  });
});
