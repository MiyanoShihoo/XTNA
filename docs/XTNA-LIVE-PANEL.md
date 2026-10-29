# Live investigation panel

`npm run panel:serve -- --evidence bundle.json` serves a read-only investigation view over
loopback: an HTML page, a JSON snapshot and an event stream that fires when the evidence
changes.

## Why

The offline panel (`npm run panel`) is a single file you regenerate by hand. During a long
investigation the evidence keeps growing, so the page is stale the moment it is written. The
live variant watches the same artefacts and refreshes the browser instead.

## Routes

| Route         | Method | Response                                                               |
| ------------- | ------ | ---------------------------------------------------------------------- |
| `/`           | GET    | HTML shell; fetches the snapshot and renders tables                    |
| `/api/state`  | GET    | JSON snapshot of counts, limitations, symbols, hypotheses, checkpoints |
| `/events`     | GET    | `text/event-stream`; one `refresh` event per change                    |
| anything else | any    | `404` JSON; `405` for non-GET                                          |

Only those three routes exist. No file path from disk is ever served, so path traversal has
nothing to traverse.

## Inputs

| Flag                | Meaning                                                                |
| ------------------- | ---------------------------------------------------------------------- |
| `--evidence`        | Evidence bundle JSON (required)                                        |
| `--overlay`         | symbol overlay file; defaults to the store entry for the bundle digest |
| `--hypotheses`      | hypothesis board JSON                                                  |
| `--checkpoints`     | directory of checkpoint files                                          |
| `--port` / `--host` | defaults `4321` on `127.0.0.1`                                         |

The snapshot keeps every source path so a reviewer can trace a row back to its file.

## Stability properties

- Read-only: the server never writes, and the renderer never evaluates evidence content as
  code — rows are inserted as text nodes through `String(...)`.
- Loopback by default; binding elsewhere is an explicit `--host`.
- File watching is best effort: a missing file is reported by `/api/state`, not by a crash.
- `SIGINT`/`SIGTERM` close clients, watchers and the listener, with a one-second fallback.
- A malformed bundle yields a `500` with the error text rather than terminating the process.

## Limits

- No topology graph or timeline view yet; the page renders tables.
- Server-sent events only; no WebSocket command channel, so nothing is editable from the page.
- The change signal is a digest of the projection, not a diff: it says "something changed".
- One investigation per process; there is no multi-session registry.
