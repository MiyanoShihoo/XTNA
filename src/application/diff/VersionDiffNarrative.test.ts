import { describe, expect, it } from "vitest";

import { diffDocuments, narrateDiff } from "./VersionDiffNarrative.js";

const before = [
  { name: "parseOrder", kind: "function", size: 120 },
  { name: "saveConfig", kind: "function", size: 64 },
  { name: "legacyInit", kind: "function", size: 10 },
];

const after = [
  { name: "parseOrder", kind: "function", size: 120 },
  { name: "saveConfig", kind: "function", size: 96 },
  { name: "newDispatch", kind: "function", size: 40 },
];

describe("document diff", () => {
  it("classifies added, removed, changed and unchanged records", () => {
    const diff = diffDocuments(before, after);
    expect(diff.key).toBe("name");
    expect(diff.added.map((row) => row.key)).toEqual(["newDispatch"]);
    expect(diff.removed.map((row) => row.key)).toEqual(["legacyInit"]);
    expect(diff.changed.map((row) => row.key)).toEqual(["saveConfig"]);
    expect(diff.unchanged).toBe(1);
  });

  it("lists the fields that changed", () => {
    const diff = diffDocuments(before, after);
    expect(diff.changed[0]?.changedFields).toEqual(["size"]);
  });

  it("finds a nested collection when the root is an object", () => {
    const diff = diffDocuments(
      { report: { items: [{ name: "a", value: 1 }] } },
      {
        report: {
          items: [
            { name: "a", value: 2 },
            { name: "b", value: 3 },
          ],
        },
      },
    );
    expect(diff.added.map((row) => row.key)).toEqual(["b"]);
    expect(diff.changed.map((row) => row.key)).toEqual(["a"]);
  });

  it("pairs by an explicit key", () => {
    const diff = diffDocuments(
      [{ id: "x", label: "one" }],
      [{ id: "x", label: "two" }],
      { key: "id" },
    );
    expect(diff.key).toBe("id");
    expect(diff.changed[0]?.changedFields).toEqual(["label"]);
  });

  it("reports no change when the documents match", () => {
    const diff = diffDocuments(before, before);
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(diff.changed).toEqual([]);
    expect(diff.unchanged).toBe(3);
  });
});

describe("narrative", () => {
  it("summarises counts and lists every section", () => {
    const text = narrateDiff(diffDocuments(before, after));
    expect(text).toContain("1 added, 1 removed, 1 changed, 1 unchanged");
    expect(text).toContain("## Added");
    expect(text).toContain("`newDispatch`");
    expect(text).toContain("## Removed");
    expect(text).toContain("## Changed");
    expect(text).toContain("`saveConfig` — `size`");
  });

  it("states the absence of change explicitly", () => {
    const text = narrateDiff(diffDocuments(before, before));
    expect(text).toContain("No structural change across 3 records");
  });
});
