# Heap snapshot query

`npm run heap:query -- --in <snapshot.heapsnapshot>` answers memory questions from a V8 heap
snapshot without attaching an inspector, opening DevTools, or loading hundreds of megabytes
into an agent's context.

## Why

A raw `.heapsnapshot` is a JSON document with two flat arrays (`nodes`, `edges`) and a string
table. It is precise and unreadable at the same time. The queries here are the ones that
actually move an investigation: which constructor dominates memory, how many instances exist,
and how many references point at a node.

## Usage

```bash
# constructors holding the most memory
npm run heap:query -- --in app.heapsnapshot --min-count 2 --limit 25

# one exact name, largest instance first
npm run heap:query -- --in app.heapsnapshot --name CacheEntry --limit 50 --json

# immediate dominator tree, largest retained objects first
npm run heap:query -- --in app.heapsnapshot --dominators --limit 25
```

| Flag           | Meaning                                                             |
| -------------- | ------------------------------------------------------------------- |
| `--in`         | snapshot file produced by `--heapsnapshot` / `v8.writeHeapSnapshot` |
| `--name`       | exact constructor name; prints instances instead of the summary     |
| `--dominators` | build the dominator tree and print nodes by retained size           |
| `--min-count`  | summary rows with fewer instances are dropped (default 2)           |
| `--limit`      | rows or instances printed (default 25 / 20)                         |
| `--json`       | machine-readable output                                             |

## How it reads the file

The snapshot declares its own record layout in `snapshot.meta`: `node_fields` gives the stride
and column order, `node_types` the type table. This tool indexes those declarations instead of
assuming a fixed layout, so a snapshot from another V8 version still parses as long as the
fields are named.

Summary and instance modes report **shallow** sizes (`self_size`). `--dominators` constructs
the reachable edge graph, computes immediate dominators from the V8 root, and reports
`retained_size = self_size + descendants in the dominator tree`. Retained sizes count each
reachable object once through that tree; unreachable nodes are omitted.

## Limits

- Dominator analysis is bounded to 500,000 nodes; larger snapshots are refused rather than
  silently truncated.
- No shortest-path-to-GC-root or arbitrary SQL-like query language yet.
- Names come from the string table verbatim; mangled or minified constructor names stay as
  they are.
- Detached DOM nodes are reported like any other object.
- The whole file is parsed with `JSON.parse`; a multi-gigabyte snapshot needs a streaming
  reader this tool does not implement.
