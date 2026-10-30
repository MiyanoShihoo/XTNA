/**
 * Point-in-time process and container observation for investigation checkpoints.
 *
 * A checkpoint can record *what was running* when it was taken. It cannot put a
 * process back: restore only writes files, so the snapshot is evidence, not
 * state that a rollback resurrects. Container capture is best effort and says
 * so when the runtime is unavailable.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface ProcessEntry {
  readonly pid: number;
  readonly ppid: number | null;
  readonly name: string;
  /** Resident set size in bytes when the platform reports it. */
  readonly rssBytes: number | null;
}

export interface ContainerEntry {
  readonly id: string;
  readonly image: string;
  readonly status: string;
  readonly names: string;
}

export interface ProcessSnapshot {
  readonly capturedAt: string;
  readonly platform: string;
  readonly processes: readonly ProcessEntry[];
  /** `null` means the container runtime was not available, not "no containers". */
  readonly containers: readonly ContainerEntry[] | null;
  readonly limitations: readonly string[];
}

export type CommandRunner = (
  file: string,
  args: readonly string[],
) => Promise<{ readonly stdout: string }>;

export const MAX_PROCESSES = 2_000;

const csvFields = (line: string): string[] => {
  const fields: string[] = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"') {
      if (quoted && line[index + 1] === '"') {
        current += '"';
        index += 1;
      } else quoted = !quoted;
      continue;
    }
    if (character === "," && !quoted) {
      fields.push(current);
      current = "";
      continue;
    }
    current += character ?? "";
  }
  fields.push(current);
  return fields;
};

const kilobytesToBytes = (value: string): number | null => {
  const digits = value.replace(/[^\d]/gu, "");
  if (digits.length === 0) return null;
  const number = Number(digits);
  return Number.isSafeInteger(number) ? number * 1_024 : null;
};

/** Parse `tasklist /fo csv /nh` output. */
export function parseTasklistCsv(text: string): ProcessEntry[] {
  const entries: ProcessEntry[] = [];
  for (const line of text.split(/\r?\n/u)) {
    if (line.trim().length === 0) continue;
    const fields = csvFields(line);
    if (fields.length < 5) continue;
    const pid = Number(fields[1]);
    if (!Number.isSafeInteger(pid)) continue;
    entries.push({
      pid,
      ppid: null,
      name: fields[0] ?? "unknown",
      rssBytes: kilobytesToBytes(fields[4] ?? ""),
    });
  }
  return entries;
}

/** Parse `ps -eo pid=,ppid=,comm=,rss=` output. */
export function parsePsTable(text: string): ProcessEntry[] {
  const entries: ProcessEntry[] = [];
  for (const line of text.split(/\r?\n/u)) {
    const parts = line.trim().split(/\s+/u);
    if (parts.length < 4) continue;
    const pid = Number(parts[0]);
    const ppid = Number(parts[1]);
    if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(ppid)) continue;
    const rss = Number(parts[parts.length - 1]);
    entries.push({
      pid,
      ppid,
      name: parts.slice(2, -1).join(" "),
      rssBytes: Number.isSafeInteger(rss) ? rss * 1_024 : null,
    });
  }
  return entries;
}

/** Parse `docker ps --format {{json .}}` output, one JSON object per line. */
export function parseDockerPs(text: string): ContainerEntry[] {
  const entries: ContainerEntry[] = [];
  for (const line of text.split(/\r?\n/u)) {
    if (line.trim().length === 0) continue;
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      entries.push({
        id: String(parsed.ID ?? parsed.Id ?? ""),
        image: String(parsed.Image ?? ""),
        status: String(parsed.Status ?? ""),
        names: String(parsed.Names ?? ""),
      });
    } catch {
      continue;
    }
  }
  return entries;
}

const bounded = (entries: ProcessEntry[]): ProcessEntry[] =>
  [...entries]
    .sort((left, right) => left.pid - right.pid)
    .slice(0, MAX_PROCESSES);

/**
 * Capture the current process table and, when a runtime answers, the container
 * list. `runner` is injectable so the parsers can be tested without spawning.
 */
export async function captureProcessSnapshot(
  runner: CommandRunner = async (file, args) => run(file, [...args]),
  platform: NodeJS.Platform = process.platform,
): Promise<ProcessSnapshot> {
  const limitations = [
    "Point-in-time observation: checkpoint restore does not recreate processes or containers.",
  ];
  let processes: ProcessEntry[] = [];
  try {
    if (platform === "win32") {
      const { stdout } = await runner("tasklist", ["/fo", "csv", "/nh"]);
      processes = parseTasklistCsv(stdout);
    } else {
      const { stdout } = await runner("ps", ["-eo", "pid=,ppid=,comm=,rss="]);
      processes = parsePsTable(stdout);
    }
  } catch (error) {
    limitations.push(
      `Process table unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  let containers: ContainerEntry[] | null = null;
  try {
    const { stdout } = await runner("docker", ["ps", "--format", "{{json .}}"]);
    containers = parseDockerPs(stdout);
  } catch {
    limitations.push(
      "Container list unavailable: docker did not answer, so containers are unknown rather than empty.",
    );
  }
  return {
    capturedAt: new Date().toISOString(),
    platform,
    processes: bounded(processes),
    containers,
    limitations,
  };
}
