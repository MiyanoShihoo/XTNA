#!/usr/bin/env node
/**
 * XTNA distribution checks that do not need the Vite test pipeline.
 * Run after `npm run compile`: node scripts/xtna-verify.mjs
 */
import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const results = [];

const check = (name, fn) => {
  try {
    const outcome = fn();
    results.push({ name, ok: true, skipped: outcome === "skipped" });
  } catch (error) {
    results.push({ name, ok: false, error });
  }
};

const { traverseApplicationFeature } = await import(
  pathToFileURL(join(root, "dist/domain/javascript/javascriptFeatureTraversal.js")).href
);

const graphOf = (nodeIds, pairs) => ({
  nodes: nodeIds.map((nodeId) => ({ node_id: nodeId })),
  edges: pairs.map(([source, target]) => ({
    edge_id: `jag_edge_${source}_${target}`,
    source_node_id: source,
    target_node_id: target,
  })),
});

const chain = graphOf(
  ["a", "b", "c", "d"],
  [
    ["a", "b"],
    ["b", "c"],
    ["c", "d"],
  ],
);

check("no ceiling returns the whole component", () => {
  const traversal = traverseApplicationFeature(chain, ["a"], "outgoing");
  assert.deepEqual(
    traversal.nodes.map(({ node_id }) => node_id),
    ["a", "b", "c", "d"],
  );
  assert.equal(traversal.truncated, false);
});

check("max_hops stops expansion and reports the boundary", () => {
  const traversal = traverseApplicationFeature(chain, ["a"], "outgoing", 2);
  assert.deepEqual(
    traversal.nodes.map(({ node_id }) => node_id),
    ["a", "b", "c"],
  );
  assert.equal(traversal.truncated, true);
  assert.deepEqual(traversal.truncatedNodeIds, ["c"]);
});

check("a closing edge inside the projection is retained", () => {
  const cyclic = graphOf(
    ["a", "b", "c"],
    [
      ["a", "b"],
      ["b", "c"],
      ["c", "a"],
    ],
  );
  const traversal = traverseApplicationFeature(cyclic, ["a"], "outgoing", 2);
  assert.equal(traversal.truncated, false);
  assert.equal(traversal.edges.length, 3);
});

check("both directions honour the ceiling", () => {
  const graph = graphOf(
    ["seed", "upstream", "downstream", "far"],
    [
      ["upstream", "seed"],
      ["seed", "downstream"],
      ["downstream", "far"],
    ],
  );
  const traversal = traverseApplicationFeature(graph, ["seed"], "both", 1);
  assert.deepEqual(
    traversal.nodes.map(({ node_id }) => node_id),
    ["downstream", "seed", "upstream"],
  );
  assert.equal(traversal.truncated, true);
});

const overlayModule = await import(
  pathToFileURL(join(root, "dist/application/overlays/SymbolOverlayRendering.js")).href
);

check("overlay rendering replaces address-derived identifiers", () => {
  const rendered = overlayModule.applySymbolOverlay(
    "undefined4 sub_401000(int param_1) { return sub_40a1b0(param_1); }",
    [
      { address_hex: "0x401000", name: "WinMain_candidate" },
      { address_hex: "0x40a1b0", name: "g_pak_loader" },
    ],
  );
  assert.equal(rendered.replacements.length, 2);
  assert.match(rendered.text, /WinMain_candidate/u);
  assert.match(rendered.text, /g_pak_loader/u);
  assert.doesNotMatch(rendered.text, /sub_401000/u);
});

check("overlay rendering leaves unknown placeholders untouched", () => {
  const rendered = overlayModule.applySymbolOverlay("sub_500000();", []);
  assert.equal(rendered.text, "sub_500000();");
  assert.equal(rendered.replacements.length, 0);
});
const { PRODUCT_IDENTITY } = await import(pathToFileURL(join(root, "dist/identity.js")).href);
check("product identity is XTNA", () => {
  assert.equal(PRODUCT_IDENTITY.displayName, "XTNA");
  assert.equal(PRODUCT_IDENTITY.cliBinary, "xtna");
  assert.equal(PRODUCT_IDENTITY.mcpServerKey, "xtna");
  assert.equal(PRODUCT_IDENTITY.configFileName, "xtna.json");
});

const handshake = await new Promise((resolve) => {
  let child;
  try {
    child = spawn(process.execPath, [join(root, "scripts/rea.mjs"), "mcp"], {
      cwd: root,
      stdio: ["pipe", "pipe", "ignore"],
    });
  } catch (error) {
    // A host sandbox can deny pipe spawning; the check is reported as skipped.
    resolve({ skipped: true, reason: error.message });
    return;
  }
  let out = "";
  const timer = setTimeout(() => {
    child.kill();
    resolve({ ok: false, reason: "initialize timed out" });
  }, 20000);
  child.stdout.on("data", (chunk) => {
    out += String(chunk);
    if (out.includes('"serverInfo"')) {
      clearTimeout(timer);
      child.kill();
      resolve({ ok: true, out });
    }
  });
  child.on("error", (error) => {
    clearTimeout(timer);
    resolve({ ok: false, reason: error.message });
  });
  child.stdin.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "xtna-verify", version: "1" },
      },
    })}\n`,
  );
});

check("MCP initialize reports the XTNA server identity", () => {
  if (handshake.skipped === true) return "skipped";
  assert.equal(handshake.ok, true, handshake.reason);
  const line = handshake.out
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.includes('"serverInfo"'));
  const parsed = JSON.parse(line);
  assert.equal(parsed.result.serverInfo.name, "xtna");
  assert.equal(parsed.result.serverInfo.version, PRODUCT_IDENTITY.packageVersion);
});

let failed = 0;
for (const { name, ok, skipped, error } of results) {
  console.log(`${ok ? (skipped ? "skip" : "ok  ") : "FAIL"} ${name}`);
  if (!ok) {
    failed += 1;
    console.log(String(error?.stack ?? error));
  }
}
console.log(`\n${String(results.length - failed)}/${String(results.length)} checks passed`);
process.exitCode = failed === 0 ? 0 : 1;
