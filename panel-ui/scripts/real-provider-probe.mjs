/**
 * Live probe against a real OpenAI-compatible endpoint.
 * Reads BASE_URL, MODEL and API_KEY from the environment; never stores them.
 */
import { createOpenAI } from "@ai-sdk/openai";
import { generateText, streamText } from "ai";

const baseURL = process.env.PROBE_BASE_URL;
const modelId = process.env.PROBE_MODEL;
const apiKey = process.env.PROBE_API_KEY;
if (!baseURL || !modelId || !apiKey) {
  console.error("PROBE_BASE_URL, PROBE_MODEL and PROBE_API_KEY are required");
  process.exit(2);
}

const provider = createOpenAI({ apiKey, baseURL });

const started = Date.now();
const completion = await generateText({
  model: provider.chat(modelId),
  prompt: "Reply with exactly: pong",
  maxOutputTokens: 32,
});
console.log(
  JSON.stringify({
    kind: "chat-completions",
    text: completion.text,
    finish: completion.finishReason,
    usage: completion.usage,
    ms: Date.now() - started,
  }),
);

const stream = streamText({
  model: provider.chat(modelId),
  prompt: "Count from 1 to 3, comma separated, nothing else.",
  maxOutputTokens: 32,
});
let text = "";
let chunks = 0;
for await (const delta of stream.textStream) {
  text += delta;
  chunks += 1;
}
console.log(JSON.stringify({ kind: "stream", text, chunks }));
