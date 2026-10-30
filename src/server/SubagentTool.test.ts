import { expect, it } from "vitest";

import type { CallToolResult } from "@modelcontextprotocol/server";

import type { EvidenceMcpServer } from "./EvidenceMcpServer.js";
import { ToolResultDelivery } from "./ToolResultDelivery.js";
import { registerSubagentTools } from "./registerSubagentTools.js";

class FakeServer {
  readonly callbacks = new Map<
    string,
    (input: unknown, context: unknown) => Promise<CallToolResult>
  >();
  readonly delivery = new ToolResultDelivery(1024 * 1024);

  registerTool(
    name: string,
    _config: unknown,
    callback: (input: unknown, context: unknown) => Promise<CallToolResult>,
  ): void {
    this.callbacks.set(name, callback);
  }
}

const invoke = async (
  server: FakeServer,
  name: string,
  input: unknown,
): Promise<CallToolResult> => {
  const callback = server.callbacks.get(name);
  if (callback === undefined) throw new Error(`missing ${name}`);
  return await callback(input, {});
};

it("exposes role tasks and refuses completion without Evidence", async () => {
  const server = new FakeServer();
  registerSubagentTools(server as unknown as EvidenceMcpServer);

  const started = await invoke(server, "subagent_task_start", {
    id: "static-map",
    role: "static-worker",
    objective: "map reachability",
  });
  expect(started.isError).not.toBe(true);
  expect(started.structuredContent).toMatchObject({
    task: {
      id: "static-map",
      role: "static-worker",
      status: "running",
    },
    counts: { running: 1, completed: 0 },
  });

  const refused = await invoke(server, "subagent_task_finish", {
    id: "static-map",
    status: "completed",
  });
  expect(refused.isError).toBe(true);
  expect(JSON.stringify(refused.content)).toContain("Evidence");

  const finished = await invoke(server, "subagent_task_finish", {
    id: "static-map",
    status: "completed",
    evidence_ids: ["ev_static"],
    summary: "mapped",
  });
  expect(finished.isError).not.toBe(true);
  expect(finished.structuredContent).toMatchObject({
    task: { status: "completed", evidence_ids: ["ev_static"] },
    counts: { running: 0, completed: 1 },
    evidence_index: { ev_static: ["static-map"] },
  });
});

it("refuses a dependent task until its dependency completes", async () => {
  const server = new FakeServer();
  registerSubagentTools(server as unknown as EvidenceMcpServer);
  await invoke(server, "subagent_task_start", {
    id: "runtime",
    role: "runtime-worker",
    objective: "observe",
  });
  const blocked = await invoke(server, "subagent_task_start", {
    id: "contract",
    role: "contract-worker",
    objective: "derive contract",
    dependencies: ["runtime"],
  });
  expect(blocked.isError).toBe(true);
  expect(JSON.stringify(blocked.content)).toContain("not completed");
});
