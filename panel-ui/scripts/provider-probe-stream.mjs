/** Proves streaming Chat Completions deltas are parsed by the same provider. */
import { createServer } from "node:http";

import { createOpenAI } from "@ai-sdk/openai";
import { streamText } from "ai";

const chunks = ["po", "ng ", "stream"];
const server = createServer((request, response) => {
  let body = "";
  request.on("data", (chunk) => {
    body += chunk;
  });
  request.on("end", () => {
    if (request.url !== "/v1/chat/completions") {
      response.writeHead(404).end();
      return;
    }
    const parsed = JSON.parse(body || "{}");
    if (parsed.stream !== true) {
      response.writeHead(400).end("expected stream");
      return;
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    for (const [index, text] of chunks.entries()) {
      response.write(
        `data: ${JSON.stringify({
          id: "chatcmpl-stream",
          object: "chat.completion.chunk",
          created: 1,
          model: "deepseek-chat",
          choices: [
            {
              index: 0,
              delta: { content: text },
              finish_reason: index === chunks.length - 1 ? "stop" : null,
            },
          ],
        })}\n\n`,
      );
    }
    response.write("data: [DONE]\n\n");
    response.end();
  });
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
const port = typeof address === "object" && address !== null ? address.port : 0;
const provider = createOpenAI({
  apiKey: "test-key",
  baseURL: `http://127.0.0.1:${String(port)}/v1`,
});
const result = streamText({
  model: provider.chat("deepseek-chat"),
  prompt: "ping",
});
let text = "";
for await (const delta of result.textStream) text += delta;
console.log(JSON.stringify({ text }));
server.close();
