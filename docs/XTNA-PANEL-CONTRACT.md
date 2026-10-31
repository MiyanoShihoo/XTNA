# Panel wire contract

The live panel is meant to be consumed by a UI layer, so its two HTTP surfaces are frozen here.
Version: **1.0.0** (`PANEL_CONTRACT_VERSION` in `scripts/lib/panel-contract.mjs`).

`GET /api/contract` returns the machine-readable version of this document; the panel validates
`/api/state` against the same module before serving it and answers `500` with the violation list
instead of shipping a shape it cannot vouch for.

## `GET /api/state`

| Field                                                    | Type               | Meaning                                                                                     |
| -------------------------------------------------------- | ------------------ | ------------------------------------------------------------------------------------------- |
| `generatedAt`                                            | string             | ISO-8601 projection time                                                                    |
| `title`                                                  | string             | panel title                                                                                 |
| `sources.evidence`                                       | string             | bundle path                                                                                 |
| `sources.overlay` / `hypotheses` / `checkpoints`         | string \| null     | optional inputs                                                                             |
| `counts`                                                 | object             | `records, artifacts, unknowns, limitations, symbols, hypotheses, checkpoints` — all numbers |
| `graph`                                                  | object             | `nodes[]`, `edges[]`, `truncated: boolean` (≤ 400 nodes / 1,200 edges)                      |
| `waterfall`                                              | object             | `entries[]`, `timed: boolean`, `truncated: boolean` (≤ 200)                                 |
| `records`                                                | array (optional)   | evidence cards; omitted when the bundle has none                                            |
| `recordsTruncated`                                       | boolean (optional) | card cap reached                                                                            |
| `limitations` / `symbols` / `hypotheses` / `checkpoints` | array              | table rows                                                                                  |

## `GET /api/query` and `POST /api/query`

Opt-in relay (see `XTNA-LIVE-PANEL.md`). Request body: `{ tool: string, args?: object }`, with
`confirm?: { requestId, code }` for write/attach tools.

| Response      | Shape                                                           |
| ------------- | --------------------------------------------------------------- |
| `202` pending | `{ status: "pending", requestId: string, expiresAt: ISO-8601 }` |
| `200` success | `{ ok: true, tool: string, result: <MCP tool result> }`         |
| error         | `{ error: string }` with `400/401/403/404/429/500/502`          |

`x-xtna-token` is required on `POST`. The panel's own loopback `Origin` is required when a browser
sends one.

## Change policy

- Adding an optional field bumps the **minor** version.
- Removing or retyping a field bumps the **major** version.
- A consumer may ignore unknown optional fields; it must not assume a field is absent because a
  previous version omitted it.
