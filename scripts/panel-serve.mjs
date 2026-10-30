#!/usr/bin/env node
/**
 * Live investigation panel.
 *
 * Serves one directory's evidence artefacts over loopback: an HTML page with a
 * call topology graph and a network waterfall, a JSON snapshot, a server-sent
 * event stream that fires whenever a watched file changes, and — only when
 * `--annotations <file>` is given — a bounded append-only note channel that
 * lets a human mark a node for the agent to read back.
 */
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { watch } from "node:fs";
import { appendFile, readFile, stat } from "node:fs/promises";
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
    "usage: node scripts/panel-serve.mjs --evidence <bundle.json> [--overlay file] [--hypotheses file] [--checkpoints dir] [--annotations notes.jsonl] [--mcp-url http://127.0.0.1:8765/mcp --query-token <token>] [--query-tools tool,tool] [--query-log queries.jsonl] [--port 4321] [--host 127.0.0.1] [--title text]\n",
  );
  process.exit(2);
}

const port = Number(flag("port") ?? "4321");
const host = flag("host") ?? "127.0.0.1";
const annotationsPath =
  flag("annotations") === undefined ? undefined : resolve(flag("annotations"));
const mcpUrl = flag("mcp-url");
const queryToken = flag("query-token");
const queryLogPath =
  flag("query-log") === undefined ? undefined : resolve(flag("query-log"));
const requestedTools = flag("query-tools");

if ((mcpUrl === undefined) !== (queryToken === undefined)) {
  process.stderr.write(
    "--mcp-url and --query-token must be given together; the query relay fails closed\n",
  );
  process.exit(2);
}

const { DEFAULT_READ_ONLY_TOOLS, validatePanelQuery } = await import(
  new URL("./lib/panel-query-policy.mjs", import.meta.url).href
);
const { createMcpHttpClient } = await import(
  new URL("./lib/mcp-http-client.mjs", import.meta.url).href
);

const allowedTools =
  requestedTools === undefined
    ? DEFAULT_READ_ONLY_TOOLS
    : requestedTools
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
const queryClient =
  mcpUrl === undefined ? undefined : createMcpHttpClient({ url: mcpUrl });
if (queryClient !== undefined) {
  try {
    await queryClient.initialize();
    process.stderr.write(
      `query relay: read-only tools via ${queryClient.endpoint}\n`,
    );
  } catch (error) {
    process.stderr.write(
      `query relay: cannot reach ${mcpUrl} (${String(error)}); refusing to start\n`,
    );
    process.exit(2);
  }
}

const MAX_NOTE_CHARS = 4_000;
const MAX_TARGET_CHARS = 512;
const MAX_BODY_BYTES = 64 * 1024;
const MAX_ANNOTATION_FILE_BYTES = 5 * 1024 * 1024;
const MAX_ANNOTATIONS_RETURNED = 200;

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
  h2 { font-size: 1rem; margin-top: 2rem; }
  table { border-collapse: collapse; margin: 0.5rem 0 1.5rem; }
  td, th { border-bottom: 1px solid #ddd; padding: 2px 12px 2px 0; text-align: left; vertical-align: top; }
  .muted { color: #666; }
  #graph { border: 1px solid #ddd; overflow: auto; max-height: 60vh; }
  #graph circle { cursor: pointer; }
  #graph circle.selected { stroke: #111; stroke-width: 3; }
  #waterfall { margin: 0.5rem 0 1.5rem; }
  .wf-row { display: grid; grid-template-columns: 18rem 1fr 4rem; gap: 8px; align-items: center; }
  .wf-track { background: #f2f2f2; height: 12px; position: relative; }
  .wf-bar { background: #4a6fa5; height: 12px; position: absolute; }
  .wf-bar.error { background: #a54a4a; }
  #note { width: 32rem; height: 4rem; }
  .card { border: 1px solid #ddd; border-radius: 6px; padding: .6rem .8rem; margin: .5rem 0; }
  .card .op { font-weight: 600; }
  .card .meta { color: #666; font-size: 12px; }
  .hidden { display: none; }
  #query-result { max-height: 20rem; overflow: auto; background: #f7f7f7; padding: .5rem; }
</style></head>
<body>
<h1 id="title">XTNA investigation panel</h1>
<div class="muted" id="meta"></div>
<div id="body"></div>
<h2>Evidence cards</h2>
<div class="muted" id="cards-meta"></div>
<div id="cards"></div>
<h2>Topology</h2>
<div class="muted" id="graph-meta"></div>
<div id="graph"></div>
<div id="selection" class="hidden">
  <div class="muted">Selected: <span id="sel"></span></div>
  <textarea id="note" maxlength="4000" placeholder="Note for the agent (target = selected node)"></textarea>
  <button id="save">Save note</button>
  <span class="muted" id="save-status"></span>
  <div id="query" class="hidden">
    <div class="muted">Read-only provider query (relayed to the MCP server; never executes here)</div>
    <select id="query-tool"></select>
    <select id="query-key">
      <option value="procedure">procedure</option>
      <option value="address">address</option>
      <option value="name">name</option>
      <option value="pattern">pattern</option>
    </select>
    <input id="query-arg" placeholder="address or symbol" size="26">
    <input id="query-token" type="password" placeholder="query token" size="18">
    <button id="run-query">Query</button>
    <span class="muted" id="query-status"></span>
    <pre id="query-result"></pre>
  </div>
</div>
<h2>Network waterfall</h2>
<div class="muted" id="wf-meta"></div>
<div id="waterfall"></div>
<h2>Annotations</h2>
<div id="annotations" class="muted"></div>
<script>
const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (ch) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
}[ch]));

const renderTable = (items, columns) =>
  "<table><tr>" + columns.map((c) => "<th>" + esc(c) + "</th>").join("") + "</tr>" +
  items.map((item) => "<tr>" + columns.map((c) => "<td>" + esc(item[c]) + "</td>").join("") + "</tr>").join("") +
  "</table>";

let selected = null;

const renderGraph = (graph) => {
  const svg = document.getElementById("graph");
  document.getElementById("graph-meta").textContent =
    "nodes " + graph.nodes.length + " · edges " + graph.edges.length +
    (graph.truncated ? " · truncated" : "");
  if (graph.nodes.length === 0) {
    svg.textContent = "No call graph records in this bundle.";
    document.getElementById("selection").classList.add("hidden");
    return;
  }
  const columns = new Map();
  for (const node of graph.nodes) {
    const key = node.depth === null ? "unknown" : String(node.depth);
    if (!columns.has(key)) columns.set(key, []);
    columns.get(key).push(node);
  }
  const keys = [...columns.keys()];
  const positions = new Map();
  let width = 0;
  keys.forEach((key, columnIndex) => {
    for (const [rowIndex, node] of (columns.get(key) ?? []).entries()) {
      positions.set(node.id, { x: 90 + columnIndex * 190, y: 40 + rowIndex * 46 });
    }
    width = Math.max(width, 90 + columnIndex * 190 + 120);
  });
  const height = Math.max(...[...columns.values()].map((nodes) => nodes.length)) * 46 + 60;
  const parts = [];
  parts.push('<svg xmlns="http://www.w3.org/2000/svg" width="' + width + '" height="' + height + '">');
  for (const edge of graph.edges) {
    const from = positions.get(edge.source);
    const to = positions.get(edge.target);
    if (!from || !to) continue;
    parts.push('<line x1="' + from.x + '" y1="' + from.y + '" x2="' + to.x + '" y2="' + to.y + '" stroke="#bbb" />');
  }
  for (const node of graph.nodes) {
    const position = positions.get(node.id);
    parts.push('<circle data-id="' + esc(node.id) + '" cx="' + position.x + '" cy="' + position.y + '" r="7" fill="#4a6fa5" />');
    parts.push('<text x="' + (position.x + 12) + '" y="' + (position.y + 4) + '" font-size="12">' + esc(node.label) + "</text>");
  }
  parts.push("</svg>");
  svg.innerHTML = parts.join("");
  for (const circle of svg.querySelectorAll("circle")) {
    circle.addEventListener("click", () => {
      for (const other of svg.querySelectorAll("circle")) other.classList.remove("selected");
      circle.classList.add("selected");
      selected = circle.getAttribute("data-id");
      document.getElementById("selection").classList.remove("hidden");
      document.getElementById("sel").textContent = selected;
    });
  }
};

const renderWaterfall = (waterfall) => {
  const host = document.getElementById("waterfall");
  document.getElementById("wf-meta").textContent =
    "transactions " + waterfall.entries.length +
    (waterfall.timed ? "" : " · no timings recorded, order only") +
    (waterfall.truncated ? " · truncated" : "");
  if (waterfall.entries.length === 0) {
    host.textContent = "No network transactions in this bundle.";
    return;
  }
  const starts = waterfall.entries
    .map((entry) => (entry.startedAt === null ? null : Date.parse(entry.startedAt)))
    .filter((value) => value !== null && Number.isFinite(value));
  const origin = starts.length > 0 ? Math.min(...starts) : 0;
  const spans = waterfall.entries.map((entry) => {
    const parsed = entry.startedAt === null ? Number.NaN : Date.parse(entry.startedAt);
    const start = Number.isFinite(parsed) ? parsed : null;
    return {
      entry,
      offset: start === null ? 0 : Math.max(0, start - origin),
      duration: entry.elapsedMs === null ? 10 : Math.max(1, entry.elapsedMs),
    };
  });
  const total = Math.max(...spans.map((span) => span.offset + span.duration), 1);
  host.innerHTML = spans.map((span) => {
    const left = (span.offset / total) * 100;
    const width = Math.max(0.5, (span.duration / total) * 100);
    const failed = span.entry.status !== null && span.entry.status >= 400;
    return '<div class="wf-row"><div>' + esc(span.entry.method + " " + span.entry.url) + "</div>" +
      '<div class="wf-track"><div class="wf-bar' + (failed ? " error" : "") + '" style="left:' + left + "%;width:" + width + '%"></div></div>' +
      "<div>" + esc(span.entry.status === null ? "-" : span.entry.status) + "</div></div>";
  }).join("");
};

const renderCards = (records, truncated) => {
  const host = document.getElementById("cards");
  document.getElementById("cards-meta").textContent =
    "records " + records.length + (truncated ? " (truncated at 200)" : "");
  if (records.length === 0) {
    host.textContent = "No evidence records in this bundle.";
    return;
  }
  host.innerHTML = records.map((record) =>
    '<div class="card"><div class="op">' + esc(record.operation) + "</div>" +
    '<div class="meta">' + esc(record.provider) + " · authority " + esc(record.authority) +
    " · confidence " + esc(record.confidence) + " · limitations " + esc(record.limitations) + "</div>" +
    '<div class="meta">' + esc(record.id) + "</div></div>"
  ).join("");
};

const renderAnnotations = (payload) => {
  const host = document.getElementById("annotations");
  if (!payload.enabled) {
    host.textContent = "Annotations are disabled. Restart with --annotations notes.jsonl.";
    document.getElementById("selection").classList.add("hidden");
    return;
  }
  host.innerHTML = payload.annotations.length === 0
    ? "No notes yet."
    : payload.annotations.map((item) => '<div>' + esc(item.created_at) + " · " + esc(item.target) + " · " + esc(item.note) + "</div>").join("");
};

const render = (s) => {
  document.title = s.title;
  document.getElementById("title").textContent = s.title;
  document.getElementById("meta").textContent =
    "generated " + s.generatedAt + " · records " + s.counts.records +
    " · limitations " + s.counts.limitations + " · symbols " + s.counts.symbols +
    " · hypotheses " + s.counts.hypotheses + " · checkpoints " + s.counts.checkpoints;
  document.getElementById("body").innerHTML =
    "<h2>Limitations</h2>" + renderTable(s.limitations, ["operation", "text"]) +
    "<h2>Symbols</h2>" + renderTable(s.symbols, ["address", "name", "kind", "confidence"]) +
    "<h2>Hypotheses</h2>" + renderTable(s.hypotheses, ["id", "claim", "status", "confidence"]) +
    "<h2>Checkpoints</h2>" + renderTable(s.checkpoints, ["name", "bytes", "modifiedAt"]);
  renderCards(s.records ?? [], s.recordsTruncated === true);
  renderGraph(s.graph);
  renderWaterfall(s.waterfall);
};

const refresh = async () => {
  try { render(await (await fetch("/api/state")).json()); } catch {}
};
const refreshAnnotations = async () => {
  try { renderAnnotations(await (await fetch("/api/annotations")).json()); } catch {}
};
let socket = null;
const connectSocket = () => {
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  socket = new WebSocket(scheme + "://" + location.host + "/ws");
  socket.addEventListener("message", (event) => {
    try {
      const message = JSON.parse(event.data);
      if (message.type === "annotation") refreshAnnotations();
      if (message.type === "error")
        document.getElementById("save-status").textContent = "rejected: " + message.message;
    } catch {}
  });
  socket.addEventListener("close", () => {
    socket = null;
    setTimeout(connectSocket, 2000);
  });
};
connectSocket();

document.getElementById("save").addEventListener("click", async () => {
  if (selected === null) return;
  const note = document.getElementById("note").value;
  const status = document.getElementById("save-status");
  if (socket !== null && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: "annotation", target: selected, note }));
    status.textContent = "sent";
    document.getElementById("note").value = "";
    return;
  }
  const response = await fetch("/api/annotations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ target: selected, note }),
  });
  status.textContent = response.ok ? "saved" : "rejected (" + response.status + ")";
  if (response.ok) {
    document.getElementById("note").value = "";
    refreshAnnotations();
  }
});
const queryBox = document.getElementById("query");
const queryTool = document.getElementById("query-tool");
const queryStatus = document.getElementById("query-status");
const loadQuery = async () => {
  let info = { enabled: false };
  try { info = await (await fetch("/api/query")).json(); } catch {}
  if (!info.enabled) return;
  queryBox.classList.remove("hidden");
  queryTool.innerHTML = info.tools
    .map((tool) => '<option value="' + esc(tool) + '">' + esc(tool) + "</option>")
    .join("");
};
document.getElementById("run-query").addEventListener("click", async () => {
  const token = document.getElementById("query-token").value;
  const tool = queryTool.value;
  const key = document.getElementById("query-key").value;
  const raw = document.getElementById("query-arg").value.trim();
  const status = queryStatus;
  status.textContent = "running…";
  document.getElementById("query-result").textContent = "";
  const args = {};
  if (raw.length > 0) args[key] = raw;
  try {
    const response = await fetch("/api/query", {
      method: "POST",
      headers: { "content-type": "application/json", "x-xtna-token": token },
      body: JSON.stringify({ tool, args }),
    });
    const payload = await response.json();
    status.textContent = response.ok ? "ok" : "rejected (" + response.status + ")";
    document.getElementById("query-result").textContent = JSON.stringify(
      response.ok ? payload.result : payload.error,
      null,
      2,
    );
  } catch (error) {
    status.textContent = "failed: " + String(error);
  }
});
refresh();
refreshAnnotations();
loadQuery();
const events = new EventSource("/events");
events.addEventListener("refresh", refresh);
setInterval(refresh, 5000);
</script>
</body></html>`;

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const MAX_WS_CLIENTS = 8;
const MAX_WS_MESSAGE_BYTES = 16 * 1024;
const wsClients = new Set();
let listeningPort = 0;

const encodeFrame = (payload, opcode = 0x1) => {
  const body = Buffer.from(payload, "utf8");
  const length = body.length;
  if (length < 126)
    return Buffer.concat([Buffer.from([0x80 | opcode, length]), body]);
  if (length < 65536) {
    const header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
    return Buffer.concat([header, body]);
  }
  const header = Buffer.alloc(10);
  header[0] = 0x80 | opcode;
  header[1] = 127;
  header.writeBigUInt64BE(BigInt(length), 2);
  return Buffer.concat([header, body]);
};

const broadcastJson = (value) => {
  const frame = encodeFrame(JSON.stringify(value));
  for (const client of wsClients) {
    try {
      client.write(frame);
    } catch {
      wsClients.delete(client);
    }
  }
};

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

const readAnnotations = async () => {
  if (annotationsPath === undefined) return [];
  const text = await readFile(annotationsPath, "utf8").catch(() => "");
  const lines = text.split("\n").filter((line) => line.trim().length > 0);
  return lines.slice(-MAX_ANNOTATIONS_RETURNED).flatMap((line) => {
    try {
      const parsed = JSON.parse(line);
      return parsed !== null && typeof parsed === "object" ? [parsed] : [];
    } catch {
      return [];
    }
  });
};

const body = (request) =>
  new Promise((resolveBody, rejectBody) => {
    let raw = "";
    request.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > MAX_BODY_BYTES) {
        rejectBody(Object.assign(new Error("body too large"), { status: 413 }));
        request.destroy();
      }
    });
    request.on("end", () => {
      try {
        resolveBody(raw === "" ? undefined : JSON.parse(raw));
      } catch {
        rejectBody(Object.assign(new Error("invalid JSON"), { status: 400 }));
      }
    });
    request.on("error", rejectBody);
  });

const rejectStatus = (status, message) =>
  Object.assign(new Error(message), { status });

const tokenMatches = (request) => {
  if (queryToken === undefined) return false;
  const supplied = request.headers["x-xtna-token"];
  if (typeof supplied !== "string" || supplied.length !== queryToken.length)
    return false;
  let difference = 0;
  for (let index = 0; index < supplied.length; index += 1)
    difference |= supplied.charCodeAt(index) ^ queryToken.charCodeAt(index);
  return difference === 0;
};

/** A browser Origin must be this panel's own loopback origin. */
const requireSameOrigin = (request) => {
  const origin = request.headers.origin;
  if (origin === undefined) return;
  let allowed = false;
  try {
    const parsed = new URL(origin);
    allowed =
      ["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname) &&
      Number(parsed.port === "" ? 80 : parsed.port) === listeningPort;
  } catch {
    allowed = false;
  }
  if (!allowed) throw rejectStatus(403, "cross-origin query refused");
};

const QUERY_WINDOW_MS = 60_000;
const MAX_QUERIES_PER_WINDOW = 20;
const queryTimes = [];
let queryInFlight = false;

const admitQuery = () => {
  if (queryInFlight) throw rejectStatus(429, "a query is already running");
  const now = Date.now();
  while (queryTimes.length > 0 && now - queryTimes[0] > QUERY_WINDOW_MS)
    queryTimes.shift();
  if (queryTimes.length >= MAX_QUERIES_PER_WINDOW)
    throw rejectStatus(429, "query rate limit reached");
  queryTimes.push(now);
  queryInFlight = true;
};

const logQuery = async (record) => {
  if (queryLogPath === undefined) return;
  const size = await stat(queryLogPath).then(
    (info) => info.size,
    () => 0,
  );
  if (size > MAX_ANNOTATION_FILE_BYTES) return;
  await appendFile(queryLogPath, `${JSON.stringify(record)}\n`, "utf8").catch(
    () => {},
  );
};

const appendAnnotation = async (payload) => {
  if (annotationsPath === undefined)
    throw Object.assign(new Error("annotations disabled"), { status: 403 });
  if (payload === undefined || typeof payload !== "object")
    throw Object.assign(new Error("invalid annotation"), { status: 400 });
  const target =
    typeof payload.target === "string" ? payload.target.trim() : "";
  const note = typeof payload.note === "string" ? payload.note.trim() : "";
  if (target.length === 0 || target.length > MAX_TARGET_CHARS)
    throw Object.assign(new Error("invalid target"), { status: 400 });
  if (note.length === 0 || note.length > MAX_NOTE_CHARS)
    throw Object.assign(new Error("invalid note"), { status: 400 });
  const size = await stat(annotationsPath).then(
    (info) => info.size,
    () => 0,
  );
  if (size > MAX_ANNOTATION_FILE_BYTES)
    throw Object.assign(new Error("annotation file full"), { status: 413 });
  const record = { created_at: new Date().toISOString(), target, note };
  await appendFile(annotationsPath, `${JSON.stringify(record)}\n`, "utf8");
  return record;
};

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://${host}`);
  try {
    if (url.pathname === "/api/annotations") {
      if (request.method === "GET") {
        const annotations = await readAnnotations();
        response.writeHead(200, {
          "content-type": "application/json; charset=utf-8",
        });
        response.end(
          `${JSON.stringify({ enabled: annotationsPath !== undefined, annotations })}\n`,
        );
        return;
      }
      if (request.method === "POST") {
        const record = await appendAnnotation(await body(request));
        response.writeHead(201, {
          "content-type": "application/json; charset=utf-8",
        });
        response.end(`${JSON.stringify(record)}\n`);
        broadcastJson({ type: "annotation", record });
        void broadcast();
        return;
      }
      response.writeHead(405, { allow: "GET, POST" }).end();
      return;
    }
    if (url.pathname === "/api/query") {
      if (queryClient === undefined)
        throw rejectStatus(
          404,
          "query relay disabled; start the panel with --mcp-url and --query-token",
        );
      if (request.method === "GET") {
        response.writeHead(200, {
          "content-type": "application/json; charset=utf-8",
        });
        response.end(
          `${JSON.stringify({ enabled: true, tools: allowedTools })}\n`,
        );
        return;
      }
      if (request.method !== "POST") {
        response.writeHead(405, { allow: "GET, POST" }).end();
        return;
      }
      requireSameOrigin(request);
      if (!tokenMatches(request))
        throw rejectStatus(401, "missing or invalid x-xtna-token");
      admitQuery();
      try {
        const verdict = validatePanelQuery(await body(request), {
          allowedTools,
        });
        if (!verdict.ok) throw rejectStatus(400, verdict.reason);
        const startedAt = Date.now();
        try {
          const result = await queryClient.callTool(verdict.tool, verdict.args);
          await logQuery({
            at: new Date().toISOString(),
            tool: verdict.tool,
            args: verdict.args,
            ok: true,
            elapsedMs: Date.now() - startedAt,
          });
          response.writeHead(200, {
            "content-type": "application/json; charset=utf-8",
          });
          response.end(
            `${JSON.stringify({ ok: true, tool: verdict.tool, result })}\n`,
          );
        } catch (error) {
          await logQuery({
            at: new Date().toISOString(),
            tool: verdict.tool,
            args: verdict.args,
            ok: false,
            error: String(error.message ?? error),
            elapsedMs: Date.now() - startedAt,
          });
          throw rejectStatus(
            502,
            `provider query failed: ${String(error.message ?? error)}`,
          );
        }
      } finally {
        queryInFlight = false;
      }
      return;
    }
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
    const status =
      typeof error === "object" && error !== null && "status" in error
        ? Number(error.status)
        : 500;
    response
      .writeHead(status, { "content-type": "application/json" })
      .end(`${JSON.stringify({ error: String(error.message ?? error) })}\n`);
  }
});

const watched = [
  inputs.evidencePath,
  inputs.overlayPath,
  inputs.hypothesesPath,
  annotationsPath,
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

const websocketHandler = async (socket, payload) => {
  let message;
  try {
    message = JSON.parse(payload);
  } catch {
    socket.write(
      encodeFrame(JSON.stringify({ type: "error", message: "invalid JSON" })),
    );
    return;
  }
  if (message?.type !== "annotation") {
    socket.write(
      encodeFrame(
        JSON.stringify({ type: "error", message: "unsupported message" }),
      ),
    );
    return;
  }
  try {
    const record = await appendAnnotation(message);
    broadcastJson({ type: "annotation", record });
  } catch (error) {
    socket.write(
      encodeFrame(
        JSON.stringify({
          type: "error",
          message: String(error.message ?? error),
        }),
      ),
    );
  }
};

const attachWebSocket = (socket) => {
  wsClients.add(socket);
  let buffer = Buffer.alloc(0);
  const closeWith = (code) => {
    const body = Buffer.alloc(2);
    body.writeUInt16BE(code, 0);
    try {
      socket.write(Buffer.concat([Buffer.from([0x88, 2]), body]));
    } catch {}
    wsClients.delete(socket);
    socket.destroy();
  };
  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      if (buffer.length < 2) return;
      const first = buffer[0];
      const second = buffer[1];
      const fin = (first & 0x80) !== 0;
      const opcode = first & 0x0f;
      const masked = (second & 0x80) !== 0;
      let length = second & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (buffer.length < 4) return;
        length = buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (buffer.length < 10) return;
        length = Number(buffer.readBigUInt64BE(2));
        offset = 10;
      }
      if (length > MAX_WS_MESSAGE_BYTES) return closeWith(1009);
      if (!masked) return closeWith(1002);
      if (buffer.length < offset + 4 + length) return;
      const mask = buffer.subarray(offset, offset + 4);
      offset += 4;
      const payload = Buffer.from(buffer.subarray(offset, offset + length));
      for (let index = 0; index < payload.length; index += 1)
        payload[index] ^= mask[index % 4];
      buffer = buffer.subarray(offset + length);
      if (!fin) return closeWith(1003);
      if (opcode === 0x8) return closeWith(1000);
      if (opcode === 0x9) {
        socket.write(encodeFrame("", 0xa));
        continue;
      }
      if (opcode !== 0x1) return closeWith(1003);
      void websocketHandler(socket, payload.toString("utf8"));
    }
  });
  socket.on("close", () => wsClients.delete(socket));
  socket.on("error", () => wsClients.delete(socket));
};

server.on("upgrade", (request, socket) => {
  const url = new URL(request.url ?? "/", `http://${host}`);
  if (url.pathname !== "/ws") {
    socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
    socket.destroy();
    return;
  }
  const key = request.headers["sec-websocket-key"];
  if (typeof key !== "string" || wsClients.size >= MAX_WS_CLIENTS) {
    socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
    socket.destroy();
    return;
  }
  const origin = request.headers.origin;
  if (origin !== undefined) {
    let allowed = false;
    try {
      const parsed = new URL(origin);
      allowed =
        ["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname) &&
        Number(parsed.port === "" ? 80 : parsed.port) === listeningPort;
    } catch {
      allowed = false;
    }
    if (!allowed) {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }
  }
  const accept = createHash("sha1")
    .update(key + WS_GUID)
    .digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  attachWebSocket(socket);
});

server.listen(port, host, () => {
  const address = server.address();
  const actualPort =
    typeof address === "object" && address !== null ? address.port : port;
  listeningPort = actualPort;
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
