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

export interface ObservationWindowOptions {
  /** Opaque cursor returned by a previous page; omit for the first page. */
  readonly cursor?: string | null;
  /** Maximum rows in this page. */
  readonly limit?: number;
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
    await writeFile(join(this.directory, `${digest}.json`), bytes, {
      flag: "wx",
    }).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    });
    return digest;
  }
  async get(digest: string): Promise<Uint8Array> {
    if (!/^[a-f0-9]{64}$/u.test(digest))
      throw new TypeError("Invalid observation digest");
    const bytes = await readFile(join(this.directory, `${digest}.json`));
    if (createHash("sha256").update(bytes).digest("hex") !== digest)
      throw new Error("Observation content does not match its digest");
    return bytes;
  }
}

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1_000;

const page = <T>(
  digest: string,
  items: readonly T[],
  options: ObservationWindowOptions,
): ObservationPage<T> => {
  const limit = options.limit ?? DEFAULT_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT)
    throw new RangeError(
      `Observation page limit must be an integer from 1 through ${MAX_LIMIT}.`,
    );
  const offset = parseCursor(digest, options.cursor ?? null);
  if (offset > items.length)
    throw new RangeError("Observation cursor is beyond the retained window.");
  const end = Math.min(items.length, offset + limit);
  return {
    digest,
    cursor: options.cursor ?? null,
    items: items.slice(offset, end),
    nextCursor: end < items.length ? `${digest}:${String(end)}` : null,
    total: items.length,
  };
};

const parseCursor = (digest: string, cursor: string | null): number => {
  if (cursor === null || cursor === digest) return 0;
  if (!cursor.startsWith(`${digest}:`))
    throw new TypeError("Observation cursor names another window");
  const offset = Number(cursor.slice(digest.length + 1));
  if (!Number.isSafeInteger(offset) || offset < 0)
    throw new TypeError("Observation cursor is invalid");
  return offset;
};

export const putObservationWindow = async <T>(
  store: ObservationStore,
  items: readonly T[],
  options: ObservationWindowOptions = {},
): Promise<ObservationPage<T>> => {
  const digest = await store.put(
    new TextEncoder().encode(JSON.stringify({ version: 1, items })),
  );
  return page(digest, items, options);
};

export const readObservationWindow = async <T>(
  store: ObservationStore,
  digest: string,
  options: ObservationWindowOptions = {},
): Promise<ObservationPage<T>> => {
  const value: unknown = JSON.parse(
    new TextDecoder().decode(await store.get(digest)),
  );
  if (
    typeof value !== "object" ||
    value === null ||
    (value as { version?: unknown }).version !== 1 ||
    !Array.isArray((value as { items?: unknown }).items)
  )
    throw new TypeError("Invalid observation window");
  return page(digest, (value as { items: T[] }).items, options);
};
