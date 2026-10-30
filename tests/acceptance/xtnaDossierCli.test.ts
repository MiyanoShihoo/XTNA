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
      recommended_probes: [
        { operation: "trace_call_path", rationale: "walk callers" },
      ],
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
    expect(md).toContain("## Interaction sequence");
    expect(md).toContain("sequenceDiagram");
    expect(md).toContain("participant A as Agent");
    expect(md).toContain("A->>P: inspect_artifact");

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

it("renders the interface dictionary, remediation and a text PDF", async () => {
  const root = await mkdtemp(join(tmpdir(), "rea-dossier-pdf-"));
  const evidence = join(root, "bundle.json");
  const spec = join(root, "openapi.json");
  const markdown = join(root, "report.md");
  const pdf = join(root, "report.pdf");
  await writeFile(evidence, JSON.stringify(bundle));
  await writeFile(
    spec,
    JSON.stringify({
      paths: {
        "/users/{id}": {
          get: {
            operationId: "getUser",
            parameters: [{ name: "id" }],
            responses: { "200": {}, "404": {} },
          },
        },
      },
    }),
  );
  try {
    await run(
      process.execPath,
      [
        script,
        "--evidence",
        evidence,
        "--api-spec",
        spec,
        "--format",
        "markdown",
        "--out",
        markdown,
      ],
      { env: process.env },
    );
    const md = await readFile(markdown, "utf8");
    expect(md).toContain("## Interface dictionary");
    expect(md).toContain("| GET | `/users/{id}` | getUser |");
    expect(md).toContain("## Remediation suggestions");
    expect(md).toContain("trace_call_path");

    await run(
      process.execPath,
      [script, "--evidence", evidence, "--format", "pdf", "--out", pdf],
      { env: process.env },
    );
    const rendered = await readFile(pdf);
    expect(rendered.subarray(0, 8).toString("latin1")).toBe("%PDF-1.4");
    const text = rendered.toString("latin1");
    expect(text).toContain("/Type /Page");
    expect(text).toContain("%%EOF");
  } finally {
    await rm(root, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 20,
    });
  }
});
