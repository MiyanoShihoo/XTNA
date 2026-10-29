import { spawn } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
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
