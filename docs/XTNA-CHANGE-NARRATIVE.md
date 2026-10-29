# Change narrative

`npm run diff:narrate -- --before a.json --after b.json` compares two structured reports and
writes the difference as prose instead of a raw delta.

## Why

`compare_functions` and `compare_artifacts` produce exact structural facts. Turning those facts
into "what actually changed between these two builds" is still manual work. This tool pairs
records by a stable key, classifies them, and names the fields that moved.

## Input

Two JSON documents. The first array of objects is the collection — a root array, or a field
named `items`, `entries`, `records`, `functions` or `results`, searched recursively.

Records are paired by `name`, then `id`, then `path`; `--key <field>` overrides the choice.

## Output

```markdown
# Change narrative

1 added, 1 removed, 1 changed, 1 unchanged — keyed by `name`.

## Added

- `newDispatch`

## Removed

- `legacyInit`

## Changed

- `saveConfig` — `size`
```

`--json` returns the paired records with both sides and the changed-field list. `--out` writes
the Markdown to a file.

## What it will not do

- Explain the change. It reports that `size` differs, not why.
- Match renamed records: a rename looks like one removal plus one addition.
- Compare nested fields individually; a changed sub-object is reported as its parent field.
- Order by anything but the key, so output is stable across runs.

## Limits

- Structural only: two records with identical fields but different behaviour compare equal.
- The key must exist on every record; records without it are ignored rather than guessed.
- Arrays are compared positionally inside a field, so reordering a list counts as a change.
