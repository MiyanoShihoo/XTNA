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

## Execution adapter (L2/L3)

`npm run sandbox:run -- --image <image> --tier L2|L3 [--diff-preview] [--approval-token token] -- <command> [args...]`
turns an admitted request into a Docker/Podman `run` argv array and executes it only when a
container backend answered the probe. It refuses without a backend; there is no host fallback.

The invocation is argv-only (no shell), disables the network, mounts the selected `--cwd` at
`/work:ro`, drops capabilities, sets `no-new-privileges`, limits pids/memory/cpus and uses `--rm`.
The backend process remains a separate owned command; admission is still owned by
`SandboxCapability`.

## What it does not do

- It does not implement a Windows Sandbox command runner; Windows Sandbox is interactive-only.
- It does not treat WSL2 as a command sandbox even when `wsl --status` answers.
- It does not infer isolation from a configured name. A backend that does not answer is absent.
- It does not claim the Docker path was verified on a host where Docker daemon is absent.
