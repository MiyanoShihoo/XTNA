# Worker Contract

Status: **revision 2 — revised after independent review**. Every claim below was checked against
the tree; §10 lists what the review corrected and §9 lists where the code still violates this
contract.

Scope: how one bounded unit of work is planned, executed, observed and reported — for local
process workers today, and for a caller-supplied model endpoint (BYO endpoint) once that adapter
exists. This is a **target with a migration**, not a description of finished behaviour.

---

## 1. Why this contract exists

There are **two** planners today — `WorkerScheduler` (`src/application/execution/WorkerScheduler.ts`)
and `ReActDagPlanner` (`src/application/execution/ReActDagPlanner.ts`) — plus `ProcessWorker`, a
sandbox admission path, an in-memory task board, and an MCP surface that exposes execution to a
model. Each carries its own task type, its own status union, and its own answer to "did this
succeed?". The review found the two existing modules already disagree on success.

The contract names **one** answer per question and says which module must change to adopt it.

---

## 2. Responsibilities

Five responsibilities. The prohibition is the point: a component that both executes and judges is
where "did this succeed?" forks.

| Responsibility | Owns                                                         | Must not                                      |
| -------------- | ------------------------------------------------------------ | --------------------------------------------- |
| **Planner**    | wave/dependency order, retry budget, cancellation fan-out    | spawn a process, call a model                 |
| **Adapter**    | turning one task spec into one execution (process, endpoint) | decide authorisation                          |
| **Sandbox**    | the isolation tier a command runs in, or a refusal           | fall back to host execution                   |
| **Observer**   | bounded capture of stdout/stderr/frames/exit                 | interpret success                             |
| **Reporter**   | the typed result record and its evidence                     | claim a state the observation did not support |

### 2.1 What the tree actually has

| Role     | Today                                                                             | Gap                                                                                                |
| -------- | --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Planner  | `WorkerScheduler.planWaves/runWorkerPlan`, `ReActDagPlanner.plan`                 | two planners, no shared spec                                                                       |
| Adapter  | `ProcessWorker.runCommand`                                                        | it **also** captures (`ProviderProcessSupervisor`, :116-121) and **also** judges exit (`:138-143`) |
| Sandbox  | `SandboxCapability.admitCommand` → `SandboxExecution.executeSandboxCommand`       | admission lives in `SandboxCapability.ts`, not `SandboxExecution.ts`                               |
| Observer | `ProviderProcessSupervisor`                                                       | it is constructed _inside_ the adapter                                                             |
| Reporter | `WorkerScheduler` builds `WorkerTaskResult`; `SubagentTaskBoard.finish` validates | they disagree: the board rejects `completed` with zero evidence, the scheduler emits it            |

"Observer" is a **target decomposition, not an existing component**. Until `ProcessWorker` stops
judging exit codes, any statement that the tree obeys §2 is false.

---

## 3. Task specification

**The name matters.** `WorkerTaskSpec` is already taken by `WorkerScheduler.ts:17-22`
(`{ id, role, objective, dependencies? }`). Redeclaring that name with different fields would
break `planWaves`, `runWorkerPlan`, `replanAfterFailure`, the board wiring, and — through
`registerSubagentTools.ts:65-74` — the **MCP wire schema** (`objective` → `brief`) in
`subagentToolContracts.ts:33-38`.

The contract therefore proposes a distinct type, adopted by migration:

```ts
interface WorkerContractTaskSpec {
  readonly id: string;
  readonly role: WorkerRole; // existing union
  readonly brief: string; // self-contained; no chat history
  readonly dependsOn: readonly string[]; // same-run ids only
  readonly budget: {
    readonly wallClockMs: number; // whole task, not per attempt
    readonly maxAttempts: number; // includes the first attempt: 1..3
    readonly outputBytes: number;
  };
  readonly effects: readonly WorkerEffect[];
}
```

Rules:

1. **`brief` is self-contained.** A task may depend on artifacts named by path or digest, never
   on a previous task's transcript.
2. **`dependsOn` may not form a cycle.** The planner fails the plan; it does not attempt a task
   whose dependency is unresolved.
3. **`maxAttempts` counts the first attempt** (1..3, ceiling enforced by the planner). Today the
   scheduler reads it as a total (`:100-101`) but accepts any value from the plan (`:348`).
4. **`wallClockMs` is the whole task budget.** `:102` applies it per attempt, so three attempts
   cost three times the declared budget.

---

## 4. Effects and authorisation

```ts
type WorkerEffect =
  | { kind: "read"; paths: readonly string[] }
  | { kind: "write"; paths: readonly string[] }
  | { kind: "network"; origins: readonly string[] }
  | { kind: "process"; commands: readonly string[] };
```

`WorkerEffect` mirrors `src/contracts/toolEffects.ts` and must reconcile with it rather than grow
a second vocabulary; that file also carries `idempotent`, which §4.2 needs.

### 4.1 Two rules

1. **A model response is data, not permission.** Text returned by an endpoint cannot grant an
   effect. Anything it names must already be authorised by the task spec before the call.
2. **No implicit host fallback.** A missing isolation tier is a refusal. `admitCommand` already
   refuses L2/L3 without a container or VM backend (`SandboxCapability.ts:186-195`); the contract
   keeps that refusal and extends it to adapters, which today perform **no tier check at all**
   (`ProcessWorker.ts:88-109`).

### 4.2 Idempotency

Retry is safe only for a task whose effects are idempotent or whose attempt produced no effect.
The spec states `idempotent` per effect; an attempt that threw after a partial write must not be
blindly retried.

---

## 5. Lifecycle and the single verdict

Existing unions:

- `WorkerTaskStatus` (`WorkerScheduler.ts:48`): `completed | failed | blocked | cancelled` — terminal only.
- `SubagentTaskStatus` (`SubagentTaskBoard.ts:7-11`): `running | completed | failed | cancelled`.

Neither has `planned`; only the first has `blocked`; `blocked` appears on no wire schema. The
lifecycle is therefore a **superset to be added**:

```
planned → running → (completed | failed | blocked | cancelled)
```

| State     | Meaning                                                                                                       | Retry                                         |
| --------- | ------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| `failed`  | the attempt ran and did not succeed: non-zero exit, protocol violation, timeout, schema mismatch              | allowed, bounded by `maxAttempts`             |
| `blocked` | the attempt was never allowed to run: missing effect authorisation, missing isolation tier, unknown ownership | **never retried**; needs an operator decision |

Code today uses `blocked` for a _different_ meaning — no handler, or an upstream task that failed
or was cancelled (`WorkerScheduler.ts:266-273,376-383`); §9 records that.

### 5.1 Who assigns the verdict

**The reporter, from observation plus the adapter's success condition — never the adapter alone.**

- `ProcessWorker` rejecting a non-zero exit (`:138-143`) is an _observation_, not a verdict.
- A model endpoint answering 200 is **not** task success. `completed` requires: a well-formed
  response against the declared schema, every requested effect authorised, and the adapter's
  verification step passed.
- `WorkerScheduler` marks `completed` whenever the handler resolves (`:284-291`) and `parseReport`
  accepts `{}` (`:49-67`), so a task can complete with `evidenceIds: []` — which
  `SubagentTaskBoard.finish` **rejects** (`:123-129`). The contract adopts the board's rule: a
  completion with no evidence is `failed`.

---

## 6. What exists today — honest inventory

| Component              | File                                                     | State                                                                                                                                                                                  |
| ---------------------- | -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Scheduler (A)          | `WorkerScheduler.ts`                                     | implemented: roles, waves, plan errors, replan, bounded attempts, per-attempt timeout/abort, downstream blocking, wave-boundary cancellation, 32-task cap, 64-item evidence truncation |
| Scheduler (B)          | `ReActDagPlanner.ts`                                     | implemented: own `PlanTask`, own status union incl. `skipped`, cycle → blocked, per-command authority inside the loop                                                                  |
| Task ledger            | `SubagentTaskBoard.ts`                                   | **in memory only** — a session-scoped `Map` (`:63-65`); a crash loses it                                                                                                               |
| Local process adapter  | `ProcessWorker.ts`                                       | executes and judges in one module; constructs its own observer                                                                                                                         |
| Sandbox admission      | `SandboxCapability.ts:177-222`                           | implemented; **L3 previously admitted any 8-character token** — fixed, see §9                                                                                                          |
| Sandbox execution      | `SandboxExecution.ts`                                    | argv construction + injectable runner; real backend **unverified here** (no daemon)                                                                                                    |
| Authority              | `CommandAuthority.ts`, `contracts/toolEffects.ts`        | caller-declared authority, allow-list, effect gate                                                                                                                                     |
| Model-facing surface   | `registerExecutionTools.ts` (`sandbox_exec`, `run_plan`) | implemented; `sandbox_exec` takes command, tier and approval token from the model                                                                                                      |
| CLI lane               | `scripts/worker-run.mjs`                                 | imports `dist/` — build-dependent; **no test references it**                                                                                                                           |
| Model-endpoint adapter | —                                                        | **not implemented**                                                                                                                                                                    |
| HITL console           | —                                                        | **not implemented**; only CLI approval prompts exist                                                                                                                                   |

---

## 7. Model-endpoint adapter (BYO endpoint)

1. **Endpoint is caller-supplied configuration**, never discovered; no default host.
2. **Credentials are never persisted** in a task record, log or result. Reuse the existing
   primitives — `BrowserScenarioSecrets` (env reference + redaction), `ProviderDiagnosticRedaction`,
   `IdaDiagnosticRedactor` — rather than inventing a scheme. Setup separately writes provider keys
   into client configurations; that is a distinct, documented surface.
3. **Bounded**: wall clock from `budget.wallClockMs`, response size from `budget.outputBytes`.
4. **Validated before use**: schema, then effects, then verification. Nothing executes from an
   unvalidated response.
5. **Distinct failure classes**: transport, schema, refusal, budget exhaustion.
6. **Testable with a local stub.** No acceptance test may require a live provider or key.

---

## 8. Acceptance tests, corrected for what is testable

| #   | Case                                 | Status today                                                                                                                                                 |
| --- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | two dependency waves                 | exists (`WorkerScheduler.test.ts:52-79`)                                                                                                                     |
| 2   | cycle in `dependsOn`                 | partly: cycle asserted, "nothing runs" is not                                                                                                                |
| 3   | declared write outside authorisation | **not testable** — no effect model yet                                                                                                                       |
| 4   | model response naming a command      | **not testable** until §9.2 is closed                                                                                                                        |
| 5   | malformed body after 200             | process half exists (`ProcessWorker.ts:37-72`); endpoint half needs the stub                                                                                 |
| 6   | wall clock exceeded                  | endpoint half needs the stub; "no surviving orphan" belongs to `ProviderProcess` and is untested                                                             |
| 7   | cancel mid-run                       | partly: cancellation asserted; "no orphan" not expressible                                                                                                   |
| 8   | tier unavailable                     | exists (`SandboxExecution.test.ts:49-62`) — yields `allowed: false`, not `blocked`                                                                           |
| 9   | attempt budget exhausted             | exists, but the arithmetic in §3.3 is the contested one                                                                                                      |
| 10  | operator approves a blocked task     | **structurally impossible today**: the board rejects duplicate ids (`:70-72`) and non-`running` finishes (`:115-121`), so a terminal task cannot be reopened |

---

## 9. Known violations of this contract

| #   | Violation                                                                                                                             | Location                                                       | Status                                                                                                                                                     |
| --- | ------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | L3 admitted on **token length alone**, and the token arrives in the model's own payload, so the tier's only gate was model-controlled | `SandboxCapability.ts:211`                                     | **fixed**: admission requires a `verifyApproval` channel; with none registered, L3 refuses                                                                 |
| 2   | `sandbox_exec` lets the model choose command, tier, `diff_preview` and the token                                                      | `registerExecutionTools.ts:79-108`                             | **fixed**: `diff_preview` is no longer forwarded — L2 needs a `SandboxCommandPreview` this process produced, and no tool schema maps to that type          |
| 3   | Adapter judges exit code — execute and judge in one module                                                                            | `ProcessWorker.ts:138-143`                                     | open: §2 is a target                                                                                                                                       |
| 4   | `blocked` means "no handler / upstream failed", not "not authorised"                                                                  | `WorkerScheduler.ts:266-273,376-383`                           | **fixed**: `WorkerTaskResult.blockedBy` names the cause — `no-handler`, `dependency-failed`, `dependency-blocked`, `dependency-cancelled`, `unauthorised`  |
| 5   | Scheduler records `completed` with empty evidence; the board would reject it                                                          | `WorkerScheduler.ts:284-291` vs `SubagentTaskBoard.ts:123-129` | **fixed**: the scheduler now reports `failed` when a completion cites no evidence, matching `SubagentTaskBoard.finish`                                     |
| 6   | `worker-run.mjs` is build-dependent and untested                                                                                      | `scripts/worker-run.mjs:29-34`                                 | open                                                                                                                                                       |
| 7   | `replanAfterFailure` re-queues `blocked` tasks with no approval, contradicting §5                                                     | `WorkerScheduler.ts:460-477`                                   | **fixed**: the plan re-queues dependency-blocked tasks (correct) and refuses to re-queue `blockedBy: "unauthorised"` unless `resumeBlocked` names the task |

---

## 10. What the independent review changed

Revision 1 declared an `Observer` component that does not exist; redeclared `WorkerTaskSpec` with
incompatible fields, which would have silently renamed an MCP wire field; claimed a "durable task
ledger" that is an in-memory map; attributed sandbox admission to the wrong file; omitted both
`ReActDagPlanner` and the real observer; and asserted invariant 4.1 while `sandbox_exec` was
violating it. Revision 2 corrects each of those and adds §9, so the gap between contract and code
is a recorded fact rather than a surprise for whoever implements it.

The review also found a live security defect behind rule 4.1: L3 admitted a token the model could
invent. That is fixed in `SandboxCapability.ts` with a test that pins the regression.

### 10.1 Attempted and reverted

Making `replanAfterFailure` skip `blocked` tasks looks like a one-line fix and is not one. The
scheduler uses `blocked` for two different facts — "an upstream task failed, so this never ran"
and the contract's "this was never authorised". The first _must_ be re-queued onto the retry
branch; the second must not. Skipping every `blocked` task broke
`WorkerScheduler.test.ts:211` ("re-queues a failed task under a fallback role and rewires
dependents"), which is correct behaviour.

The change was written, the test failed, and the change was reverted rather than papering over it
with a string match on `reason`. Row 7 stays open until `WorkerTaskResult` carries a typed reason
that separates the two cases — which is row 4.

## 11. Non-goals

- Replacing the orchestrator skill or the `agent-orchestrator` workflow.
- Unbounded autonomy: a task never gains effects from a previous task's success.
- Claiming OS-level isolation on a host that cannot provide it. `WSL2` is not a sandbox.
