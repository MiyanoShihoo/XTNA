import { createServer } from "node:http";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createLocalModelPrefilter } from "./LocalModelPrefilter.js";

interface FakeOllama {
  readonly endpoint: string;
  readonly requests: unknown[];
  close: () => Promise<void>;
  setReply: (reply: unknown) => void;
}

const startFakeOllama = async (): Promise<FakeOllama> => {
  let reply: unknown = {};
  const requests: unknown[] = [];
  const server = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => {
      raw += chunk;
    });
    request.on("end", () => {
      requests.push(JSON.parse(raw || "{}"));
      if (typeof reply === "string") {
        response.writeHead(500, { "content-type": "text/plain" });
        response.end(reply);
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          model: "fake",
          message: { role: "assistant", content: JSON.stringify(reply) },
          done: true,
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port =
    typeof address === "object" && address !== null ? address.port : 0;
  return {
    endpoint: `http://127.0.0.1:${String(port)}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
    setReply: (value) => {
      reply = value;
    },
  };
};

describe("local model prefilter", () => {
  let fake: FakeOllama;

  beforeAll(async () => {
    fake = await startFakeOllama();
  });

  afterAll(async () => {
    await fake.close();
  });

  it("parses a relevant verdict and sends the documented request", async () => {
    fake.setReply({
      label: "relevant",
      confidence: 0.82,
      reason: "carries addresses",
    });
    const result = await createLocalModelPrefilter({
      endpoint: fake.endpoint,
      model: "qwen2.5:3b",
    }).classify("FUN_140001008 writes to the ETW provider");
    expect(result.label).toBe("relevant");
    expect(result.confidence).toBeCloseTo(0.82);
    expect(result.reason).toBe("carries addresses");
    const request = fake.requests.at(-1) as {
      model: string;
      stream: boolean;
      format: string;
      messages: { role: string; content: string }[];
    };
    expect(request.model).toBe("qwen2.5:3b");
    expect(request.stream).toBe(false);
    expect(request.format).toBe("json");
    expect(request.messages[0]?.role).toBe("system");
    expect(request.messages[1]?.content).toContain("FUN_140001008");
  });

  it("degrades to unknown when the model answers with a bad label", async () => {
    fake.setReply({ label: "banana", confidence: 2, reason: 7 });
    const result = await createLocalModelPrefilter({
      endpoint: fake.endpoint,
      model: "m",
    }).classify("x");
    expect(result.label).toBe("unknown");
    expect(result.confidence).toBe(1);
    expect(result.reason).toBe("model gave no reason");
  });

  it("degrades to unknown on an HTTP failure instead of hiding the text", async () => {
    fake.setReply("model exploded");
    const result = await createLocalModelPrefilter({
      endpoint: fake.endpoint,
      model: "m",
    }).classify("keep me");
    expect(result.label).toBe("unknown");
    expect(result.reason).toContain("model HTTP 500");
  });

  it("refuses a non-loopback endpoint", () => {
    expect(() =>
      createLocalModelPrefilter({
        endpoint: "http://10.0.0.5:11434",
        model: "m",
      }),
    ).toThrow(/loopback/u);
  });

  it("truncates oversized input before sending it", async () => {
    fake.setReply({ label: "irrelevant", confidence: 0.1, reason: "noise" });
    await createLocalModelPrefilter({
      endpoint: fake.endpoint,
      model: "m",
      maxInputChars: 10,
    }).classify("a".repeat(5_000));
    const request = fake.requests.at(-1) as { messages: { content: string }[] };
    expect(request.messages[1]?.content).toHaveLength(10);
  });
});
