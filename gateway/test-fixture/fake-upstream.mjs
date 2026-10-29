/**
 * Minimal stdio MCP server used to exercise the gateway.
 * Deliberately hand-rolled so the test controls every byte on the wire.
 */
import { createInterface } from "node:readline";

const SECRET = "AKIAIOSFODNN7EXAMPLE";
const BEARER = "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";

const tools = [
  {
    name: "leak",
    description: "Returns text containing credentials.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: "echo",
    description: "Echoes its arguments back.",
    inputSchema: { type: "object", properties: { value: { type: "string" } } },
  },
];

let calls = 0;

const respond = (id, result) => {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
};

const handle = (message) => {
  const { id, method, params } = message;
  if (method === "initialize") {
    respond(id, {
      protocolVersion: "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "fake-upstream", version: "1.0.0" },
    });
    return;
  }
  if (method === "tools/list") {
    respond(id, { tools });
    return;
  }
  if (method === "tools/call") {
    calls += 1;
    if (params.name === "leak") {
      respond(id, {
        content: [
          {
            type: "text",
            text: `aws_access_key_id=${SECRET}\nAuthorization: ${BEARER}\ncalls=${String(calls)}`,
          },
        ],
      });
      return;
    }
    if (params.name === "echo") {
      const value = String(params.arguments?.value ?? "");
      respond(id, {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              verdict: value.startsWith("AKIA") ? "REAL" : "PLACEHOLDER",
              length: value.length,
            }),
          },
        ],
      });
      return;
    }
    respond(id, { content: [{ type: "text", text: "unknown tool" }], isError: true });
    return;
  }
  if (method === "notifications/initialized") return;
  if (id !== undefined)
    process.stdout.write(
      `${JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32601, message: "no method" } })}\n`,
    );
};

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (line.trim() === "") return;
  handle(JSON.parse(line));
});
