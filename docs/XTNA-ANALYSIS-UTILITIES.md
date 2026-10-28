# Analysis utilities

Three small, self-contained commands that need no vendor tool.

## Constant radar

```bash
npm run crypto:radar -- <file> [--json]
```

Scans a local file for well-known tables and magic values: AES S-box and inverse S-box,
SHA-256/SHA-1/MD5 initial state, a CRC-32 table pair, zlib/gzip/zstd/xz/LZ4 headers, Base64
alphabets, PEM key headers.

Every hit carries a file offset so it can be verified by hand.

**What it means:** the bytes are present. **What it does not mean:** that the code calls that
algorithm. Absence is also not proof — tables are often generated at runtime.

`--include-hints` adds single-byte markers such as the Protobuf field tag, which produce many
unrelated hits by construction.

## Schema synthesis

```bash
npm run schema:synth -- --input samples.json --name User --format ts
npm run schema:synth -- --input samples.json --name User --format pydantic --out model.py
npm run schema:synth -- --input samples.json --name User --format openapi --out openapi.json
```

Infers a contract from JSON samples:

- a field missing from some samples becomes optional
- a field that is `null` somewhere becomes nullable
- repeated low-cardinality strings become literal enums; a value unique to every sample stays a
  plain string
- integers and floats are distinguished
- nested objects produce nested interfaces / models

It describes **only the samples you pass**. It is not a runtime observation.

## Hypothesis board

```bash
npm run hypothesis -- add --statement "Module A handles session reconnect" \
  --confidence inferred --evidence ev_0123
npm run hypothesis -- list [--status open|supported|contradicted|refuted] [--json]
npm run hypothesis -- status --id hyp_... --status supported --evidence ev_0456
npm run hypothesis -- status --id hyp_... --status contradicted --evidence ev_0789
npm run hypothesis -- check --evidence ev_0456
npm run hypothesis -- show --id hyp_...
npm run hypothesis -- delete --id hyp_...
```

A hypothesis is an explicit claim with a confidence label, a status, supporting evidence and
contradictions kept in separate lists. `check` answers "which claims does this evidence touch?",
which is the point: a contradiction should be visible, not buried in prose.

**Limits:** the board stores claims, it does not verify them. Nothing here turns `guessed` into
`observed`.

## Environment

| Variable | Default | Used by |
|---|---|---|
| `XTNA_HYPOTHESIS_DIR` | `~/.xtna/hypotheses` | hypothesis board |
