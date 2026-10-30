# Dossier exporter

`npm run dossier -- --evidence <bundle.json> [--out report.md|report.html|report.pdf] [--format markdown|html|pdf]`
turns a stored Evidence bundle into a reviewable Markdown, HTML or PDF document.

It is a **projection**, not a second analysis. Every section is read from the bundle; missing
data stays missing rather than being reconstructed.

## Usage

```bash
npm run dossier -- --evidence evidence.json --out report.md
npm run dossier -- --evidence evidence.json --format html --out report.html
npm run dossier -- --evidence evidence.json --overlay ./target.exe --title "Session 12"
npm run dossier -- --evidence evidence.json --api-spec openapi.json --format pdf --out report.pdf
```

`--api-spec` reads an OpenAPI document and renders the interface dictionary (method, path,
operation id, parameters, response codes). It is optional; without it the section is omitted.

`--overlay` reads the symbol overlay for that binary (see
[XTNA-SYMBOL-OVERLAY.md](XTNA-SYMBOL-OVERLAY.md)) and appends the rename table with its
confidence labels.

## Sections

| Section        | Source                                                                                                   |
| -------------- | -------------------------------------------------------------------------------------------------------- |
| Targets        | `artifacts[]` — format, architecture, SHA-256                                                            |
| Architecture   | Mermaid `flowchart LR` from artifact/provider/record identity; edges are projections, not observed calls |
| Module matrix  | record counts grouped by provider and operation                                                          |
| Records        | `records[]` — operation, provider, authority, confidence, limitation count, evidence id                  |
| Limitations    | every `record.limitations[]`, de-duplicated                                                              |
| Unknowns       | `unknowns[]` — domain, severity, status, question                                                        |
| Remediation    | `unknowns[].recommended_probes[]` — question, suggested probe, rationale                                 |
| Interfaces     | optional `--api-spec` OpenAPI document: method, path, operation id, parameters, responses                |
| Providers      | `providers[]` — id and version                                                                           |
| Symbol overlay | optional overlay file, with `observed` / `inferred` / `guessed` intact                                   |
| Reproduction   | the commands that produce the same bundle                                                                |

## What it deliberately does not do

- No narrative inference: it will not "explain" what a function does.
- The PDF export is text-only: Helvetica, A4, 52 lines per page, **Latin-1 only** — non-ASCII
  characters are written as `?`, and Mermaid code fences are omitted. Use HTML when the diagram
  or CJK text matters.
- The HTML wrapper embeds the same Markdown projection, tables, and Mermaid source; its diagram
  edges are bundle relationships, not a claim of observed runtime calls.
- No redaction: run it on a bundle you are willing to publish.
