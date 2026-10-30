# Sub-agent role tasks

`subagent_task_start` and `subagent_task_finish` provide a session-scoped role/task ledger for
orchestrated investigations. They define the coordination contract; they do not launch an LLM,
a process, or a remote agent.

## Roles

| Role              | Intended work                                      |
| ----------------- | -------------------------------------------------- |
| `static-worker`   | static code, artifact and graph analysis           |
| `runtime-worker`  | controlled runtime observation and capture         |
| `contract-worker` | schemas, interfaces, hypotheses and reconciliation |

## Workflow

```text
subagent_task_start { id: "static-map", role: "static-worker", objective: "map reachability" }
subagent_task_finish { id: "static-map", status: "completed", evidence_ids: ["ev_..."], summary: "mapped" }
subagent_task_start { id: "contract", role: "contract-worker", objective: "derive contract", dependencies: ["static-map"] }
```

- A task starts in `running`; only a completed dependency may be named by a new task.
- A completed task must name at least one supporting Evidence id.
- `subagent_task_finish` accepts `completed`, `failed`, or `cancelled`.
- The returned snapshot includes role tasks, status counts and a shared
  `evidence_index` mapping Evidence ids to claiming task ids.
- The board holds at most 32 tasks per server session; evidence ids are de-duplicated.

## Limits

- No worker process, LLM, subprocess or remote session is started or controlled.
- No cancellation signal is delivered to an external worker; the `cancelled` status is a ledger
  fact only.
- Dependency checks are task-board checks, not a scheduler that retries or re-plans.
- Evidence ids are references supplied by the caller; the board does not verify that the
  referenced Evidence exists or supports the summary.
