/**
 * Generate a stateful mock server from a recorded HTTP capture.
 *
 * The capture decides which resources exist: a `GET /users` response that is an
 * array seeds the collection, and `GET /users/{id}` seeds individual records.
 * The generated server implements list/read/create/update/delete over that seed
 * and replays any other recorded request verbatim. State lives in an in-memory
 * or file-backed SQLite database when `node:sqlite` is available, and falls back
 * to a plain in-memory map otherwise.
 *
 * A captured paged envelope (`{ items: [...], next_cursor: "..." }`) keeps its
 * envelope keys and gains working cursor pagination; a captured create response
 * that returns server-generated timestamps gets those timestamps synthesized.
 */
import { MOCK_SERVER_RUNTIME } from "./MockServerRuntime.js";

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface MockRoute {
  readonly method: string;
  readonly template: string;
  readonly kind: "list" | "read" | "create" | "update" | "delete" | "replay";
  readonly collection: string | undefined;
  readonly status: number;
  readonly body: JsonValue | undefined;
}

/** Envelope keys a captured list response used for paging. */
export interface MockPageShape {
  readonly itemsKey: string;
  readonly cursorKey: string | undefined;
  readonly hasMoreKey: string | undefined;
  readonly defaultLimit: number | undefined;
}

export interface MockModel {
  readonly routes: readonly MockRoute[];
  readonly seed: Readonly<Record<string, readonly JsonValue[]>>;
  /** Paged list envelopes keyed by `METHOD template`. */
  readonly pages: Readonly<Record<string, MockPageShape>>;
  /** Server-generated timestamp fields per collection, observed on create. */
  readonly timestamps: Readonly<Record<string, readonly string[]>>;
}

export interface MockServerOptions {
  /** Default port written into the generated file. */
  readonly port?: number;
  /** Optional JSON state file the generated memory backend loads and rewrites. */
  readonly persist?: string;
  /**
   * `sqlite` (default) prefers the built-in SQLite backend and falls back to
   * memory when `node:sqlite` is unavailable; `memory` never imports it.
   */
  readonly backend?: "sqlite" | "memory";
  /** SQLite file path; `:memory:` keeps state for the process lifetime. */
  readonly sqlite?: string;
  /** Header comment. */
  readonly header?: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const entriesOf = (document: unknown): unknown[] => {
  if (!isRecord(document)) return [];
  const log = document.log;
  if (isRecord(log)) return Array.isArray(log.entries) ? log.entries : [];
  return Array.isArray(document.entries) ? document.entries : [];
};

const parseJsonText = (value: unknown): JsonValue | undefined => {
  if (typeof value !== "string" || value.trim() === "") return undefined;
  try {
    return JSON.parse(value) as JsonValue;
  } catch {
    return undefined;
  }
};

const segmentsOf = (pathname: string): string[] =>
  pathname.split("/").filter((segment) => segment.length > 0);

const isIdSegment = (segment: string): boolean =>
  /^\d+$/u.test(segment) ||
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(
    segment,
  );

const templateOf = (pathname: string): string => {
  const segments = segmentsOf(pathname).map((segment) =>
    isIdSegment(segment) ? "{id}" : segment,
  );
  return `/${segments.join("/")}`;
};

const collectionOf = (template: string): string | undefined => {
  const segments = template.split("/").filter(Boolean);
  const first = segments[0];
  return first === undefined || first === "{id}" ? undefined : first;
};

const PAGE_ITEM_KEYS = [
  "items",
  "data",
  "results",
  "records",
  "rows",
  "list",
] as const;

const PAGE_CURSOR_KEYS = [
  "next_cursor",
  "nextCursor",
  "next_page_token",
  "nextPageToken",
  "cursor",
  "next",
] as const;

const PAGE_MORE_KEYS = [
  "has_more",
  "hasMore",
  "more",
  "has_next",
  "hasNext",
] as const;

const pageShapeOf = (
  body: JsonValue | undefined,
): MockPageShape | undefined => {
  if (!isRecord(body)) return undefined;
  const itemsKey = PAGE_ITEM_KEYS.find((key) => Array.isArray(body[key]));
  if (itemsKey === undefined) return undefined;
  const cursorKey = PAGE_CURSOR_KEYS.find((key) => key in body);
  const hasMoreKey = PAGE_MORE_KEYS.find((key) => key in body);
  if (cursorKey === undefined && hasMoreKey === undefined) return undefined;
  const items = body[itemsKey];
  return {
    itemsKey,
    cursorKey,
    hasMoreKey,
    defaultLimit:
      Array.isArray(items) && items.length > 0 ? items.length : undefined,
  };
};

const itemsOf = (body: JsonValue | undefined): readonly JsonValue[] => {
  if (Array.isArray(body)) return body;
  const page = pageShapeOf(body);
  if (page === undefined || !isRecord(body)) return [];
  const items = body[page.itemsKey];
  return Array.isArray(items) ? items : [];
};

const requestBodyOf = (request: Record<string, unknown>): unknown => {
  const postData = request.postData;
  if (!isRecord(postData)) return undefined;
  return parseJsonText(postData.text);
};

const ISO_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u;

/**
 * Fields the server generated: present in the recorded create response but
 * absent from the recorded request, and shaped like an ISO timestamp.
 */
const generatedTimestampFields = (
  request: unknown,
  response: JsonValue | undefined,
): readonly string[] => {
  if (!isRecord(response)) return [];
  const sent = isRecord(request) ? request : {};
  return Object.entries(response)
    .filter(
      ([key, value]) =>
        !(key in sent) &&
        typeof value === "string" &&
        ISO_TIMESTAMP.test(value),
    )
    .map(([key]) => key);
};

const kindOf = (method: string, itemRoute: boolean): MockRoute["kind"] => {
  if (method === "GET") return itemRoute ? "read" : "list";
  if (method === "POST") return "create";
  if (method === "PUT" || method === "PATCH") return "update";
  if (method === "DELETE") return "delete";
  return "replay";
};

const pathnameOf = (rawUrl: string): string => {
  try {
    return new URL(rawUrl).pathname;
  } catch {
    return rawUrl.split("?")[0] || "/";
  }
};

interface CapturedEntry {
  readonly key: string;
  readonly request: Record<string, unknown>;
  readonly route: MockRoute;
}

const entryOf = (entry: unknown): CapturedEntry | undefined => {
  if (!isRecord(entry) || !isRecord(entry.request)) return undefined;
  const request = entry.request;
  const response = isRecord(entry.response) ? entry.response : undefined;
  const method =
    typeof request.method === "string" ? request.method.toUpperCase() : "GET";
  const rawUrl = typeof request.url === "string" ? request.url : "";
  const template = templateOf(pathnameOf(rawUrl));
  const collection = collectionOf(template);
  const body = isRecord(response?.content)
    ? parseJsonText(response.content.text)
    : undefined;
  return {
    key: `${method} ${template}`,
    request,
    route: {
      method,
      template,
      kind: kindOf(method, template.endsWith("/{id}")),
      collection,
      status: typeof response?.status === "number" ? response.status : 200,
      body,
    },
  };
};

const mergeRecord = (
  list: JsonValue[],
  item: Record<string, unknown>,
): void => {
  const index =
    item.id === undefined
      ? -1
      : list.findIndex(
          (candidate) =>
            isRecord(candidate) && String(candidate.id) === String(item.id),
        );
  if (index >= 0) list[index] = item as JsonValue;
  else list.push(item as JsonValue);
};

const seedCollection = (
  seed: Record<string, JsonValue[]>,
  collection: string,
  body: JsonValue | undefined,
): void => {
  const list = (seed[collection] ??= []);
  for (const item of itemsOf(body)) if (isRecord(item)) mergeRecord(list, item);
};

const noteTimestamps = (
  timestamps: Record<string, string[]>,
  collection: string,
  request: Record<string, unknown>,
  body: JsonValue | undefined,
): void => {
  const generated = generatedTimestampFields(requestBodyOf(request), body);
  if (generated.length === 0) return;
  const known = new Set(timestamps[collection] ?? []);
  for (const field of generated) known.add(field);
  timestamps[collection] = [...known];
};

/**
 * A recorded collection implies the rest of CRUD: the capture rarely shows
 * every verb, but a mock that cannot update or delete is not useful.
 */
const synthesizeCrud = (routes: Map<string, MockRoute>): void => {
  const collections = new Set(
    [...routes.values()]
      .filter((route) => route.kind === "list")
      .flatMap((route) =>
        route.collection === undefined ? [] : [route.collection],
      ),
  );
  for (const collection of collections) {
    const add = (
      method: string,
      template: string,
      kind: MockRoute["kind"],
      status: number,
    ) => {
      const key = `${method} ${template}`;
      if (!routes.has(key))
        routes.set(key, {
          method,
          template,
          kind,
          collection,
          status,
          body: undefined,
        });
    };
    add("POST", `/${collection}`, "create", 201);
    add("PUT", `/${collection}/{id}`, "update", 200);
    add("PATCH", `/${collection}/{id}`, "update", 200);
    add("DELETE", `/${collection}/{id}`, "delete", 204);
  }
};

/** Extract the routes and the seed state a capture implies. */
export function buildMockModel(document: unknown): MockModel {
  const routes = new Map<string, MockRoute>();
  const seed: Record<string, JsonValue[]> = {};
  const pages: Record<string, MockPageShape> = {};
  const timestamps: Record<string, string[]> = {};
  for (const entry of entriesOf(document)) {
    const captured = entryOf(entry);
    if (captured === undefined) continue;
    const { key, request, route } = captured;
    routes.set(key, route);
    if (route.collection === undefined) continue;
    if (route.kind === "list") {
      const page = pageShapeOf(route.body);
      if (page !== undefined) pages[key] = page;
      seedCollection(seed, route.collection, route.body);
    }
    if (route.kind === "create")
      noteTimestamps(timestamps, route.collection, request, route.body);
  }
  synthesizeCrud(routes);
  return {
    routes: [...routes.values()].sort((left, right) =>
      `${left.method} ${left.template}`.localeCompare(
        `${right.method} ${right.template}`,
      ),
    ),
    seed,
    pages,
    timestamps,
  };
}

/** Render the generated server source. */
export function renderMockServer(
  model: MockModel,
  options: MockServerOptions = {},
): string {
  const port = options.port ?? 8080;
  const backend = options.backend ?? "sqlite";
  const sqlite = options.sqlite ?? ":memory:";
  const persisted = options.persist !== undefined && backend === "memory";
  const header =
    options.header ??
    `Generated by XTNA from a recorded capture. State starts from the capture and lives in ${persisted ? "memory with a JSON state file" : backend === "sqlite" ? `SQLite (${sqlite})` : "memory"}.`;
  const source = MOCK_SERVER_RUNTIME.replace("__MODEL__", () =>
    JSON.stringify(model),
  )
    .replace("__STATE__", () => JSON.stringify(options.persist ?? null))
    .replace("__SQLITE__", () => JSON.stringify(sqlite))
    .replace("__BACKEND__", () => JSON.stringify(backend))
    .replace("__PORT__", () => String(port));
  const notes = [
    `// ${header}`,
    ...(persisted ? [`// State file: ${String(options.persist)}`] : []),
  ];
  return [...notes, source].join("\n");
}
