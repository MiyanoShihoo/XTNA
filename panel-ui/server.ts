/**
 * Standalone Copilot Runtime for the XTNA panel UI.
 *
 * The panel UI is a client-only Vite app, so the runtime needs its own port.
 * It loads OPENAI_API_KEY from `.env` via `npm run runtime`.
 */
import { createServer } from "node:http";

import { BuiltInAgent, CopilotRuntime } from "@copilotkit/runtime/v2";
import { createCopilotNodeListener } from "@copilotkit/runtime/v2/node";

const apiKey = process.env.OPENAI_API_KEY;
if (apiKey === undefined || apiKey.length === 0) {
  process.stderr.write(
    "OPENAI_API_KEY is not set. Copy .env.example to .env and add a key, " +
      "or run the panel UI with VITE_COPILOT_DISABLED=true to use the data views only.\n",
  );
  process.exit(1);
}

const runtime = new CopilotRuntime({
  agents: {
    default: new BuiltInAgent({
      model: process.env.COPILOT_MODEL ?? "openai:gpt-5-mini",
      prompt:
        "You help analyze a reverse-engineering investigation shown in the panel. " +
        "You cannot run tools yourself; answer from the visible state and suggest " +
        "which read-only provider query the operator should run.",
    }),
  },
});

const port = Number(process.env.COPILOT_PORT ?? "8200");

createServer(
  createCopilotNodeListener({
    runtime,
    basePath: "/api/copilotkit",
    cors: true,
  }),
).listen(port, "127.0.0.1", () => {
  process.stdout.write(
    `Copilot Runtime listening at http://127.0.0.1:${String(port)}/api/copilotkit\n`,
  );
});
