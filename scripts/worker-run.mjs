#!/usr/bin/env node
/**
 * Human-gated CLI for one process-backed worker plan.
 *
 * The plan names an explicit command for every task. Nothing is inferred from a
 * role, and no plan runs without `--yes` or an interactive confirmation.
 *
 * usage: node scripts/worker-run.mjs --plan <plan.json> [--yes] [--json]
 */
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const flag = (name) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};

const planPath = flag("plan");
if (planPath === undefined) {
  process.stderr.write(
    "usage: node scripts/worker-run.mjs --plan <plan.json> [--yes] [--json]\n",
  );
  process.exit(2);
}

const { runWorkerPlan } = await import(
  pathToFileURL(resolve("dist/application/execution/WorkerScheduler.js")).href
);
const { createProcessWorkerHandler } = await import(
  pathToFileURL(resolve("dist/application/execution/ProcessWorker.js")).href
);

const raw = await readFile(resolve(planPath), "utf8");
let plan;
try {
  plan = JSON.parse(raw.replace(/^\uFEFF/u, ""));
} catch {
  process.stderr.write("plan is not valid JSON\n");
  process.exit(2);
}
if (
  plan === null ||
  typeof plan !== "object" ||
  !Array.isArray(plan.tasks) ||
  plan.tasks.length === 0
) {
  process.stderr.write("plan.tasks must be a nonempty array\n");
  process.exit(2);
}

const tasks = [];
const commands = {};
for (const [index, task] of plan.tasks.entries()) {
  if (
    task === null ||
    typeof task !== "object" ||
    typeof task.id !== "string" ||
    typeof task.role !== "string" ||
    typeof task.objective !== "string" ||
    task.command === null ||
    typeof task.command !== "object" ||
    typeof task.command.command !== "string"
  ) {
    process.stderr.write(`plan.tasks[${String(index)}] is not a valid task\n`);
    process.exit(2);
  }
  tasks.push({
    id: task.id,
    role: task.role,
    objective: task.objective,
    ...(Array.isArray(task.dependencies)
      ? { dependencies: task.dependencies }
      : {}),
  });
  commands[task.id] = task.command;
}

if (!args.includes("--yes")) {
  if (!process.stdin.isTTY) {
    process.stderr.write(
      "refusing to launch workers without a human confirmation; pass --yes in an explicit non-interactive run\n",
    );
    process.exit(3);
  }
  process.stdout.write("planned worker processes:\n");
  for (const task of tasks) {
    const command = commands[task.id];
    process.stdout.write(
      `  ${task.id} [${task.role}] ${command.command} ${(command.arguments ?? []).join(" ")}\n`,
    );
  }
  const terminal = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const answer = await terminal.question("run these workers? [y/N] ");
  terminal.close();
  if (!/^y(?:es)?$/iu.test(answer.trim())) {
    process.stderr.write("cancelled\n");
    process.exit(3);
  }
}

const handler = createProcessWorkerHandler(commands);
const report = await runWorkerPlan(tasks, {
  handlers: {
    "static-worker": handler,
    "runtime-worker": handler,
    "contract-worker": handler,
  },
  maxAttempts: Math.max(1, Number(plan.maxAttempts ?? 1)),
  timeoutMs: Math.max(1, Number(plan.timeoutMs ?? 15_000)),
});

if (args.includes("--json")) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else if (report.ok) {
  for (const task of report.value.tasks)
    process.stdout.write(
      `${task.status.padEnd(9)} ${task.id}${task.reason === undefined ? "" : ` — ${task.reason}`}\n`,
    );
} else {
  process.stderr.write(`plan error: ${report.error.message}\n`);
}

const failed =
  !report.ok || report.value.tasks.some((task) => task.status !== "completed");
process.exitCode = failed ? 1 : 0;
