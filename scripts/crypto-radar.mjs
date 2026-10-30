#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const path = args.find((arg) => !arg.startsWith("--"));
const json = args.includes("--json");
const includeHints = args.includes("--include-hints");
if (path === undefined) {
  process.stderr.write(
    "usage: node scripts/crypto-radar.mjs <file> [--json] [--include-hints]\n",
  );
  process.exit(2);
}

const buffer = await readFile(resolve(path));
const { fingerprintAlgorithms } = await import(
  pathToFileURL(
    resolve("dist/application/javascript/AlgorithmFingerprinting.js"),
  ).href
);
const analyzed = fingerprintAlgorithms(buffer, {
  maxProtobufCandidates: includeHints ? 100 : 0,
});
if (!analyzed.ok) {
  process.stderr.write(`${analyzed.error.code}: ${analyzed.error.message}\n`);
  process.exit(1);
}
const result = analyzed.value;
const report = {
  artifact: { path: resolve(path), bytes: buffer.length },
  fingerprints: result.fingerprints,
  hits: result.fingerprints.map((finding) => ({
    offset: finding.offset,
    offset_hex: `0x${finding.offset.toString(16)}`,
    name: finding.algorithm,
    kind: finding.category,
    confidence: finding.confidence,
  })),
  unknowns: result.unknowns,
  coverage: result.coverage,
  limits: result.limits,
  limitations: [
    "Static signatures establish byte evidence, not execution or runtime use.",
    "Absence is not proof: generated, transformed, or unknown implementations leave different evidence.",
  ],
};

if (json) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
  console.log(`file    ${resolve(path)}`);
  console.log(`bytes   ${String(buffer.length)}`);
  console.log(`hits    ${String(report.hits.length)}`);
  for (const hit of report.hits.slice(0, 40))
    console.log(
      `${hit.offset_hex.padEnd(10)} ${hit.kind.padEnd(14)} ${hit.confidence.padEnd(6)} ${hit.name}`,
    );
  if (report.hits.length > 40)
    console.log(`... ${String(report.hits.length - 40)} more`);
}
