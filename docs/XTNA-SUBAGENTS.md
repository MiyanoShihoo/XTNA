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

## Scheduler

`runWorkerPlan` (in-process) executes a plan of tasks over the same roles. It is the scheduling
half; the board stays the ledger.

```ts
const result = await runWorkerPlan(plan, {
  handlers: {
    "static-worker": staticHandler,
    "runtime-worker": runtimeHandler,
  },
  maxAttempts: 2,
  timeoutMs: 15_000,
  signal,
});
```

- `planWaves` validates the graph (unknown dependency, self-dependency, duplicate id, cycle,
  more than 32 tasks) and returns dependency waves; a wave runs in parallel.
- Retries cover thrown errors and attempt timeouts; `maxAttempts` includes the first try.
- **Cancellation delivery**: aborting `signal` aborts the attempt-level `AbortSignal` the handler
  holds, marks the running task `cancelled`, and cancels later waves without starting them.
- A failed task blocks every transitive dependent with the upstream id as its reason, while
  independent branches keep running. A role with no registered handler is `blocked` at once.

`replanAfterFailure(tasks, report, { retryRole })` builds the next plan: completed work is
carried, a failed task is re-queued as `<id>:retry` under the fallback role, dependents are
rewired to the retry, and a branch with no fallback is dropped together with everything
downstream of it.

## Limits

- No worker process, LLM, subprocess or remote session is started or controlled.
- Cancellation reaches an in-process handler through its `AbortSignal`; a handler that ignores
  the signal still times out but cannot be force-killed. The task board itself never receives a
  cancellation from outside; `cancelled` there remains a ledger fact.
- Dependency checks are task-board checks; the scheduler is a bounded plan runner, not a
  persistent orchestration service. Results stay in memory.
- Evidence ids are references supplied by the caller; neither the board nor the scheduler
  verifies that the referenced Evidence exists or supports the summary.
