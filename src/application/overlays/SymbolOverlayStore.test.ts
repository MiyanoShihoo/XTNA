import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it } from "vitest";

import { applySymbolOverlay } from "./SymbolOverlayRendering.js";
import { SymbolOverlayStore } from "./SymbolOverlayStore.js";

const target = "a".repeat(64);
const hypothesis = {
  target_sha256: target,
  address_hex: "0x00401000",
  name: "parseOrderPayload",
  rationale: "Parser consumes order fields",
  evidenceIds: ["ev_1234"],
};

it("persists evidence-backed symbol hypotheses and renders immutable text", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xtna-overlay-"));
  try {
    const opened = await SymbolOverlayStore.open(directory);
    if (!opened.ok) throw new Error("open failed");
    const committed = await opened.value.commit(hypothesis);
    expect(committed.ok).toBe(true);
    expect((await opened.value.commit(hypothesis)).ok).toBe(false);
    expect(
      (await opened.value.commit({ ...hypothesis, address_hex: "0x401000" }))
        .ok,
    ).toBe(false);
    const source = "void sub_00401000(void) { sub_140002000(); }";
    expect(applySymbolOverlay(source, opened.value.list(target))).toEqual({
      text: "void parseOrderPayload(void) { sub_140002000(); }",
      replacements: [{ from: "sub_00401000", to: "parseOrderPayload" }],
    });
    const reloaded = await SymbolOverlayStore.open(directory);
    if (!reloaded.ok) throw new Error("reload failed");
    expect(reloaded.value.list(target)).toHaveLength(1);
    expect(reloaded.value.list(target)[0]?.address_hex).toBe("0x401000");
    expect(reloaded.value.exportMapping(target, "ghidra")).toEqual({
      ok: true,
      value: "401000 parseOrderPayload\n",
    });
    expect(
      JSON.parse(await readFile(join(directory, "symbols.json"), "utf8"))
        .version,
    ).toBe(1);
  } finally {
    await rm(directory, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 20,
    });
  }
});

it("rejects unproven names, addresses, and persisted records", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xtna-overlay-invalid-"));
  try {
    const opened = await SymbolOverlayStore.open(directory);
    if (!opened.ok) throw new Error("open failed");
    expect(
      (await opened.value.commit({ ...hypothesis, evidenceIds: [] })).ok,
    ).toBe(false);
    expect(
      (await opened.value.commit({ ...hypothesis, name: "not valid!" })).ok,
    ).toBe(false);
    expect(
      (await opened.value.commit({ ...hypothesis, address_hex: "0xzz" })).ok,
    ).toBe(false);
    await writeFile(
      join(directory, "symbols.json"),
      JSON.stringify({
        version: 1,
        entries: [{ ...hypothesis, address_hex: "0x401000" }],
      }),
      "utf8",
    );
    expect((await SymbolOverlayStore.open(directory)).ok).toBe(false);
  } finally {
    await rm(directory, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 20,
    });
  }
});

it("sorts mappings by numeric address", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xtna-overlay-sort-"));
  try {
    const opened = await SymbolOverlayStore.open(directory);
    if (!opened.ok) throw new Error("open failed");
    await opened.value.commit({
      ...hypothesis,
      address_hex: "0x1000",
      name: "high",
    });
    await opened.value.commit({
      ...hypothesis,
      address_hex: "0x900",
      name: "low",
    });
    expect(opened.value.list(target).map(({ name }) => name)).toEqual([
      "low",
      "high",
    ]);
  } finally {
    await rm(directory, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 20,
    });
  }
});
