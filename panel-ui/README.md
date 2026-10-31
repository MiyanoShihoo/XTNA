# XTNA panel UI

React + CopilotKit front end for the live investigation panel. It consumes the frozen panel wire
contract (`docs/XTNA-PANEL-CONTRACT.md`, v1.0.0) and adds a CopilotKit chat sidebar.

## Workbench views

- Full-bleed call topology: glowing nodes, wheel zoom, drag pan, Fit, keyboard selection
- Left inspector drawer: node detail, bundle evidence (searchable), limitations, notes
- Network waterfall, provider query console, symbols / hypotheses / checkpoints strip
- CopilotKit `CopilotSidebar` for chat

Click a node to open the drawer. Notes need the panel server started with
`--annotations notes.jsonl`; without it the Notes tab explains the flag. Notes are
bundle-global, anchored to the target string you pick (node address by default).

The workbench uses the graphite/emerald design tokens in `src/styles.css`
(`#0A0A0A`, `#141414`, `#10B981`, `#F59E0B`). Verify them with:

```bash
npm run build
npm run audit:design
# with panel server :4399 and Vite :5173 running, plus a Playwright browser:
# playwright-core comes from the repository-root devDependencies (root `npm ci`);
# a standalone panel-ui install needs it installed separately.
PLAYWRIGHT_BROWSERS_PATH=../.tmp-build/pw-browsers npm run smoke:visual
```

`smoke:visual` writes `panel-workbench.png` and `panel-drawer.png` under `.tmp-build/`
and reports computed styles, drawer focus behaviour, note de-duplication and console errors.

## Run (one window)

```bash
cd "E:\deepseek project\XTNA"
npm run panel:dev -- --evidence "E:\path\to\bundle.json"
# optional query relay:
#   --mcp-url http://127.0.0.1:8765/mcp --query-token <token>
# optional write tools:
#   --allow-write-tools set_comment,set_address_name
```

That single command starts the panel server (4399), the UI (5173) and the model-control API
(4398). Open `http://localhost:5173`. The terminal owns every child: Ctrl+C, or closing the
window, terminates them; nothing is detached or kept alive.

Model settings are edited in the UI (gear / “Model settings”): base URL, API key, model id and
API style. Saving writes `panel-ui/.runtime-config.json` (gitignored) and restarts only the chat
runtime; without a configured key the data views still work and the chat stays off.

The UI has an EN / 中文 toggle (persisted in localStorage) for security reviewers.

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
