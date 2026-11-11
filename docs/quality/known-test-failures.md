# Known test failures

`known-test-failures.json` keeps an immutable historical baseline separate from the latest measured code snapshot. The active failure list is `current_snapshot.entries`; `baseline.entries` preserves the historical record and must not be treated as current. A listed failure is known, not accepted behaviour, and nothing here justifies skipping, deleting or weakening an assertion.

## Why it exists

The repository has a red baseline. Recording the exact commit and measured scope distinguishes an inherited failure from a new regression. The file says nothing about tests that were not run, except to label their scope `unverified`.

## Rules

1. **Only measured data.** A suite is `measured` only when it was executed for `current_snapshot.measured_commit`. Partial runs name their exact files and counts; they never imply that the rest of a Vitest project passed. Everything else is `unverified`, with the reason. Counts are never carried forward.
2. **Attribution is conservative.** Attribute a failure only when its assertion or an investigation supports the cause. Otherwise use `under-investigation`. Matching a historical title is evidence of recurrence, not proof of a cause.
3. **Identities are stable.** An issued failure ID never changes. A fixed failure is removed from the active `current_snapshot.entries` only after its test passes on the fixing code commit; `current_snapshot.closed_ids` records that evidence. Historical baseline entries remain unchanged.
4. **No green by subtraction.** Removing an active entry requires the corresponding test to pass. Marking it `stale-fixture` does not remove it; it remains an open failure.
5. **Avoid commit-SHA self-reference.** Run tests on a code commit C, then use a ledger-only follow-up commit L to record the complete measurements with `current_snapshot.measured_commit=C`. L is not claimed to have been measured. If source or test code changes after C, invalidate the current snapshot and rerun the affected measurements before updating it.

## Attribution values

| Value                 | Meaning                                                                      |
| --------------------- | ---------------------------------------------------------------------------- |
| `confirmed-defect`    | A real product or harness defect, reproduced and understood.                 |
| `stale-fixture`       | The test fixture predates a product change; the product behaves as designed. |
| `platform-difference` | Behaviour differs by host platform and the test does not account for it.     |
| `under-investigation` | Observed, not yet attributed. Default state.                                 |

## Current state

Read `current_snapshot.suites` in the JSON for the exact code commit, environment and test scope. The current snapshot records:

- `domain`: measured and green; 8,820 passed, 3 skipped.
- `conformance`: measured and green; 410 passed.
- `acceptance/setup`: measured; 12 failures remain.
- `boundary`: only `tests/boundary/filesystem/clientLifecycle.test.ts` is measured (partial): 41 passed, 24 failed. The 24 failing titles match the independent clean `2fc18af` baseline run; the remaining boundary files are unverified, and matching titles do not determine attribution.
- The wider acceptance project and remaining source projects are unverified.
- Remote CI was not run for this feature-branch snapshot. The workflow runs on pull requests and pushes to `main`; a feature-branch push alone does not trigger it.

The immutable `baseline` object preserves the original `2263e75` counts and failure entries. Do not subtract closed failures from that historical record or quote it as the current state.

## Adding a suite to CI

A suite may only enter CI once it has a measured, attributed baseline here. Wiring a red suite into CI without that baseline turns a signal into noise and trains everyone to ignore the check.
