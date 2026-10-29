# Symbol overlay

`npm run overlay -- <command>` keeps analyst-proposed names, types and comments **outside**
the evidence ledger, keyed by the exact binary digest. Nothing is rewritten in place: the
overlay is a projection that can be exported into Ghidra or IDA and regenerated at will.

## Why a separate layer

Evidence must stay verifiable. A rename is an inference, not an observation, so it belongs in
its own store with its own confidence label, and the original decompiler output keeps its
integrity.

## Commands

```bash
# name a function you identified
npm run overlay -- add \
  --binary ./target.exe \
  --address 0x401000 \
  --name WinMain_candidate \
  --kind function \
  --confidence inferred \
  --comment "entry candidate from PE header" \
  --evidence ev_0123abcd

# name a recovered data structure
npm run overlay -- add \
  --binary ./target.exe \
  --address 0x40A1B0 \
  --name g_pak_loader \
  --kind data \
  --type "PakLoader*" \
  --confidence guessed

# inspect
npm run overlay -- list --binary ./target.exe
npm run overlay -- list --binary ./target.exe --json

# export for the tool you are working in
npm run overlay -- export --binary ./target.exe --format ghidra --out apply.py
npm run overlay -- export --binary ./target.exe --format ida --out apply.idc

# housekeeping
npm run overlay -- remove --binary ./target.exe --id sym_1a2b3c4d5e6f7788
npm run overlay -- overlays
```

`--binary` accepts a path or an already-computed SHA-256 digest. Storing by digest means an
overlay cannot silently attach to a different build of the same filename.

## Entry fields

| Field | Meaning |
|---|---|
| `address_hex` / `address` | exact virtual address, hex and decimal |
| `name` | proposed symbol |
| `kind` | `function`, `data`, `struct`, `field`, `label`, `import` |
| `type` | optional C-like type or signature text |
| `comment` | optional plate comment |
| `confidence` | `observed`, `inferred` or `guessed` — never collapsed |
| `evidence_ids` | Evidence records that motivated the proposal |
| `created_at` | when the entry first appeared |

Entry identity is `sym_<hash>` over `(binary digest, address, name)`, so re-adding the same
symbol updates it instead of duplicating.

## Exported scripts

- **Ghidra**: a Python script using `SourceType.USER_DEFINED`; functions are created when no
  function exists at the address.
- **IDA**: `MakeName` / `MakeComm` calls.

Both are rename-only. Neither modifies bytes, and both can be re-run safely.

## Rendering analysis text

Two sources feed the same renderer:

```bash
# an Evidence bundle you already exported
npm run overlay:render -- --binary ./target.exe --evidence bundle.json --out rendered.md

# a fresh decompile, without exporting a bundle first
npm run overlay:render -- --binary ./target.exe --procedure 0x40100b --provider ghidra
```

It rewrites address-derived identifiers (`sub_401000`, `FUN_401000`, `nullsub_*`, `loc_*`) in a
copy of pseudocode or disassembly text, writes Markdown, and states how many replacements it made.
The evidence bundle on disk stays byte-identical; nothing is written back to Evidence.

Live mode runs `decompile` through the CLI entry point and renders the JSON it prints, so it
needs a configured provider. File mode needs only the bundle.

## Limits

- The overlay is a display projection. Stored Evidence and MCP tool results keep the
  decompiler's own names; render the text, or export the overlay into Ghidra/IDA.
- No automatic type inference: `type` is whatever the analyst writes.
- Confidence is a label, not a proof; nothing here upgrades a guess into an observation.

## Environment

| Variable | Default | Effect |
|---|---|---|
| `XTNA_OVERLAY_DIR` | `~/.xtna/overlays` | where per-binary overlay files live |
