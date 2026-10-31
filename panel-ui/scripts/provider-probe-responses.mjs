/** Proves the Responses API wire format used when COPILOT_API_STYLE=responses. */
import { createServer } from "node:http";

import { createOpenAI } from "@ai-sdk/openai";
import { generateText } from "ai";

const reply = {
  id: "resp_test",
  object: "response",
  created_at: 1,
  model: "gpt-test",
  status: "completed",
  output: [
    {
      id: "msg_test",
      type: "message",
      role: "assistant",
      status: "completed",
      content: [
        { type: "output_text", text: "pong from responses", annotations: [] },
      ],
    },
  ],
  usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 },
};

const server = createServer((request, response) => {
  let body = "";
  request.on("data", (chunk) => {
    body += chunk;
  });
  request.on("end", () => {
    const parsed = JSON.parse(body || "{}");
    if (request.url !== "/v1/responses" || !Array.isArray(parsed.input)) {
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
  model: provider("gpt-test"),
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
