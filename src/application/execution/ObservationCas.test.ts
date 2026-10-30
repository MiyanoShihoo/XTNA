import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  FileObservationStore,
  putObservationWindow,
  readObservationWindow,
} from "./ObservationCas.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) =>
      rm(path, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 20,
      }),
    ),
  );
});

describe("observation CAS", () => {
  it("stores and pages a complete immutable window without overlap", async () => {
    const directory = await mkdtemp(join(tmpdir(), "xtna-cas-"));
    directories.push(directory);
    const store = new FileObservationStore(directory);
    const items = Array.from({ length: 250 }, (_, index) => ({ fact: index }));
    const first = await putObservationWindow(store, items, { limit: 100 });
    expect(first.items).toEqual(items.slice(0, 100));
    expect(first.total).toBe(250);
    expect(first.nextCursor).not.toBeNull();

    const second = await readObservationWindow(store, first.digest, {
      cursor: first.nextCursor,
      limit: 100,
    });
    expect(second.items).toEqual(items.slice(100, 200));
    expect(second.cursor).toBe(first.nextCursor);

    const third = await readObservationWindow(store, first.digest, {
      cursor: second.nextCursor,
      limit: 100,
    });
    expect(third.items).toEqual(items.slice(200));
    expect(third.nextCursor).toBeNull();
    expect(
      new Set([...first.items, ...second.items, ...third.items]).size,
    ).toBe(250);
  });

  it("rejects modified bytes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "xtna-cas-"));
    directories.push(directory);
    const store = new FileObservationStore(directory);
    const page = await putObservationWindow(store, ["original"]);
    await writeFile(
      join(directory, `${page.digest}.json`),
      JSON.stringify({ version: 1, items: ["changed"] }),
    );
    await expect(readObservationWindow(store, page.digest)).rejects.toThrow(
      "does not match",
    );
    await expect(
      readFile(join(directory, `${page.digest}.json`), "utf8"),
    ).resolves.toContain("changed");
  });

  it("rejects invalid limits and cursors from another window", async () => {
    const directory = await mkdtemp(join(tmpdir(), "xtna-cas-"));
    directories.push(directory);
    const store = new FileObservationStore(directory);
    const page = await putObservationWindow(store, ["one"]);
    await expect(
      readObservationWindow(store, page.digest, { limit: 0 }),
    ).rejects.toThrow("limit");
    await expect(
      readObservationWindow(store, page.digest, {
        cursor: `${"b".repeat(64)}:0`,
      }),
    ).rejects.toThrow("another window");
  });
});
