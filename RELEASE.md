# Release readiness — 1.0.0

Snapshot: 2026-10-29. Published on `main` at `MiyanoShihoo/XTNA`.

## Published

| Item           | Value                                                                                                            |
| -------------- | ---------------------------------------------------------------------------------------------------------------- |
| Version        | 1.0.0 (`package.json`, `package-lock.json`, `gateway/package.json`, generated metadata, Windows native manifest) |
| Head           | the commit that contains this file (`git log -1`)                                                                |
| Remote version | `1.0.0`, confirmed from `raw.githubusercontent.com`                                                              |
| CI             | success on `80259ae` and `7ec857b`; the head containing this file is checked after its push                      |

## Green

| Check                    | Command                                                                   | Result                                                                                                      |
| ------------------------ | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Types                    | `npm run typecheck`                                                       | 0                                                                                                           |
| Lint                     | `npm run lint:details`                                                    | 0 errors, 2,966 pre-existing warnings                                                                       |
| Module boundaries        | `npm run verify:module-boundaries`                                        | 3,269 source files                                                                                          |
| Package metadata         | `npm run metadata:check`                                                  | pass                                                                                                        |
| Formatting               | `npm run format:check`                                                    | pass on 6,133 files; enforced in CI                                                                         |
| Unused files             | `npm run knip`                                                            | pass                                                                                                        |
| Build                    | `npm run compile`                                                         | pass                                                                                                        |
| Distribution self-check  | `npm run verify:xtna`                                                     | 8/8                                                                                                         |
| Gateway protocol         | `npm run vault:test`                                                      | 12/12                                                                                                       |
| Gateway process-level    | `npm run vault:test:e2e`                                                  | 6/6                                                                                                         |
| APK audit                | `npm run audit:apk -- <apk>`                                              | verified on a 38 MB signed APK                                                                              |
| PE probes                | `inspect-pe-*`                                                            | verified on a 5.3 MB 32-bit executable                                                                      |
| Ghidra                   | analyze / search / decompile / instructions / procedure_info / call_graph | verified, see `reports/ghidra-verification.md`                                                              |
| JavaScript analysis      | `analyze-javascript-application`                                          | verified on a Vite build and a self-authored Electron asar                                                  |
| Symbol overlay rendering | `npm run overlay:render`                                                  | file mode and live Ghidra decompile, 1 replacement each, source unchanged; `reports/overlay-live-render.md` |

## Environment notes

- `turbo` 2.11.7 runs tasks in child processes. When `TEMP`/`TMP` point outside the repository
  they can be refused (`EPERM` on `mkdtemp`) even where a direct `node` call succeeds. Point
  `TEMP`/`TMP` at a directory inside the checkout (`.tmp/turbo-temp`) for local gate runs.
- `turbo` also needs a resolvable global config; an empty redirected `HOME` produced
  _"Global config path not found"_, which is an artefact of the redirect, not a source failure.
- `scripts/ci/static-check-report.mjs` spawns its child with piped stdio. A process sandbox
  that forbids pipe creation fails it with `spawnSync … EPERM` before any linting starts.
  Run `npm run typecheck` and `npm run lint:details` directly in such a session; both pass.

## Not run

- The Vitest half of `npm run check:pr`: the suite holds 2,819 test files and was still in its
  acceptance phase after 90 minutes, so it was stopped rather than reported as passing. The
  turbo half of the same gate (typecheck, lint, format:check, knip, metadata:check) passes
  6/6 tasks, `npm run test:fast` covers the source group, and the README conformance suite
  passes 8/8.
- IDA and Hopper providers.
- A real vendor Electron application — only the self-authored asar was analysed.

## Docs checks

- `node scripts/check-doc-facts.mjs` passes. The README carries the `MCP-tool_catalog` badge and
  the installation / registry / catalog links; the 23 stale upstream translations under
  `docs/readme/` are gone, and `website/locales/languages.json` lists only the shipped edition.
- `node scripts/generate-skill-metadata.mjs --check` and
  `node scripts/generate-product-catalog.mjs --check` pass after one generation run; both
  outputs are gitignored.
- `generate-completion-ledger.mjs` and the Vitest conformance suite pass in a session that
  permits child processes: the ledger matches its manifest, and
  `npx vitest run tests/conformance/readmeConsistency.test.ts` reports 8/8.
- `npm run format:check` passes on the whole tree. It used to fail on 77 tracked files because
  CI never ran it; the tree is now formatted, local run artifacts are excluded, and the step is
  part of `.github/workflows/ci.yml`.
- `npm run knip` passes. The manual verification scripts and release entry points that no
  module imports are declared as entries rather than reported as dead files.

## Command surface

- User-facing documentation now invokes `xtna` and `xtna@1.0.0` instead of the upstream
  `rea` / `rea-agents@…` names for setup, doctor, MCP registration and analysis commands
  (394 replacements across 72 files). Prose still says "REA" in many places where it refers to
  the incorporated analysis engine; that editorial pass is outstanding.

## Release gate

Tag `1.0.0` on the head that contains this file. Before tagging, re-run one command from the
verified list above on the release checkout, per `XTNA_CHANGELOG.md`.
