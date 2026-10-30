#!/usr/bin/env node
/**
 * Report the host's isolation backends and decide whether a command tier may
 * run. The refusal is the feature: without a container or VM backend XTNA will
 * not call a command sandboxed.
 *
 * usage: node scripts/sandbox.mjs [--json] [--tier L1|L2|L3] [--diff-preview] [--approval-token <token>]
 */
const args = process.argv.slice(2);
const flag = (name) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};

const { probeSandboxCapability, admitCommand } = await import(
  new URL("../dist/application/sandbox/SandboxCapability.js", import.meta.url)
    .href
);

const capability = await probeSandboxCapability();
const tier = flag("tier");
const admission =
  tier === undefined
    ? undefined
    : admitCommand({
        tier,
        capability,
        diffPreview: args.includes("--diff-preview"),
        approvalToken: flag("approval-token"),
      });

const report = {
  capability,
  ...(admission === undefined ? {} : { tier, admission }),
};
if (args.includes("--json")) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
  const lines = [
    `platform: ${capability.platform}`,
    `best isolation: ${capability.best}`,
    `backends: ${capability.backends.map((entry) => `${entry.id} (${entry.isolation}${entry.interactiveOnly ? ", interactive only" : ""})`).join(", ") || "none"}`,
    ...capability.probes.map(
      (probe) =>
        `probe ${probe.id}: ${probe.ok ? "ok" : "absent"} — ${probe.detail}`,
    ),
    ...(admission === undefined
      ? []
      : [
          `tier ${String(tier)}: ${admission.allowed ? "allowed" : "refused"} — ${admission.reason}`,
        ]),
  ];
  process.stdout.write(`${lines.join("\n")}\n`);
}
if (admission !== undefined && !admission.allowed) process.exitCode = 4;
