import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, isAbsolute } from 'node:path';
import { z } from 'zod';

const UpstreamConfig = z.object({
  /** Stable identifier used in cache keys and, when namespacing, tool prefixes. */
  name: z.string().min(1).regex(/^[A-Za-z0-9_.-]+$/),
  /** stdio spawns the command; http connects to an already-running MCP endpoint. */
  transport: z.enum(["stdio", "http"]).default("stdio"),
  command: z.string().default(""),
  /** Streamable HTTP endpoint for transport=http. */
  url: z.string().url().optional(),
  args: z.array(z.string()).default([]),
  env: z.record(z.string()).default({}),
  cwd: z.string().optional(),
  /**
   * Namespace mode override for this upstream.
   * auto: prefix only when more than one upstream is configured.
   */
  prefix: z.enum(['auto', 'always', 'never']).default('auto'),
  /** Inactivity timeout before the upstream is considered wedged. */
  requestTimeoutMs: z.number().int().positive().default(600_000),
});

const RedactionConfig = z.object({
  enabled: z.boolean().default(true),
  /** Token that marks a placeholder, e.g. <vault:3:ab12>. */
  marker: z.string().min(1).default('vault'),
  /** Strings shorter than this are never considered secrets. */
  minLength: z.number().int().min(1).default(8),
  /** Extra user-supplied regexes; each must have the `g` flag semantics applied by us. */
  extraPatterns: z.array(z.string()).default([]),
  /** Disable individual built-in detectors by name. */
  disabled: z.array(z.string()).default([]),
  entropy: z
    .object({
      enabled: z.boolean().default(true),
      minLength: z.number().int().min(8).default(32),
      /** Shannon entropy in bits per character. */
      threshold: z.number().min(2).max(8).default(4.2),
      /** Never flag strings matching these (e.g. pure hashes used as identifiers). */
      skipPureHexLengths: z.array(z.number().int()).default([32, 40, 64, 128]),
    })
    .default({}),
});

const CacheConfig = z.object({
  enabled: z.boolean().default(true),
  path: z.string().default('~/.mcp-vault/cache.db'),
  defaultTtlMs: z.number().int().positive().default(3_600_000),
  /** TTL for discovery-style responses (tools/list, resources/list, prompts/list). */
  discoveryTtlMs: z.number().int().positive().default(60_000),
  maxEntries: z.number().int().positive().default(50_000),
  /** How to decide if a tools/call is cacheable when no explicit rule matches. */
  defaultPolicy: z.enum(['annotations', 'all', 'none']).default('annotations'),
  /** Tool names (optionally `upstream:tool`) that are always cacheable. */
  allow: z.array(z.string()).default([]),
  /** Tool names that are never cacheable. Wins over allow. */
  deny: z.array(z.string()).default([]),
  /** Refuse to cache payloads larger than this. */
  maxEntryBytes: z.number().int().positive().default(4 * 1024 * 1024),
});

const ConfigSchema = z.object({
  upstreams: z.array(UpstreamConfig).min(1),
  redaction: RedactionConfig.default({}),
  cache: CacheConfig.default({}),
  logging: z
    .object({ level: z.enum(['silent', 'error', 'warn', 'info', 'debug']).default('warn') })
    .default({}),
  internalTools: z
    .object({ enabled: z.boolean().default(true) })
    .default({}),
  /**
   * Extra text injected into every tool description telling the model how to
   * treat placeholders. Off when the host already handles this gracefully.
   */
  annotatePlaceholders: z.boolean().default(true),
});

export type Config = z.infer<typeof ConfigSchema>;
export type UpstreamConfig = z.infer<typeof UpstreamConfig>;
export type RedactionConfig = z.infer<typeof RedactionConfig>;
export type CacheConfig = z.infer<typeof CacheConfig>;

export class ConfigError extends Error {
  constructor(message: string, readonly issues?: unknown) {
    super(message);
    this.name = 'ConfigError';
  }
}

export function expandPath(p: string): string {
  let out = p;
  if (out === '~') out = homedir();
  else if (out.startsWith('~/') || out.startsWith('~\\')) out = homedir() + out.slice(1);
  out = out.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => {
    const value = process.env[name];
    if (value === undefined) throw new ConfigError(`Environment variable ${name} is not set`);
    return value;
  });
  return isAbsolute(out) ? out : resolve(process.cwd(), out);
}

function expandEnvMap(env: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    out[k] = v.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => {
      return process.env[name] ?? '';
    });
  }
  return out;
}

export function loadConfig(path: string): Config {
  const abs = expandPath(path);
  if (!existsSync(abs)) throw new ConfigError(`Config file not found: ${abs}`);

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(abs, 'utf8'));
  } catch (err) {
    throw new ConfigError(`Config file is not valid JSON: ${abs}`, err);
  }

  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ConfigError(
      `Config validation failed:\n${parsed.error.issues
        .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('\n')}`,
      parsed.error.issues,
    );
  }

  const cfg = parsed.data;
  for (const up of cfg.upstreams) {
    if (up.transport === "stdio" && up.command === "")
      throw new ConfigError(`Upstream "${up.name}" has transport stdio but no command`);
    if (up.transport === "http" && up.url === undefined)
      throw new ConfigError(`Upstream "${up.name}" has transport http but no url`);
    if (up.env) up.env = expandEnvMap(up.env);
    if (up.cwd) up.cwd = expandPath(up.cwd);
  }
  cfg.cache.path = expandPath(cfg.cache.path);
  return cfg;
}
