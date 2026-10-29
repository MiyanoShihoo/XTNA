#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { executeReActDag } from "../dist/application/execution/ReActDagPlanner.js";

const args = process.argv.slice(2);
const flag = (name, fallback) =>
  args.indexOf(`--${name}`) >= 0
    ? args[args.indexOf(`--${name}`) + 1]
    : fallback;
const path = flag("plan");
if (path === undefined) {
  process.stderr.write(
    "usage: node scripts/react-plan.mjs --plan plan.json [--concurrency 4]\nplan: {tasks:[{id,operation,authority,input,dependencies,result,approved,dryRun}]}\n",
  );
  process.exit(2);
}
const plan = JSON.parse(
  (await readFile(resolve(path), "utf8")).replace(/^\uFEFF/u, ""),
);
if (!Array.isArray(plan.tasks))
  throw new TypeError("Plan tasks must be an array");
const controller = new AbortController();
process.once("SIGINT", () =>
  controller.abort(new Error("Operator interrupted the plan")),
);
const result = await executeReActDag(
  plan.tasks.map((task) => ({
    ...task,
    execute: async (input, dependencies) => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (controller.signal.aborted) controller.signal.throwIfAborted();
      return { result: task.result ?? null, input, dependencies };
    },
  })),
  {
    maxConcurrency: Number(flag("concurrency", "4")),
    signal: controller.signal,
  },
);
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (result.status !== "completed") process.exitCode = 1;
