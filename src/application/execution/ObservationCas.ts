import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface ObservationPage<T = unknown> {
  readonly digest: string;
  readonly cursor: string | null;
  readonly items: readonly T[];
  readonly nextCursor: string | null;
  readonly total: number;
}

export interface ObservationStore {
  put(bytes: Uint8Array): Promise<string>;
  get(digest: string): Promise<Uint8Array>;
}

/** Immutable bytes with identity checked on both write and read. */
export class FileObservationStore implements ObservationStore {
  constructor(readonly directory: string) {}
  async put(bytes: Uint8Array): Promise<string> {
    const digest = createHash("sha256").update(bytes).digest("hex");
    await mkdir(this.directory, { recursive: true });
    await writeFile(join(this.directory, `${digest}.json`), bytes, { flag: "wx" }).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    });
    return digest;
  }
  async get(digest: string): Promise<Uint8Array> {
    if (!/^[a-f0-9]{64}$/u.test(digest)) throw new TypeError("Invalid observation digest");
    const bytes = await readFile(join(this.directory, `${digest}.json`));
    if (createHash("sha256").update(bytes).digest("hex") !== digest) throw new Error("Observation content does not match its digest");
    return bytes;
  }
}

export const putObservationWindow = async <T>(store: ObservationStore, items: readonly T[], cursor?: string): Promise<ObservationPage<T>> => {
  const digest = await store.put(new TextEncoder().encode(JSON.stringify({ version: 1, items })));
  return { digest, cursor: cursor ?? null, items, nextCursor: digest, total: items.length };
};

export const readObservationWindow = async <T>(store: ObservationStore, digest: string): Promise<ObservationPage<T>> => {
  const value: unknown = JSON.parse(new TextDecoder().decode(await store.get(digest)));
  if (typeof value !== "object" || value === null || (value as { version?: unknown }).version !== 1 || !Array.isArray((value as { items?: unknown }).items)) throw new TypeError("Invalid observation window");
  const items = (value as { items: T[] }).items;
  return { digest, cursor: digest, items, nextCursor: null, total: items.length };
};
