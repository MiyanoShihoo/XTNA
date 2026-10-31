# Process-backed worker plans

`npm run worker:run -- --plan <plan.json> [--yes] [--json]` runs the existing
`runWorkerPlan` dependency scheduler with **owned OS processes** as workers.

## Plan format

```json
{
  "maxAttempts": 1,
  "timeoutMs": 15000,
  "tasks": [
    {
      "id": "static-map",
      "role": "static-worker",
      "objective": "map imports",
      "command": {
        "command": "node",
        "arguments": ["worker.js"],
        "timeoutMs": 10000,
        "maxOutputBytes": 65536
      }
    },
    {
      "id": "runtime-map",
      "role": "runtime-worker",
      "objective": "observe runtime",
      "dependencies": ["static-map"],
      "command": {
        "command": "node",
        "arguments": ["runtime-worker.js"]
      }
    }
  ]
}
```

## Worker protocol

The task brief is written to stdin as one JSON object:

```json
{
  "id": "static-map",
  "role": "static-worker",
  "objective": "map imports",
  "attempt": 1
}
```

The child must write one JSON object as the final non-empty stdout line:

```json
{ "evidenceIds": ["ev_..."], "summary": "..." }
```

A nonzero exit, timeout, missing/invalid report or cancellation fails that attempt; the scheduler
handles retries, dependency blocking and cancellation delivery.

## Safety and ownership

- Every child is launched through `spawnOwnedProviderProcess` and supervised by
  `ProviderProcessSupervisor`; stdout/stderr are bounded per stream.
- The CLI refuses to run without a TTY confirmation unless `--yes` is passed explicitly.
- Commands, arguments, cwd and environment are explicit; nothing is inferred from a role.
- This is not an MCP execution surface and does not launch an LLM. Those remain open gaps.

## Boundaries

- No shell interpretation; `command` and `arguments` are passed as an argv array.
- No automatic file/URL selection; the plan author names them.
- Worker output is diagnostic text, not an Evidence bundle; the plan runner reports evidence ids
  supplied by the child and does not mint Evidence.
- The host environment is inherited unless the plan supplies `env` overrides; do not put secrets in
  plan files.
- A timed-out or cancelled worker goes through the supervisor cleanup path; cleanup status is returned
  by the underlying primitive, not re-created here.
