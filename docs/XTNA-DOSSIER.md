# Dossier exporter

`npm run dossier -- --evidence <bundle.json> [--out report.md|report.html|report.pdf] [--format markdown|html|pdf] [--pdf-font <file.ttf>]`
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

| Section        | Source                                                                                                                                       |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Targets        | `artifacts[]` — format, architecture, SHA-256                                                                                                |
| Architecture   | Mermaid `flowchart LR` from artifact/provider/record identity; edges are projections, not observed calls                                     |
| Sequence       | Mermaid `sequenceDiagram`: browser request/response order when the bundle holds scenario events, otherwise agent-to-provider operation order |
| Module matrix  | record counts grouped by provider and operation                                                                                              |
| Records        | `records[]` — operation, provider, authority, confidence, limitation count, evidence id                                                      |
| Limitations    | every `record.limitations[]`, de-duplicated                                                                                                  |
| Unknowns       | `unknowns[]` — domain, severity, status, question                                                                                            |
| Remediation    | `unknowns[].recommended_probes[]` — question, suggested probe, rationale                                                                     |
| Interfaces     | optional `--api-spec` OpenAPI document: method, path, operation id, parameters, responses                                                    |
| Providers      | `providers[]` — id and version                                                                                                               |
| Symbol overlay | optional overlay file, with `observed` / `inferred` / `guessed` intact                                                                       |
| Reproduction   | the commands that produce the same bundle                                                                                                    |

## What it deliberately does not do

- No narrative inference: it will not "explain" what a function does.
- The PDF export writes Helvetica for ASCII and embeds a TrueType font for everything else
  (`--pdf-font`, or the first existing candidate: `simhei.ttf`, `Deng.ttf`). The **whole font is
  embedded**, so the file grows by roughly the compressed font size; text stays extractable through
  a ToUnicode map. Without a usable font, non-ASCII characters become `?`.
- Mermaid `flowchart LR|TB` and `sequenceDiagram` blocks are drawn as PDF vector diagrams
  (boxes, arrows, labels). Other Mermaid shapes render a `not rendered` note instead of an
  approximation.
- The HTML wrapper embeds the same Markdown projection, tables, and Mermaid source; its diagram
  edges are bundle relationships, not a claim of observed runtime calls.
- The sequence diagram is a projection of recorded order: it implies no timing, concurrency or
  causation, and it caps at 20 transactions or 20 records.
- No redaction: run it on a bundle you are willing to publish.
