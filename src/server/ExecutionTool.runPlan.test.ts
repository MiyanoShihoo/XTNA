import { expect, it } from "vitest";

import type { CallToolResult } from "@modelcontextprotocol/server";

import { ToolResultDelivery } from "./ToolResultDelivery.js";
import { registerExecutionTools } from "./registerExecutionTools.js";
import type { EvidenceMcpServer } from "./EvidenceMcpServer.js";

class FakeServer {
  readonly callbacks = new Map<
    string,
    (input: unknown, context: any) => Promise<CallToolResult>
  >();
  readonly delivery = new ToolResultDelivery(1024 * 1024);

  registerTool(
    name: string,
    _config: unknown,
    callback: (input: unknown, context: any) => Promise<CallToolResult>,
  ): void {
    this.callbacks.set(name, callback);
  }

  async invokeRegisteredTool(
    name: string,
    input: unknown,
    signal: AbortSignal,
  ): Promise<CallToolResult> {
    const callback = this.callbacks.get(name);
    if (callback === undefined) throw new Error(`missing ${name}`);
    return await callback(input, {
      mcpReq: { signal, _meta: {}, notify: async () => undefined },
    });
  }
}

const context = {
  mcpReq: {
    signal: new AbortController().signal,
    _meta: {},
    notify: async () => undefined,
  },
};

it("runs dependency-ordered read-only tools through the registered callback", async () => {
  const server = new FakeServer();
  server.registerTool("inspect_analysis_settings", {}, async () => ({
    content: [{ type: "text", text: "settings" }],
    structuredContent: { revision: 1, settings: [] },
  }));
  registerExecutionTools(server as unknown as EvidenceMcpServer);

  const runPlan = server.callbacks.get("run_plan");
  if (runPlan === undefined) throw new Error("run_plan was not registered");
  const result = await runPlan(
    {
      max_concurrency: 2,
      tasks: [
        {
          id: "first",
          tool: "inspect_analysis_settings",
          arguments: {},
        },
        {
          id: "second",
          tool: "inspect_analysis_settings",
          arguments: { operation: "inspect_artifact" },
          dependencies: ["first"],
        },
      ],
    },
    context,
  );

  expect(result.isError).not.toBe(true);
  expect(result.structuredContent).toMatchObject({
    status: "completed",
    max_concurrency: 2,
    results: [
      { id: "first", status: "completed", output: { revision: 1 } },
      { id: "second", status: "completed", output: { revision: 1 } },
    ],
  });
});

it("rejects tools outside the read-only plan surface", async () => {
  const server = new FakeServer();
  registerExecutionTools(server as unknown as EvidenceMcpServer);
  const runPlan = server.callbacks.get("run_plan");
  if (runPlan === undefined) throw new Error("run_plan was not registered");
  const result = await runPlan(
    {
      tasks: [
        {
          id: "write",
          tool: "update_analysis_settings",
          arguments: {},
        },
      ],
    },
    context,
  );
  expect(result.isError).toBe(true);
  expect(JSON.stringify(result.content)).toContain("read-only plan surface");
});
