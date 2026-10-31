import { useFrontendTool } from "@copilotkit/react-core/v2";
import { z } from "zod";

import { fetchQueryInfo, getQueryToken, runQuery } from "./panel";

/**
 * Frontend tools let the chat call the panel's read-only provider relay.
 * They never touch a provider directly: every call goes through /api/query,
 * the panel's tool allowlist, and its token check.
 */
export const usePanelTools = (): void => {
  useFrontendTool({
    name: "list_panel_tools",
    description:
      "List the provider query tools the panel relay currently exposes. Call this before querying so you only use an allowlisted tool name.",
    parameters: z.object({}),
    handler: async () => JSON.stringify(await fetchQueryInfo()),
  });

  useFrontendTool({
    name: "query_panel_provider",
    description:
      "Run one read-only provider query through the panel relay (for example analyze_function, read_bytes, procedure_pseudo_code). Arguments are scalar strings. Write/attach tools need the operator to approve a pending request in the panel terminal and then supply requestId plus approvalCode.",
    parameters: z.object({
      tool: z.string().describe("Allowlisted tool name from list_panel_tools"),
      args: z
        .record(z.string(), z.string())
        .optional()
        .describe('Scalar arguments, e.g. {"procedure":"0x140001008"}'),
      requestId: z.string().optional().describe("Pending approval request id"),
      approvalCode: z
        .string()
        .optional()
        .describe("Six-digit code printed in the panel terminal"),
    }),
    handler: async ({ tool, args, requestId, approvalCode }) => {
      const token = getQueryToken();
      if (token.length === 0)
        return "The panel query token is empty. Ask the operator to paste the x-xtna-token value into the Provider query box.";
      const confirm =
        requestId !== undefined &&
        approvalCode !== undefined &&
        requestId.length > 0 &&
        approvalCode.length > 0
          ? { requestId, code: approvalCode }
          : undefined;
      const response = await runQuery(
        tool,
        (args ?? {}) as Record<string, string>,
        token,
        confirm,
      );
      return JSON.stringify(
        {
          status: response.status,
          body: response.body,
        },
        null,
        2,
      ).slice(0, 12_000);
    },
  });
};
