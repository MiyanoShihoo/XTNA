/**
 * Minimal MCP client over streamable HTTP, used only by the panel's read-only
 * query relay.
 *
 * The panel is a client, never a provider host: the server named by
 * `--mcp-url` owns the Ghidra/Hopper/IDA/JADX session. Only loopback endpoints
 * are accepted, every call has a deadline and a reply-size cap, and this module
 * exposes exactly `initialize` and `callTool` — no prompts, resources or
 * notifications beyond the one required `initialized` notice.
 */

const PROTOCOL_VERSION = "2025-06-18";
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_REPLY_BYTES = 2 * 1024 * 1024;

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/** Reject anything that is not a loopback http(s) endpoint. */
export const assertLoopbackMcpUrl = (value) => {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("--mcp-url must be an absolute http(s) URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new Error("--mcp-url must use http or https");
  if (!LOOPBACK_HOSTS.has(url.hostname))
    throw new Error(
      "--mcp-url must point at loopback (127.0.0.1, localhost or [::1])",
    );
  return url;
};

const parseSse = (text, id) => {
  for (const block of text.split(/\r?\n\r?\n/u)) {
    const data = block
      .split(/\r?\n/u)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (data.length === 0) continue;
    let message;
    try {
      message = JSON.parse(data);
    } catch {
      continue;
    }
    if (message?.id === id) return message;
  }
  return undefined;
};

const readReply = async (response, id) => {
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > MAX_REPLY_BYTES)
    throw new Error("MCP reply exceeded the panel's size cap");
  const type = response.headers.get("content-type") ?? "";
  if (type.includes("text/event-stream")) {
    const message = parseSse(text, id);
    if (message === undefined)
      throw new Error("MCP event stream carried no matching reply");
    return message;
  }
  const parsed = JSON.parse(text);
  if (Array.isArray(parsed)) {
    const message = parsed.find((entry) => entry?.id === id);
    if (message === undefined)
      throw new Error("MCP batch carried no matching reply");
    return message;
  }
  return parsed;
};

/** One connection to one MCP server; created per panel process. */
export const createMcpHttpClient = ({
  url,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  clientName = "xtna-panel",
  clientVersion = "1.0.0",
}) => {
  const endpoint = assertLoopbackMcpUrl(url);
  let sessionId;
  let nextId = 1;

  const post = async (payload, { expectReply = true } = {}) => {
    const headers = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    };
    if (sessionId !== undefined) headers["mcp-session-id"] = sessionId;
    const response = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const assigned = response.headers.get("mcp-session-id");
    if (assigned !== null) sessionId = assigned;
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 300);
      throw new Error(`MCP HTTP ${String(response.status)}: ${detail}`);
    }
    if (!expectReply) return undefined;
    return readReply(response, payload.id);
  };

  const initialize = async () => {
    const message = await post({
      jsonrpc: "2.0",
      id: nextId++,
      method: "initialize",
      params: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: clientName, version: clientVersion },
      },
    });
    if (message?.error !== undefined)
      throw new Error(
        `MCP initialize failed: ${String(message.error.message ?? "unknown")}`,
      );
    await post(
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { expectReply: false },
    );
    return message?.result;
  };

  const callTool = async (name, args, { timeout } = {}) => {
    const id = nextId++;
    const message = await post({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name, arguments: args },
    });
    if (message?.error !== undefined)
      throw new Error(
        `MCP tool error: ${String(message.error.message ?? "unknown")}`,
      );
    return message?.result;
  };

  return { initialize, callTool, endpoint: endpoint.href };
};
