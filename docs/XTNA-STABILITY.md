# Stability smoke

`npm run stability:smoke` generates its own fixtures, runs every analysis utility as a real
child process, and fails if one exits non-zero or stops producing its promised output.

## Why

Unit tests prove a function; they do not prove that the CLI still wires it up. The utilities
added for the 1.x line each have a small surface but a long chain — argument parsing, a
compiled `dist/` import, a temporary directory, a JSON contract. A single renamed export breaks
all of that while every unit test stays green.

## What it covers

| Utility          | Fixture                                          | Assertion                                      |
| ---------------- | ------------------------------------------------ | ---------------------------------------------- |
| `ast:normalize`  | minified JS with `!0`, `60*1000`, a literal `if` | folds are reported                             |
| `sdk:gen`        | HAR with one GET and one POST                    | two operations emitted                         |
| `mock:gen`       | the same HAR                                     | CRUD routes present in the generated server    |
| `probe:gen`      | an address                                       | file written and contains `Interceptor.attach` |
| `heap:query`     | synthetic `.heapsnapshot`                        | exact-name lookup returns the seeded node      |
| `trace:causal`   | browser + IPC streams                            | chains are reported                            |
| `wasm:link`      | hand-built module + glue                         | the `add` export edge is found                 |
| `overlay:render` | overlay store + evidence bundle                  | one identifier replacement                     |

The harness cleans its temporary directory on success and on failure, and prints one line per
utility plus a `n/m utilities healthy` summary.

## When to run it

- Before a release.
- After touching `scripts/*.mjs` or an `src/application/*` module that a script imports through
  `dist/`.
- In CI once a Node job exists; today the workflow only proves compile and distribution
  identity.

## Limits

- It proves the happy path, not correctness: an assertion checks a marker, not a full diff.
- Fixtures are synthetic and deliberately tiny; they do not exercise large inputs.
- It needs a built `dist/` (`npm run compile`), exactly like the utilities themselves.
