# Local model pre-filter

`npm run prefilter -- --endpoint http://127.0.0.1:11434 --model qwen2.5:3b (--text "…" | --file path) [--json]`
asks a small local model (Ollama-compatible `/api/chat`) whether one piece of text is worth a
larger reader's attention.

This is a **filter**, not an analyst. It returns one of:

| Label        | Meaning                                                 |
| ------------ | ------------------------------------------------------- |
| `relevant`   | the text carries analysis-relevant facts                |
| `irrelevant` | the text is noise for the current question              |
| `unknown`    | the model was unreachable, answered badly, or timed out |

`unknown` is the fail-open default: the caller keeps the text and continues. A missing model never
looks like a silent "irrelevant".

## Contract

- Loopback endpoints only (`127.0.0.1`, `localhost`, `[::1]`); anything else throws at construction.
- `POST /api/chat` with `stream:false`, `format:"json"`, `temperature:0`, `num_predict:160`.
- Input is truncated to 8,000 characters (`maxInputChars`), replies are capped at 64 KiB.
- Deadline 15 seconds; a timeout, HTTP error, non-JSON content or a label outside the enum all
  produce `unknown` with the reason attached.
- The result carries the model name and measured latency.

## What it does not do

- No prompt engineering against a specific vendor beyond the Ollama chat shape; vLLM gateways work
  only if they accept `/api/chat` with the same body.
- No batching, caching or queueing yet; one call per text.
- It never rewrites, summarizes or deletes the input. The caller decides what to do with the label.
