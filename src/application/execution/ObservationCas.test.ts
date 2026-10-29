import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileObservationStore, putObservationWindow, readObservationWindow } from "./ObservationCas.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

describe("observation CAS", () => {
  it("stores and recovers a complete immutable window", async () => {
    const directory = await mkdtemp(join(tmpdir(), "xtna-cas-")); directories.push(directory);
    const store = new FileObservationStore(directory);
    const page = await putObservationWindow(store, [{ fact: "one" }, { fact: "two" }]);
    expect(await readObservationWindow(store, page.digest)).toMatchObject({ items: page.items, total: 2 });
  });

  it("rejects modified bytes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "xtna-cas-")); directories.push(directory);
    const store = new FileObservationStore(directory);
    const page = await putObservationWindow(store, ["original"]);
    await writeFile(join(directory, `${page.digest}.json`), JSON.stringify({ version: 1, items: ["changed"] }));
    await expect(readObservationWindow(store, page.digest)).rejects.toThrow("does not match");
    await expect(readFile(join(directory, `${page.digest}.json`), "utf8")).resolves.toContain("changed");
  });
});
