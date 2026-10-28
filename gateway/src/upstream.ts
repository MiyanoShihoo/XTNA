import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type {
  CallToolResult,
  GetPromptResult,
  ListPromptsResult,
  ListResourcesResult,
  ListResourceTemplatesResult,
  ListToolsResult,
  ReadResourceResult,
  ServerCapabilities,
  Tool,
} from '@modelcontextprotocol/sdk/types.js';
import type { UpstreamConfig } from './config.js';
import { createLogger } from './log.js';

const log = createLogger('upstream');

export class UpstreamError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'UpstreamError';
  }
}

/**
 * One live connection to a child MCP server.
 *
 * Ownership contract: this object is the sole owner of the child process.
 * `close()` must be called from the process-exit path; the transport tears the
 * child down when the stream closes, and we additionally guard against orphans
 * by tracking the pid.
 */
export class Upstream {
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;
  private capabilities: ServerCapabilities = {};
  private toolCache: Tool[] | null = null;
  private closing = false;

  constructor(readonly config: UpstreamConfig) {}

  get name(): string {
    return this.config.name;
  }

  get serverCapabilities(): ServerCapabilities {
    return this.capabilities;
  }

  async connect(): Promise<void> {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (typeof v === 'string') env[k] = v;
    }
    Object.assign(env, this.config.env);

    this.transport = new StdioClientTransport({
      command: this.config.command,
      args: this.config.args,
      env,
      cwd: this.config.cwd,
      stderr: 'inherit',
    });

    this.transport.onerror = (err) => {
      log.error('transport error', { upstream: this.name, message: err.message });
    };

    this.client = new Client(
      { name: `mcp-vault:${this.name}`, version: '0.1.0' },
      { capabilities: {} },
    );

    try {
      await this.client.connect(this.transport);
    } catch (err) {
      throw new UpstreamError(
        `Failed to connect upstream "${this.name}" (${this.config.command}): ${(err as Error).message}`,
        err,
      );
    }

    this.capabilities = this.client.getServerCapabilities() ?? {};
    log.info('connected', {
      upstream: this.name,
      capabilities: Object.keys(this.capabilities),
      version: this.client.getServerVersion()?.version,
    });
  }

  async listTools(): Promise<ListToolsResult> {
    if (this.toolCache) return { tools: this.toolCache };
    const all: Tool[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.client!.listTools(cursor ? { cursor } : undefined);
      all.push(...page.tools);
      cursor = page.nextCursor;
    } while (cursor);
    this.toolCache = all;
    return { tools: all };
  }

  /** Find a tool definition by its upstream (unprefixed) name. */
  async findTool(name: string): Promise<Tool | undefined> {
    const { tools } = await this.listTools();
    return tools.find((t) => t.name === name);
  }

  invalidateToolCache(): void {
    this.toolCache = null;
  }

  async callTool(name: string, args: Record<string, unknown> | undefined): Promise<CallToolResult> {
    return (await this.client!.callTool(
      { name, arguments: args ?? {} },
      undefined,
      { timeout: this.config.requestTimeoutMs },
    )) as CallToolResult;
  }

  async listResources(cursor?: string): Promise<ListResourcesResult> {
    return (await this.client!.listResources(cursor ? { cursor } : undefined)) as ListResourcesResult;
  }

  async listResourceTemplates(cursor?: string): Promise<ListResourceTemplatesResult> {
    return (await this.client!.listResourceTemplates(
      cursor ? { cursor } : undefined,
    )) as ListResourceTemplatesResult;
  }

  async readResource(uri: string): Promise<ReadResourceResult> {
    return (await this.client!.readResource({ uri }, { timeout: this.config.requestTimeoutMs })) as ReadResourceResult;
  }

  async listPrompts(cursor?: string): Promise<ListPromptsResult> {
    return (await this.client!.listPrompts(cursor ? { cursor } : undefined)) as ListPromptsResult;
  }

  async getPrompt(name: string, args?: Record<string, string>): Promise<GetPromptResult> {
    return (await this.client!.getPrompt(
      { name, arguments: args },
      { timeout: this.config.requestTimeoutMs },
    )) as GetPromptResult;
  }

  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    try {
      await this.client?.close();
    } catch (err) {
      log.warn('client close failed', { upstream: this.name, message: (err as Error).message });
    }
    try {
      await this.transport?.close();
    } catch (err) {
      log.warn('transport close failed', { upstream: this.name, message: (err as Error).message });
    }
    this.client = null;
    this.transport = null;
  }
}
