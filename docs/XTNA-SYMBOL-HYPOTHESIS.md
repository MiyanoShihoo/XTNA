# Evidence-backed symbol hypotheses

`npm run symbol:hypothesis -- <command>` stores analyst-proposed names separately from
Evidence. Each entry names the exact target digest, address, rationale, and supporting
Evidence records; it never rewrites a provider observation.

## Commands

```bash
# Add a hypothesis. At least one --evidence is required.
npm run symbol:hypothesis -- add \
  --binary ./target.exe \
  --address 0x401000 \
  --name parseOrderPayload \
  --rationale "Parser consumes order fields at this call site" \
  --evidence ev_0123abcd

npm run symbol:hypothesis -- list --binary ./target.exe
npm run symbol:hypothesis -- list --binary ./target.exe --json

npm run symbol:hypothesis -- export --binary ./target.exe --format ghidra --out apply.txt
npm run symbol:hypothesis -- export --binary ./target.exe --format vscode
```

`--binary` accepts a path or a lowercase SHA-256 digest. The store is keyed by the digest,
so an overlay cannot silently attach to another build of the same filename.

## Guarantees and limits

- An empty name, malformed address, duplicate evidence ID, missing rationale, or missing
  Evidence is rejected with a typed validation result.
- A second entry at the same normalized target/address is rejected as a conflict.
- Entries are sorted by numeric address for stable render and export output.
- The store is a hypothesis layer, not proof. Nothing here upgrades `inferred` into
  `observed`; the original Evidence remains authoritative.
- The store lives at `symbols.json` under `XTNA_SYMBOL_HYPOTHESIS_DIR`
  (default `~/.xtna/symbol-hypotheses`).
