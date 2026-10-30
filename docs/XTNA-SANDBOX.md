# Sandbox capability and command admission

`npm run sandbox:probe -- [--json] [--tier L1|L2|L3] [--diff-preview] [--approval-token <token>]`
reports which isolation backends exist on this host and decides whether a command tier may run.

XTNA does not ship a sandbox. This slice exists so the tool can never call a command
"sandboxed" when nothing isolates it.

## Probes

Every probe is bounded to five seconds and records its own failure:

| Backend         | Probe                                             | Isolation                |
| --------------- | ------------------------------------------------- | ------------------------ |
| Docker          | `docker version --format {{.Server.Version}}`     | container                |
| Podman          | `podman info --format {{.Version}}`               | container                |
| WSL2            | `wsl.exe --status` (Windows only)                 | vm                       |
| Windows Sandbox | `%SystemRoot%\System32\WindowsSandbox.exe` exists | vm, **interactive only** |

Windows Sandbox runs a desktop, not a command line, so it is listed but never raises the
best executable isolation.

## Admission

| Tier | Rule                                                                      |
| ---- | ------------------------------------------------------------------------- |
| L1   | read-only; runs in the current process                                    |
| L2   | needs a container or VM backend **and** `--diff-preview`                  |
| L3   | needs the same backend **and** an approval token of at least 8 characters |

A refusal exits `4` and names the missing capability. This is the point: no backend means no
L2/L3, even when the caller asks politely.

## What it does not do

- It does not start a container, create a Windows Sandbox, or run the command inside one. The
  probe answers "what exists"; execution inside that boundary is a later slice.
- It does not infer isolation from a configured name. A backend that does not answer is absent.
- It does not treat Windows Sandbox as a command runner.
