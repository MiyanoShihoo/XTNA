#!/usr/bin/env node
/**
 * Build a single-file, offline investigation panel from stored artefacts.
 *
 * Everything is embedded: no network requests, no external scripts, no fonts.
 * The page is a read-only projection of the files you pass.
 */
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  const value = index >= 0 ? args[index + 1] : undefined;
  return value === undefined ? fallback : value;
};

const evidencePath = flag("evidence");
if (evidencePath === undefined) {
  process.stderr.write(
    "usage: node scripts/panel.mjs --evidence bundle.json [--overlay <binary|sha>] [--hypotheses file] [--checkpoints dir] [--out panel.html] [--title text]\n",
  );
  process.exit(2);
}

const title = flag("title", "XTNA investigation panel");
const outPath = resolve(flag("out", "panel.html"));
const bundle = JSON.parse(
  (await readFile(resolve(evidencePath), "utf8")).replace(/^\uFEFF/u, ""),
);

const artifacts = Array.isArray(bundle.artifacts) ? bundle.artifacts : [];
const records = Array.isArray(bundle.records) ? bundle.records : [];
const unknowns = Array.isArray(bundle.unknowns) ? bundle.unknowns : [];
const providers = Array.isArray(bundle.providers) ? bundle.providers : [];

const limitations = [];
for (const record of records)
  for (const limitation of record.limitations ?? [])
    limitations.push({
      operation: record.operation ?? "record",
      text: limitation,
    });

let overlay = null;
const overlayBinary = flag("overlay");
if (overlayBinary !== undefined) {
  const digest = /^[0-9a-f]{64}$/u.test(overlayBinary)
    ? overlayBinary
    : createHash("sha256")
        .update(await readFile(resolve(overlayBinary)))
        .digest("hex");
  const dir = resolve(
    process.env.XTNA_OVERLAY_DIR ?? join(homedir(), ".xtna", "overlays"),
  );
  const raw = await readFile(join(dir, `${digest}.json`), "utf8").catch(
    () => null,
  );
  if (raw !== null) overlay = JSON.parse(raw);
}

let hypotheses = null;
const hypothesisPath = flag("hypotheses");
if (hypothesisPath !== undefined) {
  const raw = await readFile(resolve(hypothesisPath), "utf8").catch(() => null);
  if (raw !== null) hypotheses = JSON.parse(raw);
}

let checkpoints = null;
const checkpointDir = flag("checkpoints");
if (checkpointDir !== undefined) {
  const dir = resolve(checkpointDir);
  const { readdir } = await import("node:fs/promises");
  const entries = await readdir(dir).catch(() => []);
  checkpoints = [];
  for (const entry of entries) {
    const raw = await readFile(join(dir, entry, "manifest.json"), "utf8").catch(
      () => null,
    );
    if (raw === null) continue;
    const manifest = JSON.parse(raw);
    checkpoints.push({
      id: manifest.id,
      name: manifest.name,
      created_at: manifest.created_at,
      evidence: manifest.files?.length ?? 0,
      overlays: manifest.overlays?.length ?? 0,
    });
  }
}

const data = {
  title,
  generated_at: new Date().toISOString(),
  artifacts,
  records: records.map((record) => ({
    operation: record.operation ?? "",
    provider: record.provider?.id ?? "",
    authority: record.authority ?? "",
    confidence: record.confidence ?? "",
    limitations: (record.limitations ?? []).length,
    evidence_id: record.evidence_id ?? "",
  })),
  limitations,
  unknowns,
  providers,
  overlay: overlay?.entries ?? null,
  hypotheses: hypotheses?.items ?? null,
  checkpoints,
};

const escapeHtml = (value) =>
  String(value).replace(
    /[&<>"']/gu,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ],
  );

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: dark; --bg:#0b0e14; --panel:#121722; --line:#222b3a; --ink:#dce3ef; --dim:#8b97aa; --amber:#ffc24a; --mint:#3dff9e; --red:#ff6b6b; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--ink); font:14px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
  header { padding:28px 32px 18px; border-bottom:1px solid var(--line); }
  h1 { margin:0 0 6px; font-size:22px; letter-spacing:.2px; }
  .meta { color:var(--dim); font-size:12px; }
  nav { display:flex; gap:4px; padding:0 32px; border-bottom:1px solid var(--line); flex-wrap:wrap; }
  nav button { background:none; border:none; color:var(--dim); padding:12px 14px; cursor:pointer; font:inherit; border-bottom:2px solid transparent; }
  nav button[aria-selected="true"] { color:var(--amber); border-bottom-color:var(--amber); }
  main { padding:24px 32px 64px; }
  section[hidden] { display:none; }
  h2 { font-size:15px; margin:0 0 12px; color:var(--amber); font-weight:600; }
  table { width:100%; border-collapse:collapse; font-size:13px; }
  th, td { text-align:left; padding:8px 10px; border-bottom:1px solid var(--line); vertical-align:top; }
  th { color:var(--dim); font-weight:500; }
  code, .mono { font-family: ui-monospace, "Cascadia Code", Consolas, monospace; font-size:12px; }
  .pill { display:inline-block; padding:1px 8px; border-radius:999px; border:1px solid var(--line); color:var(--dim); font-size:11px; }
  .num { text-align:right; }
  input[type=search] { width:100%; max-width:420px; margin:0 0 12px; padding:8px 10px; background:var(--panel); border:1px solid var(--line); color:var(--ink); border-radius:6px; }
  .empty { color:var(--dim); padding:12px 0; }
  .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(180px,1fr)); gap:12px; margin-bottom:18px; }
  .card { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:14px 16px; }
  .card .k { color:var(--dim); font-size:11px; text-transform:uppercase; letter-spacing:.08em; }
  .card .v { font-size:20px; margin-top:4px; }
  .status-contradicted, .status-refuted { color:var(--red); }
  .status-supported { color:var(--mint); }
  .status-open { color:var(--dim); }
</style>
</head>
<body>
<header>
  <h1>${escapeHtml(title)}</h1>
  <div class="meta">generated ${escapeHtml(data.generated_at)} · evidence bundle <code>${escapeHtml(evidencePath)}</code></div>
</header>
<nav id="tabs"></nav>
<main id="views"></main>
<script>
const DATA = ${JSON.stringify(data)};
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
const tabs = [
  ["overview", "Overview", renderOverview],
  ["records", "Evidence", renderRecords],
  ["limitations", "Limitations", renderLimitations],
  ["unknowns", "Unknowns", renderUnknowns],
];
if (DATA.overlay) tabs.push(["symbols", "Symbols", renderSymbols]);
if (DATA.hypotheses) tabs.push(["hypotheses", "Hypotheses", renderHypotheses]);
if (DATA.checkpoints) tabs.push(["checkpoints", "Checkpoints", renderCheckpoints]);

const nav = document.getElementById("tabs");
const views = document.getElementById("views");
tabs.forEach(([id, label, render], index) => {
  const button = document.createElement("button");
  button.textContent = label;
  button.setAttribute("role", "tab");
  button.setAttribute("aria-selected", index === 0 ? "true" : "false");
  button.onclick = () => select(id);
  nav.appendChild(button);
  const section = document.createElement("section");
  section.id = "view-" + id;
  section.hidden = index !== 0;
  views.appendChild(section);
  render(section);
});

function select(id) {
  for (const button of nav.children) button.setAttribute("aria-selected", button.textContent === tabs.find(([key]) => key === id)[1] ? "true" : "false");
  for (const [key] of tabs) document.getElementById("view-" + key).hidden = key !== id;
}

function table(headers, rows) {
  if (rows.length === 0) return '<div class="empty">nothing recorded</div>';
  return "<table><thead><tr>" + headers.map((h) => "<th>" + esc(h) + "</th>").join("") + "</tr></thead><tbody>" +
    rows.map((row) => "<tr>" + row.map((cell) => "<td>" + cell + "</td>").join("") + "</tr>").join("") + "</tbody></table>";
}

function renderOverview(root) {
  const cards = [
    ["artifacts", DATA.artifacts.length],
    ["evidence records", DATA.records.length],
    ["limitations", DATA.limitations.length],
    ["unknowns", DATA.unknowns.length],
    ["providers", DATA.providers.length],
  ];
  if (DATA.overlay) cards.push(["symbols", DATA.overlay.length]);
  if (DATA.hypotheses) cards.push(["hypotheses", DATA.hypotheses.length]);
  root.innerHTML = '<h2>Overview</h2><div class="grid">' + cards.map(([k, v]) => '<div class="card"><div class="k">' + esc(k) + '</div><div class="v">' + esc(v) + "</div></div>").join("") + "</div>" +
    '<h2>Targets</h2>' + table(["Format", "Architecture", "SHA-256"], DATA.artifacts.map((a) => [esc(a.format ?? "—"), esc(a.architecture ?? "—"), '<code>' + esc(a.digest?.sha256 ?? "—") + "</code>"]));
}

function renderRecords(root) {
  root.innerHTML = '<h2>Evidence records</h2><input type="search" placeholder="filter by operation, provider or id" id="record-filter">' +
    '<div id="record-table"></div>';
  const draw = (query) => {
    const q = query.trim().toLowerCase();
    const rows = DATA.records.filter((r) => !q || [r.operation, r.provider, r.evidence_id, r.authority].join(" ").toLowerCase().includes(q))
      .map((r) => [esc(r.operation), esc(r.provider), esc(r.authority), esc(r.confidence), '<span class="num">' + esc(r.limitations) + "</span>", '<code>' + esc(r.evidence_id.slice(0, 24)) + "…</code>"]);
    document.getElementById("record-table").innerHTML = table(["Operation", "Provider", "Authority", "Confidence", "Limits", "Evidence"], rows);
  };
  draw("");
  document.getElementById("record-filter").oninput = (event) => draw(event.target.value);
}

function renderLimitations(root) {
  root.innerHTML = '<h2>Limitations</h2>' + (DATA.limitations.length === 0 ? '<div class="empty">none recorded</div>' :
    "<ul>" + [...new Set(DATA.limitations.map((l) => l.text))].map((text) => "<li>" + esc(text) + "</li>").join("") + "</ul>");
}

function renderUnknowns(root) {
  root.innerHTML = '<h2>Unknowns</h2>' + table(["Domain", "Severity", "Status", "Question"], DATA.unknowns.map((u) => [esc(u.domain ?? "—"), esc(u.severity ?? "—"), esc(u.status ?? "—"), esc(u.question ?? "")]));
}

function renderSymbols(root) {
  root.innerHTML = '<h2>Symbol overlay</h2>' + table(["Address", "Kind", "Confidence", "Name", "Type"], DATA.overlay.map((s) => ["<code>" + esc(s.address_hex) + "</code>", esc(s.kind), esc(s.confidence), "<code>" + esc(s.name) + "</code>", esc(s.type ?? "—")]));
}

function renderHypotheses(root) {
  root.innerHTML = '<h2>Hypotheses</h2>' + table(["Statement", "Confidence", "Status", "Supporting", "Contradicting"], DATA.hypotheses.map((h) => [esc(h.statement), esc(h.confidence), '<span class="status-' + esc(h.status) + '">' + esc(h.status) + "</span>", esc((h.evidence_ids ?? []).length), esc((h.contradictions ?? []).length)]));
}

function renderCheckpoints(root) {
  root.innerHTML = '<h2>Checkpoints</h2>' + table(["ID", "Name", "Created", "Evidence", "Overlays"], DATA.checkpoints.map((c) => ["<code>" + esc(c.id) + "</code>", esc(c.name), esc(c.created_at), esc(c.evidence), esc(c.overlays)]));
}
</script>
</body>
</html>
`;

await writeFile(outPath, html, "utf8");
process.stderr.write(
  `panel written to ${outPath} (${String((html.length / 1024).toFixed(0))} KiB)\n`,
);
