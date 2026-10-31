/**
 * Standalone Copilot Runtime for the XTNA panel UI.
 *
 * The model is configured here, on the agent — CopilotKit has no cloud model
 * switcher. Supported shapes:
 *
 * 1. Provider model string: `openai:...`, `anthropic:...`, `google:...`,
 *    `minimax:...` (keys from their env vars).
 * 2. OpenAI-compatible endpoint: `COPILOT_BASE_URL` + `COPILOT_API_KEY` +
 *    `COPILOT_MODEL` (the provider's own id, slashes preserved). The transport
 *    follows `COPILOT_API_STYLE`:
 *      - `chat`      → POST {base}/chat/completions (`choices[].message`,
 *                      `delta.content`, `tool_calls`, `usage`)
 *      - `responses` → POST {base}/responses (`output[]`, `response.completed`)
 *      - `auto`      → `responses` only for api.openai.com, otherwise `chat`
 * 3. `OPENAI_BASE_URL` + `OPENAI_API_KEY` with an `openai:` model string,
 *    resolved by CopilotKit itself.
 */
import { createServer } from "node:http";

import { createOpenAI } from "@ai-sdk/openai";
import { BuiltInAgent, CopilotRuntime } from "@copilotkit/runtime/v2";
import { createCopilotNodeListener } from "@copilotkit/runtime/v2/node";

const modelSpec = (process.env.COPILOT_MODEL ?? "openai:gpt-5-mini").trim();
const baseUrl = process.env.COPILOT_BASE_URL?.trim();
const customKey = process.env.COPILOT_API_KEY ?? process.env.OPENAI_API_KEY;
const apiStyle = (process.env.COPILOT_API_STYLE ?? "auto").trim().toLowerCase();

const keyEnvByProvider: Record<string, string> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  google: "GOOGLE_API_KEY",
  minimax: "MINIMAX_API_KEY",
};

const die = (message: string): never => {
  process.stderr.write(`${message}\n`);
  process.exit(1);
};

const parseHeaders = (): Record<string, string> | undefined => {
  const raw = process.env.COPILOT_HEADERS?.trim();
  if (raw === undefined || raw.length === 0) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return die("COPILOT_HEADERS must be a JSON object of string headers.");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
    return die("COPILOT_HEADERS must be a JSON object of string headers.");
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== "string")
      return die(`COPILOT_HEADERS.${key} must be a string.`);
    headers[key] = value;
  }
  return headers;
};

const modelForAgent = () => {
  if (baseUrl !== undefined && baseUrl.length > 0) {
    if (customKey === undefined || customKey.length === 0)
      die(
        "COPILOT_BASE_URL is set but COPILOT_API_KEY/OPENAI_API_KEY is empty. " +
          "Set the key for the OpenAI-compatible endpoint.",
      );
    if (!["auto", "chat", "responses"].includes(apiStyle))
      die("COPILOT_API_STYLE must be auto, chat or responses.");
    let host = "";
    try {
      host = new URL(baseUrl).hostname;
    } catch {
      die("COPILOT_BASE_URL must be an absolute http(s) URL.");
    }
    const headers = parseHeaders();
    const provider = createOpenAI({
      apiKey: customKey,
      baseURL: baseUrl,
      ...(headers === undefined ? {} : { headers }),
    });
    // Keep provider-style ids intact (OpenRouter's "anthropic/claude-..."),
    // stripping only an explicit openai prefix.
    const id = modelSpec.replace(/^openai[:/]/u, "");
    const responses =
      apiStyle === "responses" ||
      (apiStyle === "auto" && /(^|\.)api\.openai\.com$/u.test(host));
    process.stderr.write(
      `Copilot model: ${id} via ${baseUrl} (${responses ? "Responses" : "Chat Completions"} API)\n`,
    );
    return responses ? provider(id) : provider.chat(id);
  }
  const provider = modelSpec.split(/[:/]/u)[0] ?? "";
  const keyEnv = keyEnvByProvider[provider];
  if (keyEnv === undefined)
    die(
      `Unknown COPILOT_MODEL provider "${provider}". Use one of ` +
        `${Object.keys(keyEnvByProvider).join(", ")}, or set COPILOT_BASE_URL ` +
        "for any OpenAI-compatible endpoint.",
    );
  if ((process.env[keyEnv] ?? "").length === 0)
    die(
      `${keyEnv} is empty; set it or use COPILOT_BASE_URL with COPILOT_API_KEY.`,
    );
  process.stderr.write(`Copilot model: ${modelSpec}\n`);
  return modelSpec;
};

const runtime = new CopilotRuntime({
  // Loopback single-operator runtime: no caller identity, shared threads.
  threads: { access: "open" },
  agents: {
    default: new BuiltInAgent({
      model: modelForAgent(),
      prompt:
        "You help analyze a reverse-engineering investigation shown in the panel. " +
        "You cannot run tools yourself; answer from the visible state and suggest " +
        "which read-only provider query the operator should run.",
    }),
  },
});

const port = Number(process.env.COPILOT_PORT ?? "8200");

createServer(
  createCopilotNodeListener({
    runtime,
    basePath: "/api/copilotkit",
    cors: true,
  }),
).listen(port, "127.0.0.1", () => {
  process.stdout.write(
    `Copilot Runtime listening at http://127.0.0.1:${String(port)}/api/copilotkit\n`,
  );
});
