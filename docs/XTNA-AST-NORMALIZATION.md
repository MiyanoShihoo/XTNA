# AST normalization

`npm run ast:normalize -- --in <file> [--out <file>]` folds literals and collapses
literal-tested branches in minified JavaScript before the code reaches an agent's context.

## Why

A minified bundle spends context on `!0`, `"a" + "b"`, `60 * 1000` and
`if (false) { … } else { … }`. None of that carries meaning, and every token spent on it is a
token the model cannot spend on the code that does.

## Rules

| Rule                              | Example                                        |
| --------------------------------- | ---------------------------------------------- |
| Unary literal folding             | `!0` → `true`, `~0` → `-1`                     |
| Arithmetic and comparison folding | `60 * 1000` → `60000`, `1 < 2` → `true`        |
| String concatenation              | `"ab" + "cd"` → `"abcd"`                       |
| String decoding                   | `"\x41\u4f60"` → `"A你"`                       |
| Literal `if` collapse             | `if (false) { a() } else { b() }` → `{ b() }`  |
| Literal conditional               | `true ? 1 : 2` → `1`                           |
| Short-circuit                     | `false && f()` → `false`, `0 \|\| g()` → `g()` |

## What it will not do

- Evaluate calls, getters, member reads or identifiers. Every rule requires literal operands.
- Reorder or remove code with side effects: a collapsed branch is the branch the literal test
  could actually reach.
- Pretty-print. Untouched ranges keep their original bytes, so the diff stays reviewable.
- Write back to the input. `--out` is a separate path; without it the result goes to stdout.

## Output

```bash
npm run ast:normalize -- --in vendor.min.js --out vendor.normalized.js
npm run ast:normalize -- --in vendor.min.js --json
```

`--json` reports `input_bytes`, `output_bytes`, `foldedConstants`, `removedBranches`,
`decodedStrings` and the number of rewrite passes.

## Limits

- TypeScript and JSX syntax parse, but only JavaScript expressions are folded.
- Constant propagation across variables is not attempted: `const t = 60; t * 1000` stays.
- Deobfuscation of `eval`-built strings or VM-style dispatch is out of scope.
- The transform is textual after parsing, so re-parse the output before trusting it for
  anything but reading.
