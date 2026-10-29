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

## Procedure info and call graph (MCP session)

The CLI `function` command stalls, but the same data is reachable through the MCP server.
A persistent session was driven with `initialize` → `open_binary` → tool call:

```
procedure_info {"procedure":"0x40100b"}
  name            FUN_0040100b
  entrypoint      0x40100b
  basicblock_count 3
  length          33
  signature       undefined FUN_0040100b()
  locals          []
  classification  function, not external, not thunk
  body            0x40100b-0x401025 + 0x401027-0x40102c, non_contiguous

get_call_graph {"address":"0x40100b","direction":"forward","detail":"summary"}
  normalized_result.summary.observations = 97
```

`open_binary` returns the artifact identity immediately and analysis starts on the first tool call
that needs it (~3 minutes for this 5.3 MB PE).

## CLI caveat

`function` via the CLI was retried twice on two different addresses and stalled both times
(>15 min, CPU 37→80 s and 16→52 s, no output). Use the MCP tool path for procedure info; do not
batch Ghidra CLI calls.

## Verdict

Verified on this binary: analysis open, procedure inventory (7,516), real decompilation,
instruction listing, procedure info, and a forward call-graph traversal.