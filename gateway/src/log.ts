/**
 * All diagnostics go to stderr. stdout is reserved for the MCP wire protocol
 * and a single stray console.log will corrupt the stream for every host.
 */

const LEVELS = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 } as const;

export type LogLevel = keyof typeof LEVELS;

let currentLevel: number = LEVELS.warn;

export function setLogLevel(level: LogLevel): void {
  currentLevel = LEVELS[level] ?? LEVELS.warn;
}

function emit(
  level: keyof typeof LEVELS,
  scope: string,
  msg: string,
  extra?: unknown,
): void {
  if (LEVELS[level] > currentLevel) return;
  const ts = new Date().toISOString();
  let line = `[${ts}] [${level}] [${scope}] ${msg}`;
  if (extra !== undefined) {
    try {
      line += ` ${JSON.stringify(extra)}`;
    } catch {
      line += " [unserializable]";
    }
  }
  process.stderr.write(line + "\n");
}

export function createLogger(scope: string) {
  return {
    error: (msg: string, extra?: unknown) => emit("error", scope, msg, extra),
    warn: (msg: string, extra?: unknown) => emit("warn", scope, msg, extra),
    info: (msg: string, extra?: unknown) => emit("info", scope, msg, extra),
    debug: (msg: string, extra?: unknown) => emit("debug", scope, msg, extra),
  };
}
