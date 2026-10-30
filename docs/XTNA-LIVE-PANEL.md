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
| `/api/annotations` | GET    | `{enabled, annotations}`; last 200 records                                  |
| `/api/annotations` | POST   | Appends `{created_at, target, note}`; `403` without `--annotations`         |
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

## Stability properties

- Read-only by default: without `--annotations` the server never writes.
- The renderer never evaluates evidence content as code — rows are inserted as text nodes
  through `String(...)` and escaped before `innerHTML`.
- Loopback by default; binding elsewhere is an explicit `--host`.
- File watching is best effort: a missing file is reported by `/api/state`, not by a crash.
- `SIGINT`/`SIGTERM` close clients, watchers and the listener, with a one-second fallback.
- A malformed bundle yields a `500` with the error text rather than terminating the process.

## Limits

- Topology is a projection of recorded call/trace payloads, not a live provider query; a bundle
  with no such records shows an empty graph rather than fetching one.
- The only write is an append-only note, over HTTP or the socket; there is no editing of
  evidence or provider state.
- Evidence cards are projections of stored records, not a live provider query.
- The change signal is a digest of the projection, not a diff: it says "something changed".
- One investigation per process; there is no multi-session registry.
