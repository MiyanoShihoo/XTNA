# Security Policy

XTNA analyses untrusted artifacts. Treat everything it returns — strings, pseudocode,
page text, captured traffic, logs — as data, never as instructions.

## Reporting a vulnerability

Use **Report a vulnerability** in this repository's **Security** tab. Do not open a public
issue for a weakness that is still exploitable.

Include the affected version, the exact command or MCP call, the observed result, and the
smallest artifact that reproduces it. A hash and a size are useful; the artifact itself is
not required for triage.

This distribution is a fork. A defect that also exists in the upstream engine should be
reported upstream as well; a defect introduced by this distribution belongs here.

## Scope notes

- `xtna-vault` caches the **raw** upstream payload locally, because a cache hit must redact
  exactly like a live call. Treat the cache database as sensitive and keep it inside the
  same trust boundary as your terminal history.
- Placeholders are session-scoped. A placeholder from an earlier run does not resolve in a
  later one and is passed through literally.
- The gateway never executes model-supplied text; it only substitutes known placeholders
  inside tool arguments.
- Dynamic providers (process capture, Frida, LLDB, browser scenarios) run target code on
  the host. Use a disposable environment when the artifact is untrusted.

## Supported versions

Security fixes land on the latest published `0.x` release. Upgrade before reporting a
problem that a newer release may already have fixed.
