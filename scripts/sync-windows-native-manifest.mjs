#!/usr/bin/env node
/**
 * Keep the shipped Windows x64 addon manifest consistent with this package.
 *
 * The addon itself never reads a package version: it reports only its ABI and
 * Node-API versions. The manifest is a packaging contract, so a distribution
 * that ships the same binary bytes under a different version has to restate it
 * rather than fail every Windows native call with "belongs to another version".
 */
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const manifestPath = join(root, "native/windows/build/manifest.json");
const artifactPath = join(root, "native/windows/build/rea-windows-x64.node");

const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const artifact = await readFile(artifactPath);
const artifactSha256 = createHash("sha256").update(artifact).digest("hex");

const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const next = {
  ...manifest,
  packageVersion: pkg.version,
  artifactSha256,
};

if (
  manifest.packageVersion !== next.packageVersion ||
  manifest.artifactSha256 !== next.artifactSha256
) {
  await writeFile(manifestPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  console.log(
    `windows native manifest: ${String(manifest.packageVersion)} -> ${String(next.packageVersion)} (${artifactSha256.slice(0, 12)}…)`,
  );
} else {
  console.log("windows native manifest already current");
}
