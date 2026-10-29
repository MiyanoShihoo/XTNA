# Offline investigation panel

`npm run panel -- --evidence bundle.json --out panel.html` builds a **single-file, offline**
HTML view of an investigation. No network requests, no external scripts, no fonts — the page
embeds its own data and JavaScript.

It reads files; it does not start a server, open a port, or contact anything.

## Usage

```bash
npm run panel -- \
  --evidence evidence.json \
  --overlay ./target.exe \
  --hypotheses ~/.xtna/hypotheses/hypotheses.json \
  --checkpoints ~/.xtna/checkpoints \
  --title "Session 12" \
  --out panel.html
```

| Flag            | Meaning                                       |
| --------------- | --------------------------------------------- |
| `--evidence`    | Evidence bundle (required)                    |
| `--overlay`     | binary path or SHA-256; adds the symbol table |
| `--hypotheses`  | hypothesis store file; adds the claims view   |
| `--checkpoints` | checkpoint directory; adds the snapshot list  |
| `--out`         | output HTML path (default `panel.html`)       |
| `--title`       | page title                                    |

## What the page shows

- **Overview** — artifact count, record count, limitation count, unknowns, providers
- **Evidence** — every record with operation, provider, authority, confidence, limitation
  count, evidence id, plus a live text filter
- **Limitations** — de-duplicated text from the bundle
- **Unknowns** — domain, severity, status, question
- **Symbols** — overlay entries with `observed` / `inferred` / `guessed` intact
- **Hypotheses** — statement, confidence, status, supporting and contradicting counts
- **Checkpoints** — id, name, creation time, file counts

## Security posture

- `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'`
- All values are HTML-escaped before insertion
- No `innerHTML` of unescaped input; tables are built from escaped cells
- No remote fonts, images or analytics

A panel is still sensitive: it contains the evidence you passed. Treat the HTML file with the
same care as the bundle.

## Limits

- Read-only snapshot: regenerating is the only way to update it.
- No graph rendering yet; a topology view needs edge data the bundle may not carry.
- Not a live server — nothing is watching the filesystem.
