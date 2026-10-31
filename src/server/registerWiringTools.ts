import { readFile } from "node:fs/promises";

import { AnalysisInputError } from "../domain/analysisErrorCore.js";
import { buildOpenApi } from "../application/api/OpenApiFromCapture.js";
import { hypothesisRecordSchema } from "../domain/investigation/HypothesisBoard.js";
import type { JsonValue } from "../domain/jsonValue.js";
import { err, ok } from "../domain/result.js";
import { toolContract } from "../contracts/toolContracts.js";
import type { EvidenceMcpServer } from "./EvidenceMcpServer.js";
import { toolRegistrationOptions } from "./toolRegistrationOptions.js";

const invalid = (operation: string, message: string): AnalysisInputError =>
  new AnalysisInputError(operation, { userMessage: message });

const readJson = async (path: string, operation: string) => {
  const raw = await readFile(path, "utf8").catch(() => undefined);
  if (raw === undefined) throw invalid(operation, `Cannot read ${path}.`);
  try {
    return JSON.parse(raw.replace(/^\uFEFF/u, "")) as unknown;
  } catch {
    throw invalid(operation, `${path} is not valid JSON.`);
  }
};

/** Expose the typed CLI builders without adding new inference. */
export const registerWiringTools = (server: EvidenceMcpServer): void => {
  const openapi = toolContract("openapi_from_capture");
  server.registerTool(
    openapi.name,
    toolRegistrationOptions(openapi),
    async (input) => {
      const parsed = openapi.inputSchema.parse(input);
      try {
        const capture = await readJson(parsed.capture_path, openapi.name);
        const document = buildOpenApi(capture, {
          ...(parsed.title === undefined ? {} : { title: parsed.title }),
          ...(parsed.version === undefined ? {} : { version: parsed.version }),
          ...(parsed.server_url === undefined
            ? {}
            : { serverUrl: parsed.server_url }),
          ...(parsed.with_synthesis === true ? { withSynthesis: true } : {}),
        });
        const operations = Object.values(document.paths).reduce(
          (count, entry) => count + Object.keys(entry).length,
          0,
        );
        return server.delivery.toCallToolResult(
          ok({
            openapi: document.openapi,
            paths: Object.keys(document.paths).length,
            operations,
            synthesis: parsed.with_synthesis === true,
            document: document as unknown as JsonValue,
          }),
          openapi,
        );
      } catch (error) {
        return server.delivery.toCallToolResult(
          err(
            error instanceof AnalysisInputError
              ? error
              : invalid(
                  openapi.name,
                  error instanceof Error ? error.message : String(error),
                ),
          ),
          openapi,
        );
      }
    },
  );

  const board = toolContract("hypothesis_board_inspect");
  server.registerTool(
    board.name,
    toolRegistrationOptions(board),
    async (input) => {
      const parsed = board.inputSchema.parse(input);
      try {
        const store = (await readJson(parsed.store_path, board.name)) as {
          schema?: unknown;
          records?: unknown;
        };
        if (store.schema !== "xtna.hypothesis-board/1")
          return server.delivery.toCallToolResult(
            err(
              invalid(
                board.name,
                `${parsed.store_path} is not a typed hypothesis board store.`,
              ),
            ),
            board,
          );
        if (!Array.isArray(store.records))
          return server.delivery.toCallToolResult(
            err(invalid(board.name, "The store has no records array.")),
            board,
          );
        const records = store.records.map((record) =>
          hypothesisRecordSchema.parse(record),
        );
        const filtered = records.filter((record) => {
          if (parsed.id !== undefined && record.id !== parsed.id) return false;
          if (parsed.evidence === undefined) return true;
          const ids = [
            ...record.history.flatMap((event) => event.evidence_ids),
            ...record.checklist.flatMap((item) => item.evidence_ids),
            ...record.conflicts.flatMap((conflict) => conflict.evidence_ids),
          ];
          return ids.includes(parsed.evidence);
        });
        return server.delivery.toCallToolResult(
          ok({
            schema: "xtna.hypothesis-board/1" as const,
            records: filtered as unknown as JsonValue[],
          }),
          board,
        );
      } catch (error) {
        return server.delivery.toCallToolResult(
          err(
            error instanceof AnalysisInputError
              ? error
              : invalid(
                  board.name,
                  error instanceof Error ? error.message : String(error),
                ),
          ),
          board,
        );
      }
    },
  );
};
