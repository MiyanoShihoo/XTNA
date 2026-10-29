# Taint path search

`npm run taint -- --graph g.json --source <sel> --sink <sel>` enumerates simple paths from a
source to a sink over an explicit property graph, refuses to pass through sanitizers, and
reports truncation instead of quietly returning a short list.

It is a **graph algorithm**. It does not create observations: the graph you feed it must come
from an analysis that recorded its own coverage and provenance.

## Graph format

```json
{
  "nodes": [
    { "id": "n_src", "kind": "source", "label": "request.body" },
    { "id": "n_check", "kind": "sanitizer", "label": "validateSchema" },
    { "id": "n_sink", "kind": "sink", "label": "db.execute" }
  ],
  "edges": [
    { "from": "n_src", "to": "n_check", "label": "flows" },
    { "from": "n_check", "to": "n_sink", "label": "flows" }
  ]
}
```

## Selectors

`--source`, `--sink` and `--sanitizer` accept an exact **node id**, a **kind**, or a
**label**. A selector may match several nodes; all matches are used.

## Options

| Option        | Default | Meaning                                   |
| ------------- | ------- | ----------------------------------------- |
| `--max-hops`  | 5       | edges to follow before stopping (1–64)    |
| `--max-paths` | 20      | paths to collect before stopping (1–1000) |
| `--json`      | off     | emit the full report                      |

## Example

```bash
npm run taint -- --graph tests/fixtures/xtna/taint-graph.json \
  --source source --sink sink --sanitizer sanitizer
```

```
status   complete
sources  n_src
sinks    n_sink
paths    2 (explored 6 nodes, max 5 hops)
  #1 2 hops: request.body -> parseJSON -> db.execute
  #2 3 hops: request.body -> buildQuery -> parseJSON -> db.execute
```

The path through `validateSchema` is absent because sanitizer nodes stop expansion.

## Status values

| Status      | Meaning                                               |
| ----------- | ----------------------------------------------------- |
| `complete`  | every simple path within both ceilings was enumerated |
| `truncated` | the path ceiling stopped the search; more may exist   |
| `no-path`   | no path exists within the hop ceiling                 |
| `no-match`  | a selector matched no node                            |

## Producing a graph from an XTNA application graph

`npm run graph:export -- --input jag.json --out taint.json --map-source ipc-main-handler --map-sink native-addon --map-sanitizer sender-validation`

The exporter accepts a raw application graph or an Evidence bundle containing one, keeps
node ids and edge relations, and relabels the kinds you name so `taint` can select them.

## Limits

- Sanitizers are treated as hard barriers. A sanitizer that only conditionally neutralises a
  value still blocks the path, so a **reported** path is a candidate, not proof.
- Simple paths only: a cycle cannot appear twice in one path.
- No data-flow semantics of its own; it reads the edges you give it.
- No built-in graph producer yet: exporting an application graph into this format is a
  separate step.
