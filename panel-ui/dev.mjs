#!/usr/bin/env node
/**
 * One command for the whole panel: panel server, Vite UI and the chat runtime.
 *
 * A small control API on 4398 lets the UI edit the model settings; saving
 * restarts only the runtime child. Every child shares this console, and the
 * launcher kills the process tree on exit so closing the window leaves no
 * background processes behind.
 *
 * usage: node panel-ui/dev.mjs --evidence <bundle.json> [--mcp-url ... --query-token ...] [--allow-write-tools a,b] [--port 4399]
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const configPath = join(here, ".runtime-config.json");
const args = process.argv.slice(2);
const flag = (name) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};

const evidence = flag("evidence");
if (evidence === undefined) {
  process.stderr.write(
    "usage: npm run panel:dev -- --evidence <bundle.json> [--port 4399] [--mcp-url ... --query-token ...] [--allow-write-tools a,b]\n",
  );
  process.exit(2);
}
if (!existsSync(resolve(evidence))) {
  process.stderr.write(`evidence bundle not found: ${resolve(evidence)}\n`);
  process.exit(2);
}

const panelPort = flag("port") ?? "4399";
const children = [];
let runtimeChild = null;
let shuttingDown = false;

const spawnChild = (label, command, commandArgs, options = {}) => {
  const child = spawn(command, commandArgs, {
    cwd: options.cwd ?? repoRoot,
    env: { ...process.env, ...options.env },
    stdio: "inherit",
    windowsHide: false,
  });
  child.on("exit", (code, signal) => {
    if (shuttingDown) return;
    process.stderr.write(`[${label}] exited (${String(signal ?? code)})\n`);
  });
  children.push({ label, child });
  return child;
};

const killTree = (child) => {
  if (child === null || child.exitCode !== null) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    return;
  }
  try {
    child.kill("SIGTERM");
  } catch {
    /* already gone */
  }
};

const shutdown = (code = 0) => {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const { child } of children) killTree(child);
  setTimeout(() => process.exit(code), 300);
};
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
process.on("SIGHUP", () => shutdown(0));
process.on("exit", () => {
  for (const { child } of children) killTree(child);
});
process.stdin.on("end", () => shutdown(0));

const readConfig = async () => {
  try {
    return JSON.parse(
      (await readFile(configPath, "utf8")).replace(/^\uFEFF/u, ""),
    );
  } catch {
    return {};
  }
};

const startRuntime = async () => {
  const config = await readConfig();
  if (
    typeof config.baseUrl !== "string" ||
    config.baseUrl.length === 0 ||
    typeof config.apiKey !== "string" ||
    config.apiKey.length === 0
  ) {
    process.stdout.write(
      "[runtime] not started; configure a provider in the panel settings dialog\n",
    );
    return;
  }
  runtimeChild = spawnChild(
    "runtime",
    process.execPath,
    [join(here, "node_modules", "tsx", "dist", "cli.mjs"), "server.ts"],
    {
      cwd: here,
      env: {
        COPILOT_BASE_URL: config.baseUrl,
        COPILOT_API_KEY: config.apiKey,
        COPILOT_MODEL: config.model ?? "gpt-4o-mini",
        COPILOT_API_STYLE: config.apiStyle ?? "chat",
        COPILOT_PORT: "8200",
      },
    },
  );
};

const restartRuntime = () => {
  if (runtimeChild !== null) {
    killTree(runtimeChild);
    children.splice(
      children.findIndex((entry) => entry.child === runtimeChild),
      1,
    );
    runtimeChild = null;
  }
  setTimeout(() => void startRuntime(), 500);
};

const control = createServer((request, response) => {
  const send = (status, body) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(`${JSON.stringify(body)}\n`);
  };
  if (request.url === "/api/config" && request.method === "GET") {
    void readConfig().then((config) =>
      send(200, {
        baseUrl: config.baseUrl ?? "",
        model: config.model ?? "gpt-4o-mini",
        apiStyle: config.apiStyle ?? "chat",
        hasKey: typeof config.apiKey === "string" && config.apiKey.length > 0,
      }),
    );
    return;
  }
  if (request.url === "/api/config" && request.method === "POST") {
    let raw = "";
    request.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 16_384) request.destroy();
    });
    request.on("end", () => {
      void (async () => {
        let body;
        try {
          body = JSON.parse(raw);
        } catch {
          send(400, { error: "invalid JSON" });
          return;
        }
        const current = await readConfig();
        const next = {
          baseUrl:
            typeof body.baseUrl === "string"
              ? body.baseUrl.trim()
              : (current.baseUrl ?? ""),
          model:
            typeof body.model === "string" && body.model.trim().length > 0
              ? body.model.trim()
              : (current.model ?? "gpt-4o-mini"),
          apiStyle: ["chat", "responses", "auto"].includes(body.apiStyle)
            ? body.apiStyle
            : (current.apiStyle ?? "chat"),
          apiKey:
            typeof body.apiKey === "string" && body.apiKey.length > 0
              ? body.apiKey
              : (current.apiKey ?? ""),
        };
        await writeFile(
          configPath,
          `${JSON.stringify(next, null, 2)}\n`,
          "utf8",
        );
        restartRuntime();
        send(200, {
          baseUrl: next.baseUrl,
          model: next.model,
          apiStyle: next.apiStyle,
          hasKey: next.apiKey.length > 0,
        });
      })();
    });
    return;
  }
  send(404, { error: "not found" });
});

control.listen(4398, "127.0.0.1", () => {
  process.stdout.write("[control] model settings on http://127.0.0.1:4398\n");
});

const panelArgs = [
  join(repoRoot, "scripts", "panel-serve.mjs"),
  "--evidence",
  resolve(evidence),
  "--port",
  panelPort,
  "--host",
  "127.0.0.1",
];
if (flag("mcp-url") !== undefined) panelArgs.push("--mcp-url", flag("mcp-url"));
if (flag("query-token") !== undefined)
  panelArgs.push("--query-token", flag("query-token"));
if (flag("allow-write-tools") !== undefined)
  panelArgs.push("--allow-write-tools", flag("allow-write-tools"));
if (flag("annotations") !== undefined)
  panelArgs.push("--annotations", flag("annotations"));
if (flag("query-log") !== undefined)
  panelArgs.push("--query-log", flag("query-log"));

spawnChild("panel", process.execPath, panelArgs);
spawnChild(
  "ui",
  process.execPath,
  [join(here, "node_modules", "vite", "bin", "vite.js"), "--host", "localhost"],
  { cwd: here },
);
void startRuntime();

process.stdout.write(
  `[panel] open http://localhost:5173 (evidence: ${resolve(evidence)})\n` +
    "[panel] Ctrl+C or closing this window stops every child process\n",
);
