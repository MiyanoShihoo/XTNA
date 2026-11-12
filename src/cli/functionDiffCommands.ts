import { z } from "incur";
import type { Logger } from "pino";

import { CLI_COMMANDS } from "../cliCommandNames.js";
import { parseCliJsonInput } from "../cliJsonInput.js";
import { logCliCommand } from "../cliLogging.js";
import { diffFunctionInventoryDocuments } from "../application/functionInventoryDiff.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import { withCommandCancellation } from "./commandCancellation.js";
import type { CliInstance } from "./types.js";

/**
 * Read-only comparison of two local function inventories. The files are parsed
 * as Evidence; nothing in them is executed, and no provider or decompiler runs.
 */
export const registerFunctionDiffCommands = (
  cli: CliInstance,
  logger: Logger,
): void => {
  cli.command(CLI_COMMANDS.diffFunctions, {
    description:
      "Compare two local function inventories by stable symbol without executing targets",
    args: z.object({
      left: z
        .string()
        .describe(
          "Left inventory: JSON file or inline JSON array of analyze_function Evidence",
        ),
      right: z
        .string()
        .describe(
          "Right inventory: JSON file or inline JSON array of analyze_function Evidence",
        ),
    }),
    run: ({ args }) =>
      withCommandCancellation((signal) =>
        logCliCommand(logger, CLI_COMMANDS.diffFunctions, async () => {
          const left = await parseCliJsonInput(
            args.left,
            "diff_functions",
            signal,
          );
          if (!left.ok) return left.error;
          const right = await parseCliJsonInput(
            args.right,
            "diff_functions",
            signal,
          );
          if (!right.ok) return right.error;
          const diff = diffFunctionInventoryDocuments(left.value, right.value);
          return diff.ok ? diff.value : projectAnalysisError(diff.error);
        }),
      ),
  });
};
