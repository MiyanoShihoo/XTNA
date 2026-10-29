# Ghidra provider verification — 2026-10-29

Binary: PlantsVsZombies.exe (5,296,312 bytes)
SHA-256: 868f8e2bab0d6a7ef8afc4c5960c608eccef82bd086bd6e0c0e2670199a5ca45

All runs used E-drive-only temp, HOME, APPDATA and LOCALAPPDATA redirection:
E:\deepseek project\XTNA\.tmp-provider. Nothing was written to C:.

## Verified

| Operation | Result | Wall time | Evidence |
|---|---|---:|---|
| analyze --provider ghidra | ok | 197 s | document, segments, procedure_count = 7516, string_count |
| search --kind procedures | ok | ~3 min | 7516 entries, 7259 internal addresses |
| decompile 0x40100b | ok | ~3 min | real pseudocode (below) |
| overlay add + overlay:render | ok | <1 s | 1 replacement; evidence SHA-256 unchanged (be50fccfe374235c62b335ab7d54b1dd499b78ec64535fa7479826e94dc35b1a) |

### Real pseudocode (Ghidra 12.2)

    void FUN_0040100b(byte param_1)
    {
      undefined4 *in_ECX;
      *in_ECX = std::bad_alloc::vftable;
      FUN_004e16bb();
      if ((param_1 & 1) != 0) {
        /* WARNING: Subroutine does not return */
        _free(in_ECX);
      }
      return;
    }

### Overlay rendering on that text

Entry: 0x40100b -> scalar_deleting_destructor_candidate (confidence: inferred).

Rendered header: overlay entries 3, rendered strings 1, identifier replacements 1.
FUN_0040100b became scalar_deleting_destructor_candidate; the evidence bundle on disk kept
the same SHA-256 (be50fccfe374235c62b335ab7d54b1dd499b78ec64535fa7479826e94dc35b1a).

## Instructions (verified on a second attempt)

`instructions 0x40100b` succeeded when run alone in its own process:

- procedure `FUN_0040100b`, body ranges `0x40100b-0x401025` and `0x401027-0x40102c`
- `total_bytes=33`, `span_bytes=34`, `non_contiguous=true`, `contains_entry=true`
- 10 instructions returned:

```
0x40100b: PUSH ESI
0x40100c: MOV ESI, ECX
0x40100e: MOV dword ptr [ESI], 0x52380c
0x401014: CALL 0x004e16bb
0x401019: TEST byte ptr [ESP + 0x8], 0x1
0x40101e: JZ 0x00401027
0x401020: PUSH ESI
0x401021: CALL 0x004e2978
0x401027: MOV EAX, ESI
0x401029: POP ESI
0x40102a: RET 0x4
```

The first attempt, which ran `function` and `instructions` in one background job, stalled for
over 20 minutes with ~48 s of CPU. Running one command per process is what made it work.

## Still unverified

`function` was retried twice, each time alone in its own process:

- `0x40100b`: ~15 min, CPU 37 s → 80 s, no output, cancelled
- `0x40102d`: ~15 min, CPU 16 s → 52 s, no output, cancelled

The command never returns for this binary. Two different addresses rule out a single bad
function; the pattern is a wait, not computation.

A call-graph attempt over a persistent MCP session (`open_binary` then `get_call_graph`)
returned a tool-level error during `open_binary` in 23 ms. The captured log was truncated by the
host shell, so the error code is not recorded here; the attempt produced no call-graph evidence.

## Verdict

Verified: analysis open, procedure inventory (7,516), real decompilation, instruction listing.
Unverified: procedure-info payload and call-graph traversal. Ghidra CLI calls must run one per
process; `function` is unusable on this target.