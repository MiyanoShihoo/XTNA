#!/usr/bin/env node
/**
 * Live, read-only investigation panel.
 *
 * Serves one directory's evidence artefacts over loopback: an HTML page, a JSON
 * snapshot and a server-sent event stream that fires whenever a watched file
 * changes. Nothing is written and no path is served from disk.
 */
import { createServer } from "node:http";
import { watch } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const flag = (name) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};

const evidencePath = flag("evidence");
if (evidencePath === undefined) {
  process.stderr.write(
    "usage: node scripts/panel-serve.mjs --evidence <bundle.json> [--overlay file] [--hypotheses file] [--checkpoints dir] [--port 4321] [--host 127.0.0.1] [--title text]\n",
  );
  process.exit(2);
}

const port = Number(flag("port") ?? "4321");
const host = flag("host") ?? "127.0.0.1";

const { loadInvestigationState, snapshotDigest } = await import(
  pathToFileURL(resolve("dist/application/investigation/LivePanelState.js"))
    .href
);

const inputs = {
  evidencePath: resolve(evidencePath),
  ...(flag("overlay") === undefined
    ? {}
    : { overlayPath: resolve(flag("overlay")) }),
  ...(flag("hypotheses") === undefined
    ? {}
    : { hypothesesPath: resolve(flag("hypotheses")) }),
  ...(flag("checkpoints") === undefined
    ? {}
    : { checkpointsDir: resolve(flag("checkpoints")) }),
  ...(flag("title") === undefined ? {} : { title: flag("title") }),
};

const page = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>XTNA investigation panel</title>
<style>
  body { font: 14px/1.5 ui-monospace, monospace; margin: 2rem; color: #111; }
  h1 { font-size: 1.2rem; }
  table { border-collapse: collapse; margin: 0.5rem 0 1.5rem; }
  td, th { border-bottom: 1px solid #ddd; padding: 2px 12px 2px 0; text-align: left; }
  .muted { color: #666; }
</style></head>
<body>
<h1 id="title">XTNA investigation panel</h1>
<div class="muted" id="meta"></div>
<div id="body"></div>
<script>
const render = (s) => {
  document.title = s.title;
  document.getElementById("title").textContent = s.title;
  document.getElementById("meta").textContent =
    "generated " + s.generatedAt + " · records " + s.counts.records +
    " · limitations " + s.counts.limitations + " · symbols " + s.counts.symbols +
    " · hypotheses " + s.counts.hypotheses + " · checkpoints " + s.counts.checkpoints;
  const rows = (items, columns) =>
    "<table><tr>" + columns.map((c) => "<th>" + c + "</th>").join("") + "</tr>" +
    items.map((item) => "<tr>" + columns.map((c) => "<td>" + String(item[c] ?? "") + "</td>").join("") + "</tr>").join("") +
    "</table>";
  document.getElementById("body").innerHTML =
    "<h2>Limitations</h2>" + rows(s.limitations, ["operation", "text"]) +
    "<h2>Symbols</h2>" + rows(s.symbols, ["address", "name", "kind", "confidence"]) +
    "<h2>Hypotheses</h2>" + rows(s.hypotheses, ["id", "claim", "status", "confidence"]) +
    "<h2>Checkpoints</h2>" + rows(s.checkpoints, ["name", "bytes", "modifiedAt"]);
};
const refresh = async () => {
  try { render(await (await fetch("/api/state")).json()); } catch {}
};
refresh();
const events = new EventSource("/events");
events.addEventListener("refresh", refresh);
setInterval(refresh, 5000);
</script>
</body></html>`;

let lastDigest = "";
const clients = new Set();

const state = async () => loadInvestigationState(inputs);
const broadcast = async () => {
  const snapshot = await state();
  const digest = snapshotDigest(snapshot);
  if (digest === lastDigest) return;
  lastDigest = digest;
  for (const client of clients)
    client.write(`event: refresh\ndata: ${digest}\n\n`);
};

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://${host}`);
  try {
    if (request.method !== "GET") {
      response.writeHead(405, { allow: "GET" }).end();
      return;
    }
    if (url.pathname === "/") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(page);
      return;
    }
    if (url.pathname === "/api/state") {
      const snapshot = await state();
      lastDigest = snapshotDigest(snapshot);
      response.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
      });
      response.end(`${JSON.stringify(snapshot, null, 2)}\n`);
      return;
    }
    if (url.pathname === "/events") {
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-store",
        connection: "keep-alive",
      });
      response.write(`event: refresh\ndata: ${lastDigest}\n\n`);
      clients.add(response);
      request.on("close", () => clients.delete(response));
      return;
    }
    response
      .writeHead(404, { "content-type": "application/json" })
      .end(`${JSON.stringify({ error: "not found" })}\n`);
  } catch (error) {
    response
      .writeHead(500, { "content-type": "application/json" })
      .end(`${JSON.stringify({ error: String(error) })}\n`);
  }
});

const watched = [
  inputs.evidencePath,
  inputs.overlayPath,
  inputs.hypothesesPath,
].filter((path) => path !== undefined);
const watchers = [];
let timer;
for (const path of watched) {
  try {
    watchers.push(
      watch(path, { persistent: false }, () => {
        clearTimeout(timer);
        timer = setTimeout(() => void broadcast(), 150);
      }),
    );
  } catch {
    // A missing file is reported by /api/state; watching is best effort.
  }
}

server.listen(port, host, () => {
  const address = server.address();
  const actualPort =
    typeof address === "object" && address !== null ? address.port : port;
  process.stdout.write(`${JSON.stringify({ host, port: actualPort })}\n`);
});

const close = () => {
  for (const client of clients) client.end();
  clients.clear();
  for (const watcher of watchers) watcher.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000).unref();
};
process.on("SIGINT", close);
process.on("SIGTERM", close);
