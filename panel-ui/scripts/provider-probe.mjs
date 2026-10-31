/**
 * Proves the Chat Completions wire format used by the panel runtime:
 * a fake /v1/chat/completions server answers with the standard envelope and
 * the AI SDK provider (the same one server.ts builds) parses it.
 */
import { createServer } from "node:http";

import { createOpenAI } from "@ai-sdk/openai";
import { generateText } from "ai";

const reply = {
  id: "chatcmpl-test",
  object: "chat.completion",
  created: 1,
  model: "deepseek-chat",
  choices: [
    {
      index: 0,
      message: {
        role: "assistant",
        content: "pong from chat completions",
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "noop", arguments: "{}" },
          },
        ],
      },
      finish_reason: "stop",
    },
  ],
  usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
};

const server = createServer((request, response) => {
  let body = "";
  request.on("data", (chunk) => {
    body += chunk;
  });
  request.on("end", () => {
    const parsed = JSON.parse(body || "{}");
    // Assert the request envelope the provider sent.
    if (
      request.url !== "/v1/chat/completions" ||
      !Array.isArray(parsed.messages) ||
      parsed.messages[0]?.role !== "user"
    ) {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "bad request" } }));
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(reply));
  });
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
const port = typeof address === "object" && address !== null ? address.port : 0;
const provider = createOpenAI({
  apiKey: "test-key",
  baseURL: `http://127.0.0.1:${String(port)}/v1`,
});

const result = await generateText({
  model: provider.chat("deepseek-chat"),
  prompt: "ping",
});
console.log(
  JSON.stringify({
    text: result.text,
    finish: result.finishReason,
    usage: result.usage,
  }),
);
server.close();
