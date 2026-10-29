import { createHash } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  type CallToolResult,
  type ServerCapabilities,
} from "@modelcontextprotocol/sdk/types.js";
import type { CacheConfig } from "./config.js";
import type { Config } from "./config.js";
import { canonicalJson } from "./json.js";
import { createLogger } from "./log.js";
import { Redactor, type RedactionHit } from "./redact.js";
import { ResponseCache } from "./cache.js";
import { Vault } from "./vault.js";
import type { Upstream } from "./upstream.js";

const log = createLogger("proxy");

export interface ProxyDeps {
  readonly config: Config;
  readonly upstreams: readonly Upstream[];
  readonly vault: Vault;
  readonly redactor: Redactor;
  readonly cache: ResponseCache;
}

interface RoutedTool {
  readonly upstream: Upstream;
  readonly upstreamName: string;
  /** Provider-declared read-only hint; absent means unknown, treated as unsafe. */
  readonly readOnly: boolean;
}

const INTERNAL_TOOLS = [
  {
    name: "vault_stats",
    description:
      "Report placeholder count, cache entries, hits, misses and evictions for this gateway session.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: "vault_cache_clear",
    description:
      "Drop cached responses. Pass an upstream name to clear one upstream, or omit it to clear everything.",
    inputSchema: {
      type: "object",
      properties: { upstream: { type: "string" } },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true },
  },
] as const;

/** Merge the capabilities actually offered by the connected upstreams. */
export function mergedCapabilities(upstreams: readonly Upstream[]): ServerCapabilities {
  // The gateway always speaks all three primitives: a handler that only proxies
  // is free to return an empty page when no upstream offers that primitive.
  // Advertising them conditionally would fail the SDK capability assertion.
  const capabilities: ServerCapabilities = {
    tools: { listChanged: true },
    resources: { listChanged: true, subscribe: false },
    prompts: { listChanged: true },
  };
  if (upstreams.some((upstream) => upstream.serverCapabilities.completions))
    capabilities.completions = {};
  return capabilities;
}

export class VaultProxy {
  private readonly server: Server;
  private readonly toolRoutes = new Map<string, RoutedTool>();
  /** Identical read-only calls that are already in flight share one request. */
  private readonly inflight = new Map<string, Promise<CallToolResult>>();
  private readonly prefixByUpstream = new Map<string, boolean>();

  constructor(private readonly deps: ProxyDeps) {
    const { config, upstreams } = deps;
    for (const upstream of upstreams) {
      const mode = upstream.config.prefix;
      const prefix =
        mode === "always" || (mode === "auto" && upstreams.length > 1);
      this.prefixByUpstream.set(upstream.name, prefix);
    }

    this.server = new Server(
      { name: "xtna-vault", version: "0.1.0" },
      { capabilities: mergedCapabilities(upstreams), instructions: this.instructions() },
    );
    this.registerHandlers();
  }

  get mcpServer(): Server {
    return this.server;
  }

  private instructions(): string {
    const marker = this.deps.vault.id;
    const lines = [
      "This MCP endpoint is an analysing gateway in front of one or more MCP servers.",
      "Secret-looking values in tool results are replaced with placeholders such as <vault:1:" +
        marker +
        ">.",
      "Pass a placeholder back in any tool argument and the gateway restores the real value before the call reaches the upstream server; you never need the plaintext.",
      "Read-only tool results are cached and may be replayed without contacting the upstream server.",
    ];
    if (this.deps.config.annotatePlaceholders)
      lines.push("Do not invent placeholders; only reuse ones you have already received.");
    return lines.join(" ");
  }

  private registerHandlers(): void {
    this.server.setRequestHandler(ListToolsRequestSchema, async (request) => {
      const tools = [];
      for (const upstream of this.deps.upstreams) {
        if (!upstream.serverCapabilities.tools) continue;
        const listed = await upstream.listTools();
        const prefix = this.prefixByUpstream.get(upstream.name) === true;
        for (const tool of listed.tools) {
          const name = prefix ? `${upstream.name}__${tool.name}` : tool.name;
          this.toolRoutes.set(name, {
            upstream,
            upstreamName: tool.name,
            readOnly: tool.annotations?.readOnlyHint === true,
          });
          tools.push({ ...tool, name });
        }
      }
      if (this.deps.config.internalTools.enabled) tools.push(...INTERNAL_TOOLS);
      return { tools };
    });

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: rawArguments } = request.params;
      try {
        if (this.deps.config.internalTools.enabled) {
          const internal = this.callInternalTool(name, rawArguments);
          if (internal !== null) return internal;
        }

        const route =
          this.toolRoutes.get(name) ?? (await this.resolveRoute(name));
        if (route === undefined)
          return errorResult(`Unknown tool "${name}". Call tools/list and retry.`);

        const rehydrated = this.deps.vault.expandDeep(rawArguments ?? {});
        const cacheable = this.isCacheable(route, rehydrated);
        const key = cacheable
          ? this.cacheKey(route, "tools/call", { name: route.upstreamName, arguments: rehydrated })
          : null;

        if (key !== null) {
          const hit = this.deps.cache.get(key);
          if (hit !== undefined) {
            log.debug("cache hit", { tool: name });
            return this.redactCallToolResult(JSON.parse(hit.payload) as CallToolResult).value;
          }
        }

        const result = await this.invoke(route, key, rehydrated);
        return this.redactCallToolResult(result).value;
      } catch (error) {
        log.warn("tools/call failed", { tool: name, message: (error as Error).message });
        return errorResult((error as Error).message);
      }
    });

    this.server.setRequestHandler(ListResourcesRequestSchema, async (request) => {
      const resources = [];
      for (const upstream of this.deps.upstreams) {
        if (!upstream.serverCapabilities.resources) continue;
        const page = await upstream.listResources(request.params?.cursor);
        for (const resource of page.resources) {
          const prefix = this.prefixByUpstream.get(upstream.name) === true;
          resources.push({
            ...resource,
            uri: prefix ? `${upstream.name}+${resource.uri}` : resource.uri,
          });
        }
      }
      return { resources };
    });

    this.server.setRequestHandler(ListResourceTemplatesRequestSchema, async (request) => {
      const templates = [];
      for (const upstream of this.deps.upstreams) {
        if (!upstream.serverCapabilities.resources) continue;
        const page = await upstream.listResourceTemplates(request.params?.cursor);
        for (const template of page.resourceTemplates) {
          const prefix = this.prefixByUpstream.get(upstream.name) === true;
          templates.push({
            ...template,
            uriTemplate: prefix
              ? `${upstream.name}+${template.uriTemplate}`
              : template.uriTemplate,
          });
        }
      }
      return { resourceTemplates: templates };
    });

    this.server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      const { upstream, uri } = this.routeUri(request.params.uri);
      try {
        const key = this.cacheKey(
          { upstream, upstreamName: uri, readOnly: true },
          "resources/read",
          { uri },
        );
        const hit = this.deps.cache.get(key);
        if (hit !== undefined) {
          const cached = JSON.parse(hit.payload) as { contents: Array<{ text?: string }> };
          return this.redactResourceResult(cached).value;
        }
        const result = await upstream.readResource(uri);
        this.deps.cache.put(
          key,
          upstream.name,
          "resources/read",
          JSON.stringify(result),
          this.deps.config.cache.defaultTtlMs,
        );
        return this.redactResourceResult(result).value;
      } catch (error) {
        throw new Error(`resources/read failed: ${(error as Error).message}`);
      }
    });

    this.server.setRequestHandler(ListPromptsRequestSchema, async () => {
      const prompts = [];
      for (const upstream of this.deps.upstreams) {
        if (!upstream.serverCapabilities.prompts) continue;
        const page = await upstream.listPrompts();
        const prefix = this.prefixByUpstream.get(upstream.name) === true;
        for (const prompt of page.prompts) {
          prompts.push({
            ...prompt,
            name: prefix ? `${upstream.name}__${prompt.name}` : prompt.name,
          });
        }
      }
      return { prompts };
    });

    this.server.setRequestHandler(GetPromptRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      const [maybePrefix, rest] = name.includes("__")
        ? [name.slice(0, name.indexOf("__")), name.slice(name.indexOf("__") + 2)]
        : [null, name];
      const upstream =
        this.deps.upstreams.find((candidate) => candidate.name === maybePrefix) ??
        this.deps.upstreams[0];
      if (upstream === undefined) throw new Error("No upstream is connected");
      const result = await upstream.getPrompt(rest, this.deps.vault.expandDeep(args));
      return this.redactPromptResult(result).value;
    });
  }

  /**
   * A client may call a tool before it ever lists them. Resolve on demand and
   * fill the route table so later calls stay O(1).
   */
  private async invoke(
    route: RoutedTool,
    key: string | null,
    args: Record<string, unknown>,
  ): Promise<CallToolResult> {
    if (key === null) return route.upstream.callTool(route.upstreamName, args);
    const existing = this.inflight.get(key);
    if (existing !== undefined) return existing;
    const pending = route.upstream
      .callTool(route.upstreamName, args)
      .then((result) => {
        if (result.isError !== true)
          this.deps.cache.put(
            key,
            route.upstream.name,
            "tools/call",
            JSON.stringify(result),
            this.deps.config.cache.defaultTtlMs,
          );
        return result;
      })
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, pending);
    return pending;
  }

  private async resolveRoute(name: string): Promise<RoutedTool | undefined> {
    for (const upstream of this.deps.upstreams) {
      if (!upstream.serverCapabilities.tools) continue;
      const prefix = this.prefixByUpstream.get(upstream.name) === true;
      const listed = await upstream.listTools();
      for (const tool of listed.tools) {
        const exposed = prefix ? `${upstream.name}__${tool.name}` : tool.name;
        this.toolRoutes.set(exposed, {
          upstream,
          upstreamName: tool.name,
          readOnly: tool.annotations?.readOnlyHint === true,
        });
        if (exposed === name) return this.toolRoutes.get(exposed);
      }
    }
    return undefined;
  }

  private callInternalTool(
    name: string,
    args: Record<string, unknown> | undefined,
  ): CallToolResult | null {
    if (name === "vault_stats") {
      const stats = this.deps.cache.stats();
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              placeholders: this.deps.vault.size,
              upstreams: this.deps.upstreams.map((upstream) => upstream.name),
              cache: stats,
            }),
          },
        ],
        annotations: { readOnlyHint: true },
      } as CallToolResult;
    }
    if (name === "vault_cache_clear") {
      const upstream = typeof args?.upstream === "string" ? args.upstream : undefined;
      const removed = this.deps.cache.clear(upstream);
      return {
        content: [{ type: "text", text: JSON.stringify({ removed }) }],
      } as CallToolResult;
    }
    return null;
  }

  private routeUri(uri: string): { upstream: Upstream; uri: string } {
    const separator = uri.indexOf("+");
    if (separator > 0) {
      const prefix = uri.slice(0, separator);
      const match = this.deps.upstreams.find((upstream) => upstream.name === prefix);
      if (match !== undefined) return { upstream: match, uri: uri.slice(separator + 1) };
    }
    const first = this.deps.upstreams[0];
    if (first === undefined) throw new Error("No upstream is connected");
    return { upstream: first, uri };
  }

  private isCacheable(route: RoutedTool, args: unknown): boolean {
    const cache: CacheConfig = this.deps.config.cache;
    if (!cache.enabled) return false;
    const qualified = `${route.upstream.name}:${route.upstreamName}`;
    if (cache.deny.includes(route.upstreamName) || cache.deny.includes(qualified)) return false;
    if (cache.allow.includes(route.upstreamName) || cache.allow.includes(qualified)) return true;
    if (cache.defaultPolicy === "none") return false;
    if (cache.defaultPolicy === "all") return true;
    // annotations policy: only a declared read-only tool is replayable.
    void args;
    return route.readOnly;
  }

  private cacheKey(
    route: RoutedTool,
    method: string,
    params: unknown,
  ): string {
    return createHash("sha256")
      .update(canonicalJson({ u: route.upstream.name, m: method, p: params }))
      .digest("hex");
  }

  private redactCallToolResult(result: CallToolResult): { value: CallToolResult; hits: RedactionHit[] } {
    const hits: RedactionHit[] = [];
    const value = this.deps.redactor.redactDeep(result, this.deps.vault, hits).value;
    return { value, hits };
  }

  private redactResourceResult<T>(result: T): { value: T; hits: RedactionHit[] } {
    const hits: RedactionHit[] = [];
    const value = this.deps.redactor.redactDeep(result, this.deps.vault, hits).value;
    return { value, hits };
  }

  private redactPromptResult<T>(result: T): { value: T; hits: RedactionHit[] } {
    const hits: RedactionHit[] = [];
    const value = this.deps.redactor.redactDeep(result, this.deps.vault, hits).value;
    return { value, hits };
  }
}

function errorResult(message: string): CallToolResult {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
  } as CallToolResult;
}
