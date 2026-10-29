# Stateful mock server

`npm run mock:gen -- --in <capture> --out <server.mjs>` generates a runnable local server that
keeps state, instead of replaying fixed responses.

## Why

A recorded replay breaks the moment a client creates a record and then reads it back. The
generated server starts from the capture and then behaves like a small CRUD backend, so an
offline regression run or an agent-environment loop can exercise real state transitions.

## What it generates

One dependency-free module (`node:http`, `node:fs` only).

| Method        | Template             | Behaviour                                         |
| ------------- | -------------------- | ------------------------------------------------- |
| GET           | `/<collection>`      | list the current state, honouring `?limit=`       |
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

`--persist state.json` makes the generated server load and rewrite that file, so state
survives restarts. Without it, state lives in memory and resets on exit.

## Limits

- Only JSON bodies are understood; binary and form payloads are replayed verbatim at best.
- Validation is absent: any body is merged into the record. Add checks before using this as a
  contract test double.
- Nested resources (`/users/1/orders`) are treated as their own collection only when the
  capture shows a collection response for them.
- No authentication, pagination cursors, or relationship integrity between collections.
- Generated code is a development aid, not a production server.
