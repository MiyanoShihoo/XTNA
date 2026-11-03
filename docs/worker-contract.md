# Worker Contract

Status: **proposed** — design for G3. No implementation is claimed beyond what §6 lists as
existing. This document is the contract an implementation is reviewed against; it is not a
description of finished behaviour.

Scope: how one bounded unit of work is planned, executed, observed and reported, for both local
process workers and a caller-supplied model endpoint (BYO endpoint).

---

## 1. Why this contract exists

Three execution shapes already exist in the tree — `WorkerScheduler`, `ProcessWorker`, and
`SandboxExecution` — plus a task ledger (`SubagentTaskBoard`). They were built for different
callers and each carries its own idea of what a task is, what failure means, and who may run
what. G3 adds a fourth: a worker whose reasoning comes from a caller-supplied model endpoint.

Adding it without a contract means five subtly different answers to "did this task succeed?",
which is the failure mode that produced the identity defects this milestone is still paying for.

The contract therefore separates five responsibilities and forbids each from doing the next one's
job.

---

## 2. The five responsibilities

| Responsibility | Owns                                                                                         | Must not                                             |
| -------------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| **Scheduler**  | wave planning, dependency order, retry budget, cancellation propagation, durable task ledger | spawn a process, call a model, or touch a filesystem |
| **Adapter**    | turning one task spec into one execution (local process, model endpoint)                     | decide whether the task was allowed to run           |
| **Sandbox**    | the isolation tier a command actually runs in, or a refusal                                  | fall back to host execution                          |
| **Observer**   | bounded capture of stdout/stderr/frames/exit                                                 | interpret success                                    |
| **Reporter**   | the typed result record and the evidence it cites                                            | claim a state the observation did not support        |

A component may not both execute and judge. That is the invariant this document exists to state.

---

## 3. Task specification

A task is data, not code. Minimum fields:

```ts
interface WorkerTaskSpec {
  readonly id: string; // stable within one run
  readonly role: WorkerRole; // static-worker | runtime-worker | contract-worker
  readonly brief: string; // the complete instruction; no chat history
  readonly dependsOn: readonly string[]; // same-run ids only
  readonly budget: {
    readonly wallClockMs: number;
    readonly maxRetries: number; // 0..2, bounded
    readonly outputBytes: number;
  };
  readonly effects: readonly WorkerEffect[]; // declared, see §4
}
```

Rules:

1. **`brief` is self-contained.** A task may not depend on an earlier task's transcript, only on
   artifacts it names by path or digest.
2. **`dependsOn` may not form a cycle.** The scheduler fails the plan, it does not attempt a
   task whose dependency is unresolved.
3. **A task declares its effects.** An effect not declared may not occur; an undeclared attempt
   is a contract violation, not a warning.

---

## 4. Effects and authorisation

```ts
type WorkerEffect =
  | { kind: "read"; paths: readonly string[] }
  | { kind: "write"; paths: readonly string[] }
  | { kind: "network"; origins: readonly string[] }
  | { kind: "process"; commands: readonly string[] };
```

The scheduler refuses a task whose declared effects exceed the run's authorisation. Two hard
rules, both learned from this repository's own history:

1. **A model response is data, not permission.** Text returned by an endpoint cannot grant an
   effect. An adapter that executes a command named in model output must have had that command
   authorised by the task spec before the call.
2. **No implicit host fallback.** If the required isolation tier is unavailable, the task is
   `blocked` with a reason. `SandboxExecution` already refuses rather than degrading; that refusal
   is the contract, not a limitation to work around.

---

## 5. Lifecycle and result

```
planned → running → (completed | failed | blocked | cancelled)
```

| Transition            | Requirement                                                                  |
| --------------------- | ---------------------------------------------------------------------------- |
| `planned → running`   | dependencies `completed`; authorisation checked; timeout armed               |
| `running → completed` | process exit 0 **and** the adapter's own success condition, not either alone |
| `running → failed`    | non-zero exit, protocol violation, or timeout                                |
| `running → blocked`   | an effect or isolation tier is unavailable; nothing is retried               |
| `* → cancelled`       | caller cancellation; cleanup runs; no orphan process survives                |

Retry is bounded by `budget.maxRetries` and allowed only for `failed`, never for `blocked`.

**"The HTTP request succeeded" is not task success.** For a model-endpoint adapter, `completed`
requires: the response is well-formed against the declared schema, every effect it requests is
authorised, and the adapter's verification step passed. A 200 with unusable content is `failed`.

---

## 6. What exists today (honest inventory)

| Component              | File                                             | State                                                                                |
| ---------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------ |
| Scheduler              | `src/application/execution/WorkerScheduler.ts`   | implemented: roles, waves, plan errors, replan                                       |
| Task ledger            | `src/application/execution/SubagentTaskBoard.ts` | implemented: start/finish records, board errors                                      |
| Local process adapter  | `src/application/execution/ProcessWorker.ts`     | implemented: bounded command, owned process                                          |
| Sandbox                | `src/application/sandbox/SandboxExecution.ts`    | admission + Docker/Podman argv; **real backend unverified on this host** (no daemon) |
| CLI worker lane        | `scripts/worker-run.mjs`                         | implemented                                                                          |
| Model endpoint adapter | —                                                | **not implemented**                                                                  |
| HITL console           | —                                                | **not implemented**; only CLI approval prompts exist                                 |

The gap is therefore narrow and named: a model-endpoint adapter, and the operator surface that
lets a human approve a blocked task.

---

## 7. Model-endpoint adapter (BYO endpoint)

Requirements, in review order:

1. **Endpoint is caller-supplied configuration**, never discovered. No default host.
2. **Credentials are not persisted** in a task record, a log, or a result.
3. **The request is bounded**: wall clock from `budget`, response size from `budget.outputBytes`.
4. **The response is validated before use.** Schema first; effects second; nothing is executed
   from an unvalidated response.
5. **Failure classes are distinct**: transport, schema, refusal, and budget exhaustion produce
   different reasons, because the operator's next action differs.
6. **A stub server is enough to test it.** Protocol, timeout, cancellation and error mapping are
   verifiable without any real provider; the acceptance tests use a local stub, and no test may
   require a live key.

---

## 8. Acceptance tests this contract requires

Each row must exist as an executable test before the adapter is called done.

| #   | Case                                     | Expectation                                |
| --- | ---------------------------------------- | ------------------------------------------ |
| 1   | two dependency waves                     | wave 2 starts only after wave 1 completed  |
| 2   | cycle in `dependsOn`                     | plan error, nothing runs                   |
| 3   | declared write outside authorisation     | `blocked`, no write attempted              |
| 4   | model response naming a command          | not executed unless the spec authorised it |
| 5   | endpoint returns 200 with malformed body | `failed` (schema), distinct reason         |
| 6   | endpoint exceeds wall clock              | `failed` (budget), process tree cleaned    |
| 7   | caller cancels mid-run                   | `cancelled`, no orphan, cleanup recorded   |
| 8   | sandbox tier unavailable                 | `blocked`, no host fallback                |
| 9   | retry budget exhausted                   | retries stop at `maxRetries`               |
| 10  | operator approves a blocked task         | resumes once, ledger records the decision  |

---

## 9. Explicit non-goals

- Replacing the orchestrator skill, or the `agent-orchestrator` workflow.
- Unbounded autonomy: a task never gains effects from a previous task's success.
- Claiming OS-level isolation on a host that cannot provide it. `WSL2` is not a sandbox.
