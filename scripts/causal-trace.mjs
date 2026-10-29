#!/usr/bin/env node
/**
 * Merge browser, IPC, native and probe event streams into one timeline.
 *
 * Each input is a JSON array or JSON-lines file. Records need a timestamp
 * (`timestamp`, `time` or `ts`) and a `name`; `traceId`, `durationMs`, `kind`
 * and `detail` are preserved when present. Chains are candidates: ordering is
 * evidence, causation is an inference the analyst still has to defend.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const flag = (name) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};
const has = (name) => args.includes(`--${name}`);

const inputs = [
  ["browser", flag("browser")],
  ["ipc", flag("ipc")],
  ["probe", flag("probe")],
  ["native", flag("native")],
  ["log", flag("log")],
].filter(([, path]) => path !== undefined);

if (inputs.length === 0) {
  process.stderr.write(
    "usage: node scripts/causal-trace.mjs [--browser f] [--ipc f] [--probe f] [--native f] [--log f] [--window-ms 50] [--min-chain 2] [--json]\n",
  );
  process.exit(2);
}

const { correlateEvents, mergeTimeline, summarizeTimeline } = await import(
  pathToFileURL(resolve("dist/application/trace/CausalTimeline.js")).href
);

const readRecords = async (path) => {
  const text = (await readFile(resolve(path), "utf8")).replace(/^\uFEFF/u, "");
  const trimmed = text.trim();
  if (trimmed.startsWith("[")) return JSON.parse(trimmed);
  return trimmed
    .split(/\r?\n/u)
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line));
};

const timestampOf = (record) => {
  const value = record.timestamp ?? record.time ?? record.ts;
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return undefined;
};

const events = [];
for (const [source, path] of inputs) {
  for (const record of await readRecords(path)) {
    const timestamp = timestampOf(record);
    if (timestamp === undefined || typeof record.name !== "string") continue;
    events.push({
      source,
      timestamp,
      name: record.name,
      ...(typeof record.kind === "string" ? { kind: record.kind } : {}),
      ...(typeof record.traceId === "string"
        ? { traceId: record.traceId }
        : {}),
      ...(typeof record.durationMs === "number"
        ? { durationMs: record.durationMs }
        : {}),
      ...(record.detail === undefined ? {} : { detail: record.detail }),
    });
  }
}

const timeline = mergeTimeline(events);
const chains = correlateEvents(events, {
  ...(flag("window-ms") === undefined
    ? {}
    : { windowMs: Number(flag("window-ms")) }),
  ...(flag("min-chain") === undefined
    ? {}
    : { minChainLength: Number(flag("min-chain")) }),
});
const summary = summarizeTimeline(timeline);

if (has("json")) {
  process.stdout.write(`${JSON.stringify({ summary, chains }, null, 2)}\n`);
} else {
  process.stdout.write(
    `# ${String(summary.events)} events, ${String(chains.length)} candidate chains, span ${String(summary.spanMs)}ms, largest gap ${String(summary.largestGapMs)}ms\n`,
  );
  process.stdout.write(
    `# sources: ${Object.entries(summary.bySource)
      .filter(([, count]) => count > 0)
      .map(([source, count]) => `${source}=${String(count)}`)
      .join(" ")}\n`,
  );
  for (const chain of chains) {
    process.stdout.write(
      `\n## ${chain.basis}${chain.traceId === undefined ? "" : ` ${chain.traceId}`} (${String(chain.spanMs)}ms)\n`,
    );
    for (const entry of chain.events)
      process.stdout.write(
        `  +${String(entry.timestamp - chain.startMs).padStart(6)}ms ${entry.source.padEnd(7)} ${entry.name}\n`,
      );
  }
}
