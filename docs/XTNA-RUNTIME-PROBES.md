# Runtime probe generation

`npm run probe:gen -- --address <0x…|symbol>` turns one static address into a runnable
dynamic-probe skeleton for Frida or LLDB.

## Why

Static analysis stops where values start: dynamic dispatch, encrypted strings and state
machines only reveal themselves at runtime. Writing the same hook by hand for every candidate
function wastes the analyst's time, so the generator emits the boilerplate and leaves the
judgement.

## Usage

```bash
# Frida: hook an address, record 2 argument slots and a 2-frame backtrace
npm run probe:gen -- --provider frida --address 0x40100b --args 2 --frames 2 \
  --symbol parseOrder --out probe.js

# LLDB: create a breakpoint and emit the same JSON contract
npm run probe:gen -- --provider lldb --address 0x40100b --out probe.py
```

| Flag                        | Meaning                                           |
| --------------------------- | ------------------------------------------------- |
| `--address` / `--procedure` | address or symbol the probe hooks                 |
| `--provider`                | `frida` (default) or `lldb`                       |
| `--module`                  | resolve the address relative to a loaded module   |
| `--args`                    | integer argument slots to record, 0–8 (default 4) |
| `--frames`                  | caller frames captured, 0–16 (default 4)          |
| `--symbol`                  | readable label used in the emitted JSON           |
| `--out`                     | write to a file instead of stdout                 |

## Output contract

Both providers emit one JSON object per event on stdout:

```json
{"event":"enter","target":"parseOrder","thread":1234,"args":[...],"backtrace":[...]}
{"event":"leave","target":"parseOrder","thread":1234,"retval":0}
```

Arguments are read from the ABI registers (`x0`–`x7` on arm64, `rdi`/`rsi`/… on x64); a
register that does not exist reads as `undefined`, so one script covers both architectures.

## What it will not do

- Launch, attach to, or patch anything. The analyst runs the script in a controlled session.
- Choose the target for you. The address comes from a static observation you already trust.
- Decode pointer arguments, structs or strings. It records register values; interpretation is
  the next step and it belongs to evidence, not to the skeleton.

## Limits

- Frida and LLDB are caller-supplied; the generator never installs them.
- Only integer argument slots are captured. Floating-point and vector arguments need edits.
- The LLDB variant records register names rather than values; pair it with an expression or a
  later `frame.GetRegisters()` read before trusting the numbers.
- Generated probes are text: review them before running against any target.
