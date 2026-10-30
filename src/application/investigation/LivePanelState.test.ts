import { spawn } from "node:child_process";
import { request as httpRequest } from "node:http";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { loadInvestigationState, snapshotDigest } from "./LivePanelState.js";

const bundle = {
  target_sha256: "a".repeat(64),
  records: [
    {
      operation: "procedure_pseudo_code",
      limitations: ["static only", "may stall"],
    },
    { operation: "inspect_native_exports", limitations: [] },
  ],
  artifacts: [{ path: "target.exe" }],
  unknowns: [{ id: "u1" }],
};

const writeFixture = async () => {
  const directory = await mkdtemp(join(tmpdir(), "xtna-panel-"));
  const evidencePath = join(directory, "bundle.json");
  const overlayPath = join(directory, "overlay.json");
  await writeFile(evidencePath, JSON.stringify(bundle), "utf8");
  await writeFile(
    overlayPath,
    JSON.stringify({
      schema: "xtna.symbol-overlay/1",
      entries: [
        {
          address_hex: "0x401000",
          name: "parseOrder",
          kind: "function",
          confidence: "inferred",
        },
      ],
    }),
    "utf8",
  );
  return { directory, evidencePath, overlayPath };
};

describe("investigation state", () => {
  it("projects counts, limitations and symbols", async () => {
    const { evidencePath, overlayPath } = await writeFixture();
    const snapshot = await loadInvestigationState({
      evidencePath,
      overlayPath,
    });
    expect(snapshot.counts.records).toBe(2);
    expect(snapshot.counts.limitations).toBe(2);
    expect(snapshot.counts.symbols).toBe(1);
    expect(snapshot.limitations[0]).toEqual({
      operation: "procedure_pseudo_code",
      text: "static only",
    });
    expect(snapshot.records).toHaveLength(2);
    expect(snapshot.records[0]).toEqual({
      id: "—",
      operation: "procedure_pseudo_code",
      provider: "unknown",
      authority: "—",
      confidence: "—",
      limitations: 2,
    });
    expect(snapshot.symbols[0]?.name).toBe("parseOrder");
  });

  it("ignores the title when digesting the projection", async () => {
    const { evidencePath, overlayPath } = await writeFixture();
    const first = snapshotDigest(
      await loadInvestigationState({ evidencePath, overlayPath }),
    );
    const second = snapshotDigest(
      await loadInvestigationState({
        evidencePath,
        overlayPath,
        title: "other",
      }),
    );
    expect(second).toBe(first);
  });
});

describe("live server", () => {
  it("serves the page, the state and a 404 without leaking files", async () => {
    const { evidencePath, overlayPath } = await writeFixture();
    const child = spawn(
      process.execPath,
      [
        "scripts/panel-serve.mjs",
        "--evidence",
        evidencePath,
        "--overlay",
        overlayPath,
        "--port",
        "0",
      ],
      { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] },
    );
    try {
      const port = await new Promise<number>((resolvePort, reject) => {
        let buffered = "";
        const timer = setTimeout(
          () => reject(new Error("server did not start")),
          15_000,
        );
        child.stdout.on("data", (chunk: Buffer) => {
          buffered += chunk.toString("utf8");
          const line = buffered.split("\n")[0] ?? "";
          if (line.startsWith("{")) {
            clearTimeout(timer);
            resolvePort(JSON.parse(line).port as number);
          }
        });
        child.on("error", reject);
      });
      const base = `http://127.0.0.1:${String(port)}`;
      const page = await fetch(`${base}/`);
      expect(page.status).toBe(200);
      expect(page.headers.get("content-type")).toContain("text/html");
      const html = await page.text();
      expect(html).toContain("Evidence cards");
      expect(html).toContain("renderCards");
      const state = await fetch(`${base}/api/state`);
      expect(state.status).toBe(200);
      const body = (await state.json()) as { counts: { records: number } };
      expect(body.counts.records).toBe(2);
      const missing = await fetch(`${base}/etc/passwd`);
      expect(missing.status).toBe(404);
      const post = await fetch(`${base}/api/state`, { method: "POST" });
      expect(post.status).toBe(405);
    } finally {
      child.kill();
    }
  }, 30_000);
});

describe("real artefact schemas", () => {
  it("reads the hypotheses board's items/statement shape", async () => {
    const { evidencePath } = await writeFixture();
    const directory = await mkdtemp(join(tmpdir(), "xtna-hyp-"));
    const hypothesesPath = join(directory, "hypotheses.json");
    await writeFile(
      hypothesesPath,
      JSON.stringify({
        schema: "xtna.hypotheses/1",
        items: [
          {
            id: "hyp_1",
            statement: "Module A handles reconnect",
            confidence: "inferred",
            status: "contradicted",
          },
        ],
      }),
      "utf8",
    );
    const snapshot = await loadInvestigationState({
      evidencePath,
      hypothesesPath,
    });
    expect(snapshot.hypotheses).toEqual([
      {
        id: "hyp_1",
        claim: "Module A handles reconnect",
        status: "contradicted",
        confidence: "inferred",
      },
    ]);
  });

  it("counts a checkpoint directory through its manifest", async () => {
    const { evidencePath, directory } = await writeFixture();
    const checkpointsDir = join(directory, "checkpoints");
    const cpDir = join(checkpointsDir, "cp_1");
    await mkdir(cpDir, { recursive: true });
    await writeFile(
      join(cpDir, "manifest.json"),
      JSON.stringify({
        schema: "xtna.checkpoint/1",
        id: "cp_1",
        name: "demo",
        created_at: "2026-10-28T17:00:07.446Z",
        files: [{ stored: "a.json", bytes: 100 }],
        overlays: [{ stored: "b.json", bytes: 20 }],
      }),
      "utf8",
    );
    const snapshot = await loadInvestigationState({
      evidencePath,
      checkpointsDir,
    });
    expect(snapshot.counts.checkpoints).toBe(1);
    expect(snapshot.checkpoints[0]).toEqual({
      name: "demo",
      bytes: 120,
      modifiedAt: "2026-10-28T17:00:07.446Z",
    });
  });
});

const visualBundle = {
  records: [
    {
      operation: "trace_call_path",
      normalized_result: {
        nodes: [
          { address: "0x401000", depth: 0 },
          { address: "0x401050", depth: 1, name: "parseOrder" },
        ],
        edges: [{ source_address: "0x401000", target_address: "0x401050" }],
      },
    },
    {
      operation: "inspect_web_network_capture",
      normalized_result: {
        transactions: [
          {
            id: "t1",
            method: "GET",
            url: "https://api.test/orders",
            status: 200,
            started_at: "2026-10-30T00:00:00.000Z",
            elapsed_ms: 40,
          },
          {
            id: "t2",
            method: "POST",
            url: "https://api.test/orders",
            status: 500,
            started_at: "2026-10-30T00:00:01.000Z",
            elapsed_ms: 90,
          },
        ],
      },
    },
    {
      operation: "capture_browser_scenario",
      normalized_result: {
        events: {
          items: [
            {
              kind: "request",
              transaction_id: "b1",
              method: "get",
              url: "https://web.test/app.js",
              started_at: "2026-10-30T00:00:02.000Z",
            },
            {
              kind: "response",
              transaction_id: "b1",
              status: 200,
              elapsed_ms: 12,
            },
          ],
        },
      },
    },
  ],
};

describe("topology and waterfall projection", () => {
  it("projects call-graph nodes, edges and network transactions", async () => {
    const directory = await mkdtemp(join(tmpdir(), "xtna-visual-"));
    const evidencePath = join(directory, "bundle.json");
    await writeFile(evidencePath, JSON.stringify(visualBundle), "utf8");
    const snapshot = await loadInvestigationState({ evidencePath });

    expect(snapshot.graph.nodes).toEqual([
      { id: "0x401000", label: "0x401000", depth: 0 },
      { id: "0x401050", label: "parseOrder", depth: 1 },
    ]);
    expect(snapshot.graph.edges).toEqual([
      { source: "0x401000", target: "0x401050" },
    ]);
    expect(snapshot.graph.truncated).toBe(false);

    expect(snapshot.waterfall.entries).toHaveLength(3);
    expect(snapshot.waterfall.entries[0]).toEqual({
      id: "t1",
      method: "GET",
      url: "https://api.test/orders",
      status: 200,
      startedAt: "2026-10-30T00:00:00.000Z",
      elapsedMs: 40,
    });
    expect(snapshot.waterfall.entries[2]).toMatchObject({
      id: "b1",
      method: "GET",
      status: 200,
      elapsedMs: 12,
    });
    expect(snapshot.waterfall.timed).toBe(true);
    expect(snapshot.counts.graphNodes).toBe(2);
    expect(snapshot.counts.transactions).toBe(3);
  });

  it("changes the digest when the graph changes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "xtna-visual-"));
    const evidencePath = join(directory, "bundle.json");
    await writeFile(evidencePath, JSON.stringify(visualBundle), "utf8");
    const first = snapshotDigest(
      await loadInvestigationState({ evidencePath }),
    );
    const extended = {
      ...visualBundle,
      records: [
        ...visualBundle.records,
        {
          operation: "trace_call_path",
          normalized_result: {
            nodes: [{ address: "0x401100", depth: 2 }],
            edges: [],
          },
        },
      ],
    };
    await writeFile(evidencePath, JSON.stringify(extended), "utf8");
    const second = snapshotDigest(
      await loadInvestigationState({ evidencePath }),
    );
    expect(second).not.toBe(first);
  });

  it("keeps the graph bounded and reports truncation", async () => {
    const records = [
      {
        operation: "trace_call_path",
        normalized_result: {
          nodes: Array.from({ length: 450 }, (_unused, index) => ({
            address: `0x${(0x400000 + index).toString(16)}`,
            depth: 0,
          })),
          edges: [],
        },
      },
    ];
    const directory = await mkdtemp(join(tmpdir(), "xtna-visual-"));
    const evidencePath = join(directory, "bundle.json");
    await writeFile(evidencePath, JSON.stringify({ records }), "utf8");
    const snapshot = await loadInvestigationState({ evidencePath });
    expect(snapshot.graph.nodes).toHaveLength(400);
    expect(snapshot.graph.truncated).toBe(true);
  });
});

const startPanel = async (
  evidencePath: string,
  extra: readonly string[],
): Promise<{ base: string; stop: () => Promise<void> }> => {
  const child = spawn(
    process.execPath,
    [
      "scripts/panel-serve.mjs",
      "--evidence",
      evidencePath,
      "--port",
      "0",
      ...extra,
    ],
    { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] },
  );
  const port = await new Promise<number>((resolvePort, reject) => {
    let buffered = "";
    const timer = setTimeout(
      () => reject(new Error("server did not start")),
      15_000,
    );
    child.stdout.on("data", (chunk: Buffer) => {
      buffered += chunk.toString("utf8");
      const line = buffered.split("\n")[0] ?? "";
      if (line.startsWith("{")) {
        clearTimeout(timer);
        resolvePort(JSON.parse(line).port as number);
      }
    });
    child.on("error", reject);
  });
  return {
    base: `http://127.0.0.1:${String(port)}`,
    stop: async () => {
      if (child.exitCode !== null) return;
      const exited = new Promise<void>((resolveExit) => {
        child.once("exit", () => resolveExit());
      });
      child.kill();
      await exited;
    },
  };
};

describe("panel annotations", () => {
  it("refuses notes when the channel is not configured", async () => {
    const { evidencePath } = await writeFixture();
    const panel = await startPanel(evidencePath, []);
    try {
      const listed = await fetch(`${panel.base}/api/annotations`);
      expect(listed.status).toBe(200);
      expect(await listed.json()).toEqual({
        enabled: false,
        annotations: [],
      });
      const posted = await fetch(`${panel.base}/api/annotations`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ target: "0x401000", note: "check" }),
      });
      expect(posted.status).toBe(403);
    } finally {
      await panel.stop();
    }
  }, 30_000);

  it("appends a bounded note and reads it back", async () => {
    const { evidencePath, directory } = await writeFixture();
    const notes = join(directory, "notes.jsonl");
    const panel = await startPanel(evidencePath, ["--annotations", notes]);
    try {
      const posted = await fetch(`${panel.base}/api/annotations`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          target: "0x401000",
          note: "rename to parseOrder",
        }),
      });
      expect(posted.status).toBe(201);
      const created = (await posted.json()) as { target: string; note: string };
      expect(created.target).toBe("0x401000");

      const listed = (await (
        await fetch(`${panel.base}/api/annotations`)
      ).json()) as { enabled: boolean; annotations: unknown[] };
      expect(listed.enabled).toBe(true);
      expect(listed.annotations).toHaveLength(1);

      const invalid = await fetch(`${panel.base}/api/annotations`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ target: "", note: "" }),
      });
      expect(invalid.status).toBe(400);

      const broken = await fetch(`${panel.base}/api/annotations`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{",
      });
      expect(broken.status).toBe(400);

      const stored = await readFile(notes, "utf8");
      expect(stored.trim().split("\n")).toHaveLength(1);
    } finally {
      await panel.stop();
    }
  }, 30_000);
});

describe("panel websocket", () => {
  it("accepts a note over the socket and broadcasts it", async () => {
    const { evidencePath, directory } = await writeFixture();
    const notes = join(directory, "ws-notes.jsonl");
    const panel = await startPanel(evidencePath, ["--annotations", notes]);
    try {
      const socket = new WebSocket(
        panel.base.replace("http://", "ws://") + "/ws",
      );
      const opened = new Promise<void>((resolve, reject) => {
        socket.addEventListener("open", () => resolve());
        socket.addEventListener("error", () =>
          reject(new Error("socket error")),
        );
        setTimeout(() => reject(new Error("socket timeout")), 10_000);
      });
      await opened;
      const message = new Promise<{ type: string; record: { target: string } }>(
        (resolve) => {
          socket.addEventListener("message", (event) => {
            const parsed = JSON.parse(String(event.data));
            if (parsed.type === "annotation") resolve(parsed);
          });
        },
      );
      socket.send(
        JSON.stringify({
          type: "annotation",
          target: "0x401000",
          note: "via ws",
        }),
      );
      const received = await message;
      expect(received.record.target).toBe("0x401000");
      const listed = (await (
        await fetch(`${panel.base}/api/annotations`)
      ).json()) as { annotations: unknown[] };
      expect(listed.annotations).toHaveLength(1);
      socket.close();
    } finally {
      await panel.stop();
    }
  }, 30_000);

  it("refuses a cross-origin upgrade", async () => {
    const { evidencePath } = await writeFixture();
    const panel = await startPanel(evidencePath, [
      "--annotations",
      join(tmpdir(), "x.jsonl"),
    ]);
    try {
      const url = new URL(panel.base);
      const status = await new Promise<number>((resolve, reject) => {
        const request = httpRequest(
          {
            host: url.hostname,
            port: Number(url.port),
            path: "/ws",
            headers: {
              connection: "Upgrade",
              upgrade: "websocket",
              "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
              "sec-websocket-version": "13",
              origin: "http://evil.test",
            },
          },
          (response) => {
            response.resume();
            resolve(response.statusCode ?? 0);
          },
        );
        request.on("error", reject);
        request.end();
      });
      expect(status).toBe(403);
    } finally {
      await panel.stop();
    }
  }, 30_000);
});
