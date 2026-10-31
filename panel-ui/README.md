# XTNA panel UI

React + CopilotKit front end for the live investigation panel. It consumes the frozen panel wire
contract (`docs/XTNA-PANEL-CONTRACT.md`, v1.0.0) and adds a CopilotKit chat sidebar.

## Data views

- Topology (`/api/state` graph projection)
- Network waterfall
- Evidence cards, limitations, symbols, hypotheses, checkpoints
- Provider query console (read-only allowlist; write tools need the panel's terminal approval code)
- CopilotKit `CopilotSidebar` for chat

## Run

```bash
# 1) the panel server (owns /api/state, /api/query, /events)
cd ..            # repository root
npm run panel:serve -- --evidence E:/path/to/bundle.json --port 4399 \
  [--mcp-url http://127.0.0.1:8765/mcp --query-token <token>]

# 2) this UI
cd panel-ui
npm install
npm run dev      # http://localhost:5173 (Vite proxies /api and /events to 4399)
```

The Vite dev server binds `localhost`; open `http://localhost:5173`, not `127.0.0.1`.

## Chat runtime (optional)

Any OpenAI-compatible provider works — OpenRouter, Groq, Together, Ollama, vLLM, LiteLLM or your
own gateway. The runtime normalizes both wire formats CopilotKit can speak:

| Wire format      | Endpoint                       | Response fields the runtime consumes                                               |
| ---------------- | ------------------------------ | ---------------------------------------------------------------------------------- |
| Chat Completions | `POST {base}/chat/completions` | `choices[].message` (content, tool_calls), `delta.content` when streaming, `usage` |
| Responses API    | `POST {base}/responses`        | `output[]` items, `response.completed`, `usage`                                    |

`COPILOT_API_STYLE` selects the transport: `chat`, `responses`, or `auto` (Responses only for
`api.openai.com`, Chat Completions for every other host). Provider ids keep their slashes, so
`anthropic/claude-sonnet-4-6` on OpenRouter is passed through unchanged. Extra gateway headers can
be supplied as JSON in `COPILOT_HEADERS`.

CopilotKit needs its own runtime process because this is a client-only SPA.

```bash
cp .env.example .env    # add OPENAI_API_KEY
npm run runtime          # http://127.0.0.1:8200/api/copilotkit
```

Without a key the data views still work; start Vite with `VITE_COPILOT_DISABLED=true` to hide the
chat launcher. The runtime registers CopilotKit's `BuiltInAgent`; it is a chat assistant, not a
provider client. Provider access stays behind the panel relay and its allowlist.

## Build

```bash
npm run build            # tsc -b && vite build
```

## Limits

- Projection only: no live provider call is made by the UI itself.
- The query console needs `--mcp-url` and `--query-token` on the panel server.
- Chat cannot run tools; it answers from visible state and suggests queries.

## Wire-format probes

Three scripts prove the two transports without a real provider key:

```bash
node scripts/provider-probe.mjs            # Chat Completions: choices[].message + usage
node scripts/provider-probe-stream.mjs     # Chat Completions: SSE delta.content
node scripts/provider-probe-responses.mjs  # Responses API: output[] + usage
```

Each starts a loopback fake server, sends a request through the same AI SDK provider the runtime
uses, and prints the parsed text/usage.
