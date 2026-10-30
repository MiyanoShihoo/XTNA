import { describe, expect, it } from "vitest";

import {
  captureProcessSnapshot,
  MAX_PROCESSES,
  parseDockerPs,
  parsePsTable,
  parseTasklistCsv,
  type CommandRunner,
} from "./ProcessSnapshot.js";

const tasklist = [
  '"System Idle Process","0","Services","0","8 K"',
  '"chrome.exe","4212","Console","1","123,456 K"',
].join("\r\n");

const ps = ["1 0 systemd 2048", "4212 1 chrome 123456", "77 1 node 4096"].join(
  "\n",
);

describe("process table parsers", () => {
  it("reads tasklist csv rows and memory in KiB", () => {
    expect(parseTasklistCsv(tasklist)).toEqual([
      { pid: 0, ppid: null, name: "System Idle Process", rssBytes: 8_192 },
      { pid: 4212, ppid: null, name: "chrome.exe", rssBytes: 126_418_944 },
    ]);
  });

  it("reads ps rows with parent pid and rss", () => {
    expect(parsePsTable(ps)).toEqual([
      { pid: 1, ppid: 0, name: "systemd", rssBytes: 2_097_152 },
      { pid: 4212, ppid: 1, name: "chrome", rssBytes: 126_418_944 },
      { pid: 77, ppid: 1, name: "node", rssBytes: 4_194_304 },
    ]);
  });

  it("reads docker ps json lines and skips junk", () => {
    const text = [
      '{"ID":"abc","Image":"nginx:latest","Status":"Up 2 hours","Names":"web"}',
      "not json",
    ].join("\n");
    expect(parseDockerPs(text)).toEqual([
      { id: "abc", image: "nginx:latest", status: "Up 2 hours", names: "web" },
    ]);
  });
});

describe("snapshot capture", () => {
  it("captures windows processes and marks docker as unknown when it fails", async () => {
    const calls: string[] = [];
    const runner: CommandRunner = async (file) => {
      calls.push(file);
      if (file === "tasklist") return { stdout: tasklist };
      throw new Error("docker not installed");
    };
    const snapshot = await captureProcessSnapshot(runner, "win32");
    expect(calls).toEqual(["tasklist", "docker"]);
    expect(snapshot.processes.map((entry) => entry.pid)).toEqual([0, 4212]);
    expect(snapshot.containers).toBeNull();
    expect(snapshot.limitations.join(" ")).toContain(
      "unknown rather than empty",
    );
    expect(snapshot.limitations.join(" ")).toContain(
      "does not recreate processes",
    );
  });

  it("captures posix processes and container rows", async () => {
    const runner: CommandRunner = async (file) => {
      if (file === "ps") return { stdout: ps };
      return {
        stdout: '{"ID":"c1","Image":"redis:7","Status":"Up","Names":"cache"}\n',
      };
    };
    const snapshot = await captureProcessSnapshot(runner, "linux");
    expect(snapshot.platform).toBe("linux");
    expect(snapshot.processes).toHaveLength(3);
    expect(snapshot.containers).toEqual([
      { id: "c1", image: "redis:7", status: "Up", names: "cache" },
    ]);
  });

  it("bounds the process table", async () => {
    const rows = Array.from(
      { length: MAX_PROCESSES + 10 },
      (_unused, index) =>
        `"p${String(index)}.exe","${String(index + 1)}","Console","1","1 K"`,
    ).join("\n");
    const runner: CommandRunner = async (file) => {
      if (file === "tasklist") return { stdout: rows };
      throw new Error("no docker");
    };
    const snapshot = await captureProcessSnapshot(runner, "win32");
    expect(snapshot.processes).toHaveLength(MAX_PROCESSES);
  });
});
