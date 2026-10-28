/**
 * Streamable-HTTP MCP upstream used for the process-level gateway test.
 * Runs as its own OS process so the gateway talks to it over a real socket.
 */
import { createServer } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const SECRET = "AKIAIOSFODNN7EXAMPLE";
const JWT =
  "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
let calls = 0;

const tools = [
  {
    name: "leak",
    description: "Returns text containing credentials.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: "echo",
    description: "Echoes whether it received the real secret.",
    inputSchema: { type: "object", properties: { value: { type: "string" } } },
  },
];

const buildServer = () => {
  const server = new Server(
    { name: "fake-http-upstream", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    calls += 1;
    if (request.params.name === "leak")
      return {
        content: [
          {
            type: "text",
            text: `aws_access_key_id=${SECRET}\nAuthorization: Bearer ${JWT}\ncalls=${String(calls)}`,
          },
        ],
      };
    const value = String(request.params.arguments?.value ?? "");
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            verdict: value.startsWith("AKIA") ? "REAL" : "PLACEHOLDER",
            calls,
          }),
        },
      ],
    };
  });
  return server;
};

const http = createServer(async (req, res) => {
  if (req.method !== "POST") {
    res.writeHead(405).end();
    return;
  }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  const server = buildServer();
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
});

const port = Number(process.env.FAKE_UPSTREAM_PORT ?? "43191");
http.listen(port, "127.0.0.1", () => {
  process.stderr.write(`fake-http-upstream listening on ${String(port)}\n`);
});
