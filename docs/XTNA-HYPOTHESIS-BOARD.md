# Typed hypothesis board (CLI)

`npm run hypothesis:board -- <command> --store <file>` drives the typed state machine in
`src/domain/investigation/HypothesisBoard.ts`.

This is separate from the simple `hypothesis` store: the typed board enforces checklist
completeness, conflict backtracking and an append-only history. Use it when a claim needs to show
_how_ it became supported or refuted, not just a status string.

## Commands

```bash
# propose a claim with one supporting and one contradicting check
npm run hypothesis:board -- create --store board.json --id h1 \
  --statement "Loader resolves imports lazily" \
  --checklist "c1=loader symbols:supporting" \
  --checklist "c2=crypto table:contradicting"

# every transition is a JSON command validated by the domain schema
npm run hypothesis:board -- command --store board.json --id h1 --json '{"kind":"start-investigation"}'
npm run hypothesis:board -- command --store board.json --id h1 \
  --json-file confirm.json     # {kind:"record-checklist",checklist_item_id:"c1",disposition:"confirm",evidence_ids:["ev_a"]}
npm run hypothesis:board -- command --store board.json --id h1 \
  --json '{"kind":"mark-supported","evidence_ids":["ev_a"]}'

npm run hypothesis:board -- list --store board.json [--json]
npm run hypothesis:board -- show --store board.json --id h1
npm run hypothesis:board -- check --store board.json --evidence ev_a
```

`--json-file` exists because shells mangle inline JSON; both forms are parsed and BOM-tolerant.

## Rules the CLI cannot bypass

- A record is validated with `hypothesisRecordSchema` on load; a hand-edited invalid store is
  refused instead of half-reading it.
- `mark-supported` requires every checklist item to be resolved and at least one supporting item
  confirmed; otherwise the command exits `3` with `checklist-incomplete` and the file is untouched.
- Confirming a contradicting item moves the claim to `backtracked` and opens a conflict; only
  `resolve-conflict` can return it to `investigating`, and `refute` is refused until then.
- Every transition appends a history event with its evidence IDs; history is never rewritten.
- The store is written only after the domain transition succeeds.

## Store

```json
{ "schema": "xtna.hypothesis-board/1", "records": [ … ] }
```

Path resolution: `--store`, else `$XTNA_HYPOTHESIS_BOARD`, else `./.xtna/hypothesis-board.json`.
Nothing is written outside that path.

## What it does not do

- No MCP tool yet; the typed contract is wired to the CLI first.
- No confidence scores: the board records evidence and state, not a probability.
- No deletion command: a refuted or backtracked record stays in history.
