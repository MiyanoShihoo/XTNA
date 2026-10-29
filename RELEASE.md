# Release readiness — 1.0.0

Snapshot: 2026-10-29. All checks below were run with TEMP/TMP/USERPROFILE/HOME/APPDATA/
LOCALAPPDATA redirected to `E:\deepseek project\XTNA\.tmp-provider`.

## Green

| Check | Command | Result |
|---|---|---|
| Types | `npm run typecheck` | pass |
| Build | `npm run compile` | pass |
| Distribution self-check | `npm run verify:xtna` | 8/8 |
| Gateway protocol | `npm run vault:test` | 12/12 |
| Gateway process-level | `npm run vault:test:e2e` | 6/6 |
| APK audit | `npm run audit:apk -- <apk>` | verified on a 38 MB signed APK |
| PE probes | `inspect-pe-*` | verified on a 5.3 MB 32-bit executable |
| Ghidra | analyze / search / decompile / instructions / procedure_info / call_graph | verified, see `reports/ghidra-verification.md` |
| JavaScript analysis | `analyze-javascript-application` | verified on a Vite build and a self-authored Electron asar |
| Symbol overlay rendering | real Ghidra pseudocode | 1 replacement, evidence hash unchanged |

## Not green / not run

- `npm run check:fast` fails before linting: turbo reports **"Global config path not found"**
  because the redirected, empty HOME has no turbo global config. This is an environment
  artefact of the C:-free run, not a source failure.
- `npm run check:pr` (full suite) has not been executed.
- MCP JSON Schema flattening is deliberately deferred until the full suite can run.
- IDA and Hopper were not exercised on this host.

## Not pushed yet

Seven local commits are waiting for a GitHub token with `repo` + `workflow`:

```
8a831b3 test: verify Electron analysis on a self-authored asar fixture
02c8335 docs: mark the full Ghidra verification set in the roadmap
0d3bd50 docs: procedure info and call graph verified through the MCP session
7e5997d docs: second procedure-info stall and failed call-graph attempt recorded
8fb0c6f docs: record instruction listing as verified, keep procedure-info unverified
45bcfb3 docs: record Ghidra and JavaScript end-to-end verification
b9eb57d feat: single-file offline investigation panel
```

Push command (OpenSSL backend required on this host):

```
git -c http.sslBackend=openssl push https://x-access-token:<TOKEN>@github.com/MiyanoShihoo/XTNA.git main:main
```

Revoke the token immediately after the push.

## Release gate

`0.1.0-beta.1` can be tagged once:

1. the seven commits are pushed and CI is green on the pushed head;
2. one command from `XTNA_CHANGELOG.md`'s verified list is re-run on the release checkout.
