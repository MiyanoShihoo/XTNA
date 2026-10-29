/**
 * Protocol-level gateway test with an in-memory transport and a stub upstream.
 * The host sandbox here denies spawning child processes, so the upstream is a
 * plain object; everything above it (MCP server, redaction, cache, routing) is real.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { VaultProxy } from "../dist/proxy.js";
import { Vault } from "../dist/vault.js";
import { Redactor } from "../dist/redact.js";
import { ResponseCache } from "../dist/cache.js";

const AWS = "AKIAIOSFODNN7EXAMPLE";
const JWT =
  "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";

let calls = 0;
const seen = [];

const stub = {
  name: "fake",
  config: { name: "fake", prefix: "never" },
  serverCapabilities: { tools: {} },
  async listTools() {
    return {
      tools: [
        {
          name: "leak",
          description: "returns credentials",
          inputSchema: { type: "object", properties: {} },
          annotations: { readOnlyHint: true },
        },
        {
          name: "echo",
          description: "echoes",
          inputSchema: { type: "object", properties: { value: { type: "string" } } },
        },
      ],
    };
  },
  async callTool(name, args) {
    calls += 1;
    if (name === "leak") await new Promise((resolve) => setTimeout(resolve, 30));
    seen.push({ name, args });
    if (name === "leak")
      return {
        content: [
          {
            type: "text",
            text: `aws_access_key_id=${AWS}\nAuthorization: Bearer ${JWT}\ncalls=${String(calls)}`,
          },
        ],
      };
    const value = String(args?.value ?? "");
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ verdict: value.startsWith("AKIA") ? "REAL" : "PLACEHOLDER" }),
        },
      ],
    };
  },
  invalidateToolCache() {},
  async close() {},
};

const config = {
  upstreams: [stub.config],
  redaction: {
    enabled: true,
    marker: "vault",
    minLength: 8,
    extraPatterns: [],
    disabled: [],
    entropy: { enabled: false, minLength: 32, threshold: 4.2, skipPureHexLengths: [] },
  },
  cache: {
    enabled: true,
    path: ".test-cache/inline.db",
    defaultTtlMs: 600000,
    discoveryTtlMs: 60000,
    maxEntries: 100,
    defaultPolicy: "annotations",
    allow: [],
    deny: [],
    maxEntryBytes: 1048576,
  },
  logging: { level: "silent" },
  internalTools: { enabled: true },
  annotatePlaceholders: true,
};

const vault = new Vault("vault", "aaaaaa");
const cache = new ResponseCache(config.cache);
cache.clear();
const proxy = new VaultProxy({
  config,
  upstreams: [stub],
  vault,
  redactor: new Redactor(config.redaction),
  cache,
});

const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await proxy.mcpServer.connect(serverTransport);
const client = new Client({ name: "gateway-test", version: "1" }, { capabilities: {} });
await client.connect(clientTransport);

const results = [];
const check = (name, condition, detail = "") => {
  results.push({ name, ok: Boolean(condition), detail });
};

const listed = await client.listTools();
const names = listed.tools.map((tool) => tool.name);
check("tools/list exposes upstream tools", names.includes("leak") && names.includes("echo"));
check("tools/list exposes internal tools", names.includes("vault_stats"));

const first = await client.callTool({ name: "leak", arguments: {} });
const firstText = first.content[0].text;
check("aws key is replaced", !firstText.includes(AWS), firstText.slice(0, 80));
check("jwt is replaced", !firstText.includes(JWT));
check("placeholder is emitted", /<vault:1:aaaaaa>/u.test(firstText), firstText.slice(0, 120));

const second = await client.callTool({ name: "leak", arguments: {} });
const secondText = second.content[0].text;
check("cached response is replayed", secondText.includes("calls=1"), secondText.slice(-40));
check("upstream was called once", calls === 1, `calls=${String(calls)}`);

const echo = await client.callTool({
  name: "echo",
  arguments: { value: "<vault:1:aaaaaa>" },
});
const echoText = echo.content[0].text;
check("placeholder is rehydrated before the upstream call", echoText.includes("REAL"), echoText);

const stats = await client.callTool({ name: "vault_stats", arguments: {} });
const statsBody = JSON.parse(stats.content[0].text);
check("stats report both interned secrets", statsBody.placeholders === 2, JSON.stringify(statsBody));
check("stats report a cache hit", statsBody.cache.hits >= 1, JSON.stringify(statsBody.cache));

const nonReadOnlyFirst = await client.callTool({ name: "echo", arguments: { value: "x" } });
const nonReadOnlySecond = await client.callTool({ name: "echo", arguments: { value: "x" } });
void nonReadOnlyFirst;
void nonReadOnlySecond;
check("unannotated tool is not cached", calls === 4, `calls=${String(calls)}`);

cache.clear();
const callsBeforeConcurrent = calls;
const [concurrentA, concurrentB] = await Promise.all([
  client.callTool({ name: "leak", arguments: {} }),
  client.callTool({ name: "leak", arguments: {} }),
]);
void concurrentA;
void concurrentB;
check(
  "concurrent identical calls coalesce into one upstream request",
  calls === callsBeforeConcurrent + 1,
  `calls=${String(calls)}`,
);

await client.close();
await proxy.mcpServer.close();
cache.close();

let failed = 0;
for (const { name, ok, detail } of results) {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` 鈥?${detail}`}`);
  if (!ok) failed += 1;
}
console.log(`\n${String(results.length - failed)}/${String(results.length)} checks passed`);
process.exitCode = failed === 0 ? 0 : 1;
