# Live investigation panel

`npm run panel:serve -- --evidence bundle.json` serves a live investigation view over
loopback: an HTML page with a call topology graph and a network waterfall, a JSON snapshot, an
event stream that fires when the evidence changes, and an optional append-only note channel.

## Why

The offline panel (`npm run panel`) is a single file you regenerate by hand. During a long
investigation the evidence keeps growing, so the page is stale the moment it is written. The
live variant watches the same artefacts and refreshes the browser instead.

## Routes

| Route              | Method | Response                                                                    |
| ------------------ | ------ | --------------------------------------------------------------------------- |
| `/`                | GET    | HTML shell: tables, SVG topology graph, waterfall, annotation box           |
| `/api/state`       | GET    | JSON snapshot of counts, graph, waterfall, symbols, hypotheses, checkpoints |
| `/events`          | GET    | `text/event-stream`; one `refresh` event per change                         |
| `/api/annotations` | GET    | `{enabled, annotations, total, truncated}`; last 200 records                |
| `/api/annotations` | POST   | Appends `{created_at, target, note}`; `403` without `--annotations`         |
| `/api/query`       | GET    | `{enabled, tools}`; `404` without `--mcp-url` + `--query-token`             |
| `/api/query`       | POST   | Relays one allowlisted read-only tool; token + same-origin required         |
| anything else      | any    | `404` JSON; `405` for unsupported methods                                   |

Only those routes exist. No file path from disk is ever served, so path traversal has nothing
to traverse.

## Views

- **Topology** — an SVG graph built from records whose payload carries `nodes[]`
  (`address` plus optional `name`/`label`/`depth`) and `edges[]`
  (`source_address`/`target_address`, or `from`/`to`). Nodes are laid out in depth columns;
  unranked nodes share one column. Clicking a node selects it for annotation.
- **Waterfall** — transaction bars from `transactions[]`/`network_transactions[]` records, or
  from browser scenario `events.items[]` where `request` and `response` events share a
  `transaction_id`. Bars start at the earliest recorded `started_at`; failures (status ≥ 400)
  are drawn in a second colour. Captures without timings fall back to capture order and say so.
- **Evidence cards** — one card per record with operation, provider, authority, confidence,
  limitation count and evidence id; capped at 200 with an explicit truncation note.
- **Tables** — limitations, symbols, hypotheses and checkpoints, unchanged.

Both views are bounded: 400 nodes, 1,200 edges, 200 transactions. Truncation is reported in the
snapshot and on the page; nothing is silently cut.

## Inputs

| Flag                | Meaning                                                                |
| ------------------- | ---------------------------------------------------------------------- |
| `--evidence`        | Evidence bundle JSON (required)                                        |
| `--overlay`         | symbol overlay file; defaults to the store entry for the bundle digest |
| `--hypotheses`      | hypothesis board JSON                                                  |
| `--checkpoints`     | directory of checkpoint files                                          |
| `--annotations`     | JSONL file for human notes; omit to keep the panel strictly read-only  |
| `--mcp-url`         | loopback MCP endpoint to relay allowlisted read-only queries to        |
| `--query-token`     | required with `--mcp-url`; sent by the page as `x-xtna-token`          |
| `--query-tools`     | comma list that can only narrow the built-in allowlist                 |
| `--query-log`       | JSONL file receiving one record per relayed query                      |
| `--port` / `--host` | defaults `4321` on `127.0.0.1`                                         |

The snapshot keeps every source path so a reviewer can trace a row back to its file.

## Annotations and the socket

The page talks to `/ws` when the browser allows it and falls back to `POST /api/annotations`.
The socket carries one message type, `{"type":"annotation","target":"…","note":"…"}`; the server
validates it exactly like the HTTP route, appends the record and broadcasts
`{"type":"annotation","record":…}` to every connected page, so two open panels stay in sync.
A rejected note comes back as `{"type":"error","message":…}`.

Bounds: 16 KiB per message, 8 concurrent sockets, loopback only. A browser handshake whose
`Origin` is not `127.0.0.1`/`localhost` on the served port is refused with `403` — the panel
does not accept cross-site WebSocket connections.

With `--annotations notes.jsonl`, a human can select a graph node, type a note and save it. The
server validates `target` (1–512 characters) and `note` (1–4,000 characters), rejects bodies over
64 KiB with `413`, refuses files past 5 MiB, and appends one JSON line per note. The agent reads
the same file; that is the whole synchronisation contract — no hidden channel, no mutation of
evidence.

## Read-only query relay (opt-in)

The panel can forward one tightly bounded request to an MCP server that already owns a provider
session. It is still not a provider host: the server keeps the Ghidra/Hopper/IDA/JADX session, and
the panel only relays.

```bash
xtna mcp --http --port 8765
npm run panel:serve -- --evidence bundle.json \
  --mcp-url http://127.0.0.1:8765/mcp --query-token <long-random-token> \
  [--query-tools analyze_function,read_bytes] [--query-log queries.jsonl]
```

`--mcp-url` and `--query-token` must be given together; one without the other refuses to start.
The MCP endpoint must be loopback.

Boundary rules, all enforced before a request leaves the panel:

- **Tool allowlist.** The default is a read-only analysis surface (`analyze_function`, `read_bytes`,
  `xrefs`, `list_procedures`, `list_strings`, `search_procedures`, `procedure_*`, …). Anything that
  opens targets, attaches processes, runs scripts, captures traffic or changes settings is absent.
  `--query-tools` can only narrow that default, never widen it.
- **Argument shape.** Arguments are scalar only (strings ≤ 512 chars, finite numbers, booleans,
  null); keys must match a name pattern and are rejected when they select a file, process, URL,
  shell or environment surface (`path`, `binary`, `url`, `command`, `script`, …).
- **Token.** `POST /api/query` requires `x-xtna-token`; missing or wrong is `401`. The page asks
  the operator to type the token and never stores it.
- **Origin.** A browser request must come from the panel's own loopback origin; anything else is
  `403`, closing cross-site requests against the localhost service.
- **Budget.** One query in flight, 20 per minute, 30-second deadline, 2 MiB reply cap, 64 KiB
  request body.
- **Log.** `--query-log` appends one JSON line per query (tool, arguments, ok, elapsed). Results
  are not copied into the bundle; the MCP server records its own Evidence.

The relay cannot open a binary: `open_binary` is deliberately not allowlisted, so a query only
answers inside a session an agent or CLI already opened on that server.

### Write and attach tools (default off)

Session metadata and target attachment are reachable only when the operator names each tool:
`--allow-write-tools set_comment,set_address_name`. The flag refuses to start on a tool that has
no write or attach tier, and every such call takes two steps:

1. `POST /api/query` answers `202 {status:"pending", requestId, expiresAt}` and prints one line to
   the panel's terminal: `APPROVAL <id> tool=<tool> code=<six digits>`.
2. The operator types that code into the page; the second `POST` carries
   `confirm: {requestId, code}` and executes the call.

A code is single-use, expires after 120 seconds, and is bound to the exact tool plus argument
object, so a captured code cannot be replayed against a different query. At most eight approvals
wait at once. Argument rules still apply, so tools that need a file, URL or shell command stay
unusable whatever their tier. The query log records the tier of every call.

## Stability properties

- Read-only by default: without `--annotations` the server never writes.
- The renderer never evaluates evidence content as code — rows are inserted as text nodes
  through `String(...)` and escaped before `innerHTML`.
- Loopback by default; binding elsewhere is an explicit `--host`.
- File watching is best effort: a missing file is reported by `/api/state`, not by a crash.
- `SIGINT`/`SIGTERM` close clients, watchers and the listener, with a one-second fallback.
- A malformed bundle yields a `500` with the error text rather than terminating the process.

## Limits

- Topology is a projection of recorded call/trace payloads; without `--mcp-url` a bundle with no
  such records shows an empty graph rather than fetching one.
- The only write is an append-only note, over HTTP or the socket; there is no editing of evidence
  or provider state. The query relay adds read-only calls only.
- Evidence cards are projections of stored records; a relayed query result is displayed as the
  server returned it and recorded in the query log, not merged into the bundle.
- The change signal is a digest of the projection, not a diff: it says "something changed".
- One investigation per process; there is no multi-session registry.
