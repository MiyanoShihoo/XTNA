# Investigation checkpoints

`npm run checkpoint -- <command>` freezes the files an investigation depends on — Evidence
bundles and symbol overlay files — into a content-addressed directory with a hash manifest.

Restore verifies every hash **before** writing, so a checkpoint cannot silently hand back
different bytes.

It snapshots files you name. It does not snapshot a running process, a container, or a target's
memory.

## Commands

```bash
# freeze the current evidence bundle and overlay store
npm run checkpoint -- create --name "session-12" \
  --evidence .verify/evidence.json \
  --overlay-dir ~/.xtna/overlays

npm run checkpoint -- list
npm run checkpoint -- list --json

# restore into a working directory
npm run checkpoint -- restore --id cp_mvsd17ym_a7edb3 \
  --dest-dir ./restored --overlay-dir ./restored/overlays

npm run checkpoint -- show --id cp_mvsd17ym_a7edb3
npm run checkpoint -- delete --id cp_mvsd17ym_a7edb3
```

## What a checkpoint contains

| Part | Detail |
|---|---|
| `manifest.json` | schema, id, name, timestamp, and one entry per stored file |
| evidence copies | exact bytes, named `<n>-<original basename>` |
| overlay copies | exact bytes for every `*.json` in the given overlay directory |
| hashes | SHA-256 per file, verified on restore |

## Behaviour worth knowing

- **Tamper-evident.** Editing any stored file makes `restore` fail with the exact source path
  and checkpoint id; nothing is written.
- **No overwrite protection.** Restore copies into `--dest-dir` and will replace a file of the
  same basename there. Use a fresh directory when you need certainty.
- **Overlays are optional.** Pass `--overlay-dir` only if you want them frozen; the evidence
  files are independent.
- **Deletion is permanent.** There is no trash and no remote copy.

## Environment

| Variable | Default | Effect |
|---|---|---|
| `XTNA_CHECKPOINT_DIR` | `~/.xtna/checkpoints` | where checkpoint directories live |

## Limits

- No process or container state: this is a file-level checkpoint.
- No branching or diff yet; each checkpoint is a standalone snapshot.
- Large evidence bundles are copied whole, so disk use grows with each checkpoint.
