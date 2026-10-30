# Stateful mock server

`npm run mock:gen -- --in <capture> --out <server.mjs>` generates a runnable local server that
keeps state, instead of replaying fixed responses.

## Why

A recorded replay breaks the moment a client creates a record and then reads it back. The
generated server starts from the capture and then behaves like a small CRUD backend, so an
offline regression run or an agent-environment loop can exercise real state transitions.

## What it generates

One module that needs no installed dependencies. It uses `node:http` plus the built-in
`node:sqlite` database when the host provides it, and falls back to an in-memory map otherwise;
the startup line reports which backend is active (`{"port":...,"backend":"sqlite"}`).

| Method        | Template             | Behaviour                                         |
| ------------- | -------------------- | ------------------------------------------------- |
| GET           | `/<collection>`      | list state, honouring `?limit=` and `?cursor=`    |
| GET           | `/<collection>/{id}` | read one record, 404 when absent                  |
| POST          | `/<collection>`      | merge the body, assign the next numeric `id`, 201 |
| PUT / PATCH   | `/<collection>/{id}` | merge the body, keep the original `id`, 200       |
| DELETE        | `/<collection>/{id}` | remove the record, 204                            |
| anything else | recorded template    | replay the recorded status and body               |

Collections come from `GET` responses that return arrays; individual records come from
`GET /<collection>/{id}` responses. Any collection that appears in the capture also gets the
CRUD verbs it never showed, because a capture rarely records every method.

```bash
npm run mock:gen -- --in traffic.har --out ./mock/server.mjs --port 8080
node ./mock/server.mjs
```

## State backends

| Flag                   | Behaviour                                                     |
| ---------------------- | ------------------------------------------------------------- |
| _(default)_            | SQLite in memory (`:memory:`) when `node:sqlite` is available |
| `--sqlite <path>`      | File-backed SQLite; state survives restarts                   |
| `--backend memory`     | Plain in-memory map; never imports `node:sqlite`              |
| `--persist state.json` | Memory backend only: load and rewrite that JSON file          |

`node:sqlite` ships with Node 24 (and newer); on hosts without it the server prints one
warning and keeps the same behaviour on the memory backend.

## Filtering and sorting

A list request may narrow and order the current state before paging:

```text
GET /users?name=Ada                 # equality on one field
GET /users?sort=name&order=desc     # single-field sort, asc (default) or desc
GET /events?kind=c&limit=2&cursor=… # filters apply before the cursor window
```

`limit`, `cursor`, `sort` and `order` are reserved; every other query parameter is an equality
filter and values are compared as strings. Missing fields never match. Sorting is stable: equal
keys keep their insertion order, and records without the field sort last. Changing filters or
sort between pages makes an existing cursor meaningless — start the walk again.

## Paged responses

When the capture shows a paged envelope, the generated server keeps that envelope instead of
inventing a new shape:

```json
{ "items": [{ "id": 1 }], "next_cursor": "Mg", "has_more": true }
```

Recognized item keys are `items`, `data`, `results`, `records`, `rows`, `list`; cursor keys are
`next_cursor`, `nextCursor`, `next_page_token`, `nextPageToken`, `cursor`, `next`; boolean keys
are `has_more`, `hasMore`, `more`, `has_next`, `hasNext`. The first request without `limit` uses
the page size the capture showed. Cursors are opaque offsets: follow `next_cursor` until it is
`null`, and an unreadable cursor answers `400 {"error":"invalid cursor"}`.

Cursors are offsets into current state, so a concurrent create or delete between pages can shift
the window; they are a regression-test aid, not a stable pagination contract for concurrent
writers.

## Generated timestamps

If a recorded `POST` response contains an ISO-8601 timestamp field the request did not send
(for example `created_at`), the generated server fills that field on every new record. Fields the
client sent are never overwritten.

## Limits

- Only JSON bodies are understood; binary and form payloads are replayed verbatim at best.
- Validation is absent: any body is merged into the record. Add checks before using this as a
  contract test double.
- Nested resources (`/users/1/orders`) are treated as their own collection only when the
  capture shows a collection response for them.
- No authentication, relationship integrity or multi-field operators (`>`, `in`, ranges);
  filtering is equality-only, and pagination exists only where the capture declared a paged
  envelope.
- Generated code is a development aid, not a production server.
