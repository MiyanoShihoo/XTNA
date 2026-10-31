import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { STDIO_DEFAULT_MAX_BUFFER_SIZE } from "@modelcontextprotocol/server";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { EvidenceMcpServer } from "../../src/server/EvidenceMcpServer.js";
import { registerWiringTools } from "../../src/server/registerWiringTools.js";
import { ToolResultDelivery } from "../../src/server/ToolResultDelivery.js";

const cacheRoot = fileURLToPath(new URL("../../.cache", import.meta.url));

const withClient = async (
  use: (client: Client) => Promise<void>,
): Promise<void> => {
  const server = new EvidenceMcpServer(
    { name: "wiring", version: "0" },
    { capabilities: {} },
    undefined,
    new ToolResultDelivery(STDIO_DEFAULT_MAX_BUFFER_SIZE),
    undefined,
    "full",
    undefined,
    undefined,
  );
  registerWiringTools(server);
  const client = new Client({ name: "wiring", version: "0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    await use(client);
  } finally {
    await Promise.allSettled([client.close(), server.close()]);
  }
};

const jsonOf = (result: unknown): unknown => {
  const content = (result as { content?: { text?: string }[] }).content;
  const text = content?.[0]?.text;
  if (text === undefined) throw new Error("no content text");
  return JSON.parse(text);
};

describe("wiring MCP tools", () => {
  let root: string;
  let har: string;
  let board: string;

  beforeAll(async () => {
    root = await mkdtemp(join(cacheRoot, "wiring-mcp-"));
    har = join(root, "capture.har");
    board = join(root, "board.json");
    await writeFile(
      har,
      JSON.stringify({
        log: {
          entries: [
            {
              request: { method: "GET", url: "https://api.test/users" },
              response: {
                status: 200,
                content: { text: JSON.stringify([{ id: 1, name: "Ada" }]) },
              },
            },
          ],
        },
      }),
      "utf8",
    );
    await mkdir(join(root, "nested"), { recursive: true });
    const record = {
      id: "h1",
      statement: "Loader resolves imports lazily",
      status: "proposed",
      checklist: [
        {
          id: "c1",
          label: "loader symbols",
          direction: "supporting",
          state: "pending",
          evidence_ids: [],
        },
      ],
      conflicts: [],
      history: [
        {
          sequence: 1,
          kind: "created",
          evidence_ids: [],
          detail: "Hypothesis proposed",
        },
      ],
    };
    await writeFile(
      board,
      JSON.stringify({ schema: "xtna.hypothesis-board/1", records: [record] }),
      "utf8",
    );
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true, maxRetries: 5 });
  });

  it("lists both wiring tools", async () => {
    await withClient(async (client) => {
      const listed = await client.listTools();
      const names = listed.tools.map((tool) => tool.name);
      expect(names).toContain("openapi_from_capture");
      expect(names).toContain("hypothesis_board_inspect");
    });
  });

  it("builds an OpenAPI document with synthesis through MCP", async () => {
    await withClient(async (client) => {
      const result = await client.callTool({
        name: "openapi_from_capture",
        arguments: { capture_path: har, with_synthesis: true },
      });
      const payload = jsonOf(result) as {
        openapi: string;
        paths: number;
        operations: number;
        synthesis: boolean;
        document: {
          paths: Record<string, Record<string, unknown>>;
        };
      };
      expect(payload.openapi).toBe("3.1.0");
      expect(payload.paths).toBe(1);
      expect(payload.operations).toBe(1);
      expect(payload.synthesis).toBe(true);
      const getOperation = payload.document.paths["/users"]?.get as
        | Record<string, unknown>
        | undefined;
      expect(getOperation?.["x-xtna-synthesis"]).toBeDefined();
    });
  });

  it("reads validated hypothesis records and filters by evidence", async () => {
    await withClient(async (client) => {
      const all = jsonOf(
        await client.callTool({
          name: "hypothesis_board_inspect",
          arguments: { store_path: board },
        }),
      ) as { records: { id: string }[] };
      expect(all.records).toHaveLength(1);
      expect(all.records[0]?.id).toBe("h1");

      const empty = jsonOf(
        await client.callTool({
          name: "hypothesis_board_inspect",
          arguments: { store_path: board, evidence: "ev_missing" },
        }),
      ) as { records: unknown[] };
      expect(empty.records).toHaveLength(0);
    });
  });

  it("refuses a missing capture instead of inventing a document", async () => {
    await withClient(async (client) => {
      const result = (await client.callTool({
        name: "openapi_from_capture",
        arguments: { capture_path: join(root, "missing.har") },
      })) as { isError?: boolean; content?: { text?: string }[] };
      expect(result.isError).toBe(true);
      const text = result.content?.[0]?.text;
      expect(text ?? "").toContain("Cannot read");
    });
  });
});
