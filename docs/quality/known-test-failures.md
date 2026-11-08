# Known test failures

`known-test-failures.json` records the tests that failed in the suites measured
for a named commit, so a red baseline can be told apart from a new regression.
It says nothing about suites that were not run.

An entry here is a **known failure, not an accepted behaviour**. Nothing in this
file makes a failing test pass, and nothing in it may be used to justify
skipping, deleting or weakening an assertion.

## Why it exists

The repository has a red baseline. Without a record of it, every change has to
prove "I did not break anything" from scratch — by diffing blobs and reasoning
about ancestors. With it, that question becomes a lookup: is this failure in the
ledger, under this commit, with this identity?

## Rules

1. **Only measured data.** A suite appears as `measured` only if it was executed
   for the recorded commit. Everything else is `unverified`, with the reason.
   Counts are never carried forward from an earlier report.
2. **Attribution is conservative.** A failure is attributed only when the
   assertion message, or an inspection, names the cause. The default is
   `under-investigation`.
3. **Identities are stable.** `id` never changes once issued. Closing an entry
   means deleting it in the commit that fixes it, so the ledger always describes
   the current commit.
4. **No green by subtraction.** Removing an entry requires the test to pass.
   Marking it `stale-fixture` does not remove it; it is still a failure.

## Attribution values

| Value                 | Meaning                                                                  |
| --------------------- | ------------------------------------------------------------------------ |
| `confirmed-defect`    | A real product or harness defect, reproduced and understood.             |
| `stale-fixture`       | The fixture predates a product change; the product behaves as designed.  |
| `platform-difference` | Behaviour differs by host platform and the test does not account for it. |
| `under-investigation` | Observed, not yet attributed. Default state.                             |

## Current state

See the `suites` block of the JSON for what was measured for this commit and
what was not. As of the `2263e75` baseline:

- `domain` is measured and green, and is the only suite wired into CI.
- `conformance` is measured and red by one harness defect.
- `acceptance/setup` is measured and red.
- The wider acceptance, the boundary projects and the remaining source projects
  are **unverified** and must not be quoted as current.

## Adding a suite to CI

A suite may only enter CI once it has a measured, attributed baseline here.
Wiring a red suite into CI without that baseline turns a signal into noise and
trains everyone to ignore the check.
