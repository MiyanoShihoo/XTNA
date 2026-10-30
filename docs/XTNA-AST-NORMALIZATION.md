# AST normalization

`npm run ast:normalize -- --in <file> [--out <file>]` folds literals and collapses
literal-tested branches in minified JavaScript before the code reaches an agent's context.

## Why

A minified bundle spends context on `!0`, `"a" + "b"`, `60 * 1000` and
`if (false) { … } else { … }`. None of that carries meaning, and every token spent on it is a
token the model cannot spend on the code that does.

## Rules

| Rule                              | Example                                          |
| --------------------------------- | ------------------------------------------------ |
| Unary literal folding             | `!0` → `true`, `~0` → `-1`                       |
| Arithmetic and comparison folding | `60 * 1000` → `60000`, `1 < 2` → `true`          |
| String concatenation              | `"ab" + "cd"` → `"abcd"`                         |
| String decoding                   | `"\x41\u4f60"` → `"A你"`                         |
| Literal `if` collapse             | `if (false) { a() } else { b() }` → `{ b() }`    |
| Literal conditional               | `true ? 1 : 2` → `1`                             |
| Short-circuit                     | `false && f()` → `false`, `0 \|\| g()` → `g()`   |
| Immutable `const` propagation     | `const t = 60; t * 1000` → `const t = 60; 60000` |

## What it will not do

- Evaluate calls, getters, member reads or arbitrary identifiers. Folding requires literal
  operands or an immutable top-level `const` binding.
- Propagate a name that is reassigned, shadowed, declared more than once, or read before its
  declaration.
- Reorder or remove code with side effects: a collapsed branch is the branch the literal test
  could actually reach.
- Pretty-print. Untouched ranges keep their original bytes, so the diff stays reviewable.
- Write back to the input. `--out` is a separate path; without it the result goes to stdout.

## Output

```bash
npm run ast:normalize -- --in vendor.min.js --out vendor.normalized.js
npm run ast:normalize -- --in vendor.min.js --max-passes 4 --json
```

`--json` reports `input_bytes`, `output_bytes`, `foldedConstants`, `removedBranches`,
`decodedStrings`, the number of rewrite passes, source-located `observations`, `unknowns`,
`coverage`, and the effective `limits`.

## Limits

- TypeScript and JSX syntax parse, but only JavaScript expressions are folded.
- Propagation is limited to top-level immutable `const` literals; cross-function analysis is
  not attempted.
- Deobfuscation of `eval`-built strings or VM-style dispatch is out of scope.
- The transform is textual after parsing, so re-parse the output before trusting it for
  anything but reading.
- Defaults: 4 MiB source, 8 MiB output, 4 rewrite passes, 200,000 AST nodes, and 1,000 retained
  observations. Exceeding a bound returns a typed error or an explicit `partial` coverage
  unknown; it does not silently claim completeness.
