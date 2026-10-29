#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig, ConfigError } from "./config.js";
import { createLogger, setLogLevel } from "./log.js";
import { Redactor } from "./redact.js";
import { Vault } from "./vault.js";
import { ResponseCache } from "./cache.js";
import { Upstream } from "./upstream.js";
import { VaultProxy } from "./proxy.js";

const log = createLogger("main");

interface CliOptions {
  readonly configPath: string;
}

function parseArgs(argv: readonly string[]): CliOptions {
  let configPath = process.env.MCP_VAULT_CONFIG ?? "";
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--config" || arg === "-c") {
      const value = argv[index + 1];
      if (value === undefined) throw new Error("--config requires a path");
      configPath = value;
      index += 1;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      process.stderr.write(
        [
          "mcp-vault: secret-redacting, caching MCP gateway",
          "",
          "Usage: mcp-vault --config <path>",
          "       MCP_VAULT_CONFIG=<path> mcp-vault",
          "",
          "The gateway speaks MCP on stdio and owns every upstream process it starts.",
        ].join("\n") + "\n",
      );
      process.exit(0);
    }
    if (arg !== undefined && arg.startsWith("-"))
      throw new Error(`Unknown option ${arg}`);
  }
  if (configPath === "") throw new Error("No config path. Pass --config or set MCP_VAULT_CONFIG.");
  return { configPath };
}

const main = async (): Promise<void> => {
  const options = parseArgs(process.argv.slice(2));
  const config = loadConfig(options.configPath);
  setLogLevel(config.logging.level);

  const upstreams = config.upstreams.map((upstream) => new Upstream(upstream));
  const cache = new ResponseCache(config.cache);
  const vault = new Vault(config.redaction.marker, process.env.MCP_VAULT_NONCE);
  const redactor = new Redactor(config.redaction);

  let closing = false;
  const shutdown = async (reason: string): Promise<void> => {
    if (closing) return;
    closing = true;
    log.info("shutting down", { reason });
    await Promise.allSettled(upstreams.map((upstream) => upstream.close()));
    cache.close();
  };

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      void shutdown(signal).finally(() => process.exit(0));
    });
  }
  process.on("uncaughtException", (error) => {
    log.error("uncaught exception", { message: error.message, stack: error.stack });
    void shutdown("uncaughtException").finally(() => process.exit(1));
  });
  process.on("unhandledRejection", (reason) => {
    log.error("unhandled rejection", { reason: String(reason) });
  });

  try {
    await Promise.all(upstreams.map((upstream) => upstream.connect()));
  } catch (error) {
    await shutdown("upstream-connect-failed");
    throw error;
  }

  const proxy = new VaultProxy({ config, upstreams, vault, redactor, cache });
  const transport = new StdioServerTransport();
  await proxy.mcpServer.connect(transport);
  log.info("gateway ready", {
    upstreams: upstreams.map((upstream) => upstream.name),
    cache: config.cache.enabled ? config.cache.path : "disabled",
  });
};

main().catch((error: unknown) => {
  if (error instanceof ConfigError) {
    process.stderr.write(`mcp-vault: ${error.message}\n`);
    process.exit(2);
  }
  process.stderr.write(`mcp-vault: ${(error as Error).message}\n`);
  process.exit(1);
});
