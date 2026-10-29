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

## Not verified — and why

function 0x40100b and instructions 0x40100b were started together in one background run.
The JVM stayed alive for over 20 minutes, held ~860 MB RSS, and accumulated only ~48 s of CPU:
it was waiting, not working. The run was cancelled and the JVM was stopped. No evidence was
produced for either command, so they stay unverified.

analyze, search and decompile on the same binary complete in ~3 minutes each, so this is
specific to those two commands, not to the provider as a whole.

## Verdict

The Ghidra provider is verified for: analysis open, procedure inventory, and real decompilation.
It is not verified for procedure-info, instruction listing, or call-graph traversal on this
binary. Those need a fresh attempt with a shorter per-command budget and one command per process.
