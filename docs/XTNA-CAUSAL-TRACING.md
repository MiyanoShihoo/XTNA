# Cross-boundary causal tracing

`npm run trace:causal -- --browser ui.json --ipc ipc.jsonl --probe native.jsonl` puts event
streams from different boundaries on one timeline and groups them into candidate causal chains.

## Why

A UI click, the IPC message it sends, the native function it reaches and the file it finally
writes live in four different logs with four different clocks. Read separately they are four
stories; read together they are one. This tool does the merge and the grouping, and stops
there: ordering is evidence, causation is an inference the analyst still has to defend.

## Input

Each `--browser`, `--ipc`, `--probe`, `--native` and `--log` file is either a JSON array or
JSON-lines. Records accept:

| Field                       | Meaning                                                                   |
| --------------------------- | ------------------------------------------------------------------------- |
| `timestamp` / `time` / `ts` | epoch milliseconds or an ISO 8601 string                                  |
| `name`                      | short stable event name (`click`, `ipc:config:write`, `enter:saveConfig`) |
| `traceId`                   | correlation id assigned by the producer, when one exists                  |
| `durationMs`                | span length, when the producer measured one                               |
| `kind`, `detail`            | optional classification and payload, preserved verbatim                   |

Records without a parseable timestamp or a `name` are skipped rather than guessed at.

## Output

```text
# 5 events, 2 candidate chains, span 4000ms, largest gap 3960ms
# sources: browser=2 ipc=2 probe=1

## trace-id tx-1 (10ms)
  +     0ms ipc     ipc:config:write
  +    10ms ipc     fs:write
```

- **trace-id chains** group events that share an explicit id, regardless of distance.
- **time-window chains** group untagged events whose consecutive gap is within `--window-ms`
  (default 50 ms). They are adjacency, not proof.
- `--json` returns the full structure: summary, chains and every event.

## What it will not do

- Invent correlation. No trace id and no time adjacency means no chain.
- Prove causation or order across machines: clocks drift, and only one clock is assumed here.
- Decode payloads. `detail` is carried through unchanged.

## Limits

- One timeline per invocation; inputs must share a clock domain (or be normalized before use).
- A wide `--window-ms` will chain unrelated work; a narrow one will split real chains. Print
  the summary and tune it per capture.
- Chains are candidates for the hypothesis board, not conclusions.
