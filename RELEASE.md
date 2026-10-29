# Release readiness — 1.0.0

Snapshot: 2026-10-29. Published on `main` at `MiyanoShihoo/XTNA`.

## Published

| Item | Value |
|---|---|
| Version | 1.0.0 (`package.json`, `package-lock.json`, `gateway/package.json`, generated metadata, Windows native manifest) |
| Head | `7ec857b` — single README with English and Chinese sections and anchor links |
| Remote version | `1.0.0`, confirmed from `raw.githubusercontent.com` |
| CI | success on `80259ae` and `7ec857b` |

## Green

| Check | Command | Result |
|---|---|---|
| Types | `npm run typecheck` | 0 |
| Lint | `npm run lint:details` | 0 errors, 2,966 pre-existing warnings |
| Module boundaries | `npm run verify:module-boundaries` | 3,269 source files |
| Package metadata | `npm run metadata:check` | pass |
| Build | `npm run compile` | pass |
| Distribution self-check | `npm run verify:xtna` | 8/8 |
| Gateway protocol | `npm run vault:test` | 12/12 |
| Gateway process-level | `npm run vault:test:e2e` | 6/6 |
| APK audit | `npm run audit:apk -- <apk>` | verified on a 38 MB signed APK |
| PE probes | `inspect-pe-*` | verified on a 5.3 MB 32-bit executable |
| Ghidra | analyze / search / decompile / instructions / procedure_info / call_graph | verified, see `reports/ghidra-verification.md` |
| JavaScript analysis | `analyze-javascript-application` | verified on a Vite build and a self-authored Electron asar |
| Symbol overlay rendering | real Ghidra pseudocode | 1 replacement, evidence hash unchanged |

## Environment notes

- `turbo` 2.11.7 needs a resolvable global config. The empty, redirected `HOME` used by the
  C:-free run produced *"Global config path not found"*; that is an artefact of the redirect,
  not a source failure. With a normal `USERPROFILE` the task graph runs.
- `scripts/ci/static-check-report.mjs` spawns its child with piped stdio. A process sandbox
  that forbids pipe creation fails it with `spawnSync … EPERM` before any linting starts.
  Run `npm run typecheck` and `npm run lint:details` directly in such a session; both pass.

## Not run

- `npm run check:pr` (the complete local gate, including Vitest).
- IDA and Hopper providers.
- A real vendor Electron application — only the self-authored asar was analysed.

## Docs checks

- `node scripts/check-doc-facts.mjs` passes. The README carries the `MCP-tool_catalog` badge and
  the installation / registry / catalog links; the 23 stale upstream translations under
  `docs/readme/` are gone, and `website/locales/languages.json` lists only the shipped edition.
- `node scripts/generate-skill-metadata.mjs --check` and
  `node scripts/generate-product-catalog.mjs --check` pass after one generation run; both
  outputs are gitignored.
- `generate-completion-ledger.mjs` and the Vitest conformance suite cannot run in this session:
  both spawn children with piped stdio, which the process sandbox refuses (`EPERM`).
- `npm run format:check` (`oxfmt --check .`) exits 2 on this host even on a pristine tree.
  Markdown edits were matched to the surrounding file style by hand instead.

## Release gate

Tag `1.0.0` on the head that contains this file. Before tagging, re-run one command from the
verified list above on the release checkout, per `XTNA_CHANGELOG.md`.
