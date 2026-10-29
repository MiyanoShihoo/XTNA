# Overlay live render verification — 2026-10-29

Artifact: `PlantsVsZombies.exe` (5,296,312 bytes)
SHA-256: `868f8e2bab0d6a7ef8afc4c5960c608eccef82bd086bd6e0c0e2670199a5ca45`

## Toolchain

Installed under `E:\xtna-verify` for this verification only; nothing in the distribution,
the repository or the user configuration depends on those paths.

| Tool | Version |
|---|---|
| Ghidra | 12.2 PUBLIC (`ghidra_12.2_PUBLIC`, reports `12.2`, accepted by the provider version check) |
| JDK | Temurin 25.0.5+8 (`jdk-25.0.5+8`, 64-bit full JDK) |

## Command

```bash
npm run overlay:render -- \
  --binary 868f8e2bab0d6a7ef8afc4c5960c608eccef82bd086bd6e0c0e2670199a5ca45 \
  --procedure 0x40100b \
  --path "E:\SteamLibrary\steamapps\common\Plants Vs Zombies\PlantsVsZombies.exe" \
  --provider ghidra
```

Overlay: `.verify/overlays/868f8e2b….json`, 3 entries.

## Result

| Field | Value |
|---|---|
| exit status | 0 |
| stderr | empty |
| rendered strings | 1 |
| identifier replacements | 1 |
| replacement | `FUN_0040100b` → `scalar_deleting_destructor_candidate` |
| section | `normalized_result` |

Rendered text came from a fresh `decompile 0x40100b` through the CLI entry point; the analysis
document was not modified.

## Error path

The same command with no provider configured exits 1 and prints the CLI's own error document
(`provider_unavailable`) instead of reporting "0 replacements".

## Limits

- One procedure on one binary; no batch run.
- The CLI's `function` command still stalls when batched, as recorded in
  `reports/ghidra-verification.md`; the live path uses `decompile` only.
- Rendering is display-only: stored Evidence and MCP tool results keep the decompiler's names.
