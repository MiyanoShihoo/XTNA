import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { expect, it } from "vitest";

const run = promisify(execFile);
const script = fileURLToPath(
  new URL("../../scripts/dossier.mjs", import.meta.url),
);
const bundle = {
  artifacts: [
    {
      format: "pe",
      architecture: "x86-64",
      digest: { sha256: "a".repeat(64) },
    },
  ],
  records: [
    {
      operation: "inspect_artifact",
      provider: { id: "ghidra", version: "12.2" },
      authority: "observed",
      confidence: "observed",
      limitations: ["symbols are unavailable"],
      evidence_id: "ev_0123456789abcdef",
    },
  ],
  providers: [{ id: "ghidra", version: "12.2" }],
  unknowns: [
    {
      domain: "native",
      severity: "medium",
      status: "open",
      question: "Which caller reaches this function?",
    },
  ],
};

it("emits Mermaid architecture and an HTML dossier", async () => {
  const root = await mkdtemp(join(tmpdir(), "rea-dossier-cli-"));
  const evidence = join(root, "bundle.json");
  const markdown = join(root, "report.md");
  const html = join(root, "report.html");
  await writeFile(evidence, JSON.stringify(bundle));
  try {
    await run(
      process.execPath,
      [
        script,
        "--evidence",
        evidence,
        "--format",
        "markdown",
        "--out",
        markdown,
      ],
      { env: process.env },
    );
    const md = await readFile(markdown, "utf8");
    expect(md).toContain("## Architecture");
    expect(md).toContain("```mermaid");
    expect(md).toContain("flowchart LR");
    expect(md).toContain("## Module responsibility matrix");
    expect(md).toContain("| ghidra | inspect_artifact | 1 |");

    await run(
      process.execPath,
      [script, "--evidence", evidence, "--format", "html", "--out", html],
      { env: process.env },
    );
    const rendered = await readFile(html, "utf8");
    expect(rendered).toContain("<!doctype html>");
    expect(rendered).toContain('<pre class="mermaid">');
    expect(rendered).toContain("<table>");
    expect(rendered).toContain("ghidra");
  } finally {
    await rm(root, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 20,
    });
  }
});
