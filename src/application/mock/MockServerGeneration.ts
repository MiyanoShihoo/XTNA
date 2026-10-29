/**
 * Generate a stateful mock server from a recorded HTTP capture.
 *
 * The capture decides which resources exist: a `GET /users` response that is an
 * array seeds the collection, and `GET /users/{id}` seeds individual records.
 * The generated server implements list/read/create/update/delete over that seed
 * and replays any other recorded request verbatim. It is a single file with no
 * dependencies beyond `node:http` and `node:fs`.
 */
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

export interface MockModel {
  readonly routes: readonly MockRoute[];
  readonly seed: Readonly<Record<string, readonly JsonValue[]>>;
}

export interface MockServerOptions {
  /** Default port written into the generated file. */
  readonly port?: number;
  /** Optional JSON state file the generated server loads and rewrites. */
  readonly persist?: string;
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

/** Extract the routes and the seed state a capture implies. */
export function buildMockModel(document: unknown): MockModel {
  const routes = new Map<string, MockRoute>();
  const seed: Record<string, JsonValue[]> = {};
  for (const entry of entriesOf(document)) {
    if (!isRecord(entry) || !isRecord(entry.request)) continue;
    const request = entry.request;
    const response = isRecord(entry.response) ? entry.response : undefined;
    const method =
      typeof request.method === "string" ? request.method.toUpperCase() : "GET";
    const rawUrl = typeof request.url === "string" ? request.url : "";
    let pathname = "/";
    try {
      pathname = new URL(rawUrl).pathname;
    } catch {
      pathname = rawUrl.split("?")[0] || "/";
    }
    const template = templateOf(pathname);
    const collection = collectionOf(template);
    const status = typeof response?.status === "number" ? response.status : 200;
    const body = isRecord(response?.content)
      ? parseJsonText(response.content.text)
      : undefined;
    const itemRoute = template.endsWith("/{id}");
    const kind: MockRoute["kind"] =
      method === "GET" && itemRoute
        ? "read"
        : method === "GET"
          ? "list"
          : method === "POST"
            ? "create"
            : method === "PUT" || method === "PATCH"
              ? "update"
              : method === "DELETE"
                ? "delete"
                : "replay";
    routes.set(`${method} ${template}`, {
      method,
      template,
      kind,
      collection,
      status,
      body,
    });
    if (collection !== undefined && method === "GET") {
      const list = (seed[collection] ??= []);
      if (Array.isArray(body))
        for (const item of body)
          if (isRecord(item)) {
            const id = item.id;
            const index =
              id === undefined
                ? -1
                : list.findIndex(
                    (candidate) =>
                      isRecord(candidate) &&
                      String(candidate.id) === String(id),
                  );
            if (index >= 0) list[index] = item as JsonValue;
            else list.push(item as JsonValue);
          }
      if (isRecord(body) && body.id !== undefined) {
        const id = String(body.id);
        const index = list.findIndex(
          (candidate) => isRecord(candidate) && String(candidate.id) === id,
        );
        if (index >= 0) list[index] = body as JsonValue;
        else list.push(body as JsonValue);
      }
    }
  }
  // A recorded collection implies the rest of CRUD: the capture rarely shows
  // every verb, but a mock that cannot update or delete is not useful.
  const collections = new Set(
    [...routes.values()]
      .filter((route) => route.kind === "list")
      .flatMap((route) =>
        route.collection === undefined ? [] : [route.collection],
      ),
  );
  for (const collection of collections) {
    const synthesize = (
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
    synthesize("POST", `/${collection}`, "create", 201);
    synthesize("PUT", `/${collection}/{id}`, "update", 200);
    synthesize("PATCH", `/${collection}/{id}`, "update", 200);
    synthesize("DELETE", `/${collection}/{id}`, "delete", 204);
  }
  return {
    routes: [...routes.values()].sort((left, right) =>
      `${left.method} ${left.template}`.localeCompare(
        `${right.method} ${right.template}`,
      ),
    ),
    seed,
  };
}

const RUNTIME = String.raw`
import { createServer } from "node:http";
import { readFileSync, writeFileSync } from "node:fs";

const model = __MODEL__;
const state = new Map(Object.entries(model.seed ?? {}).map(([key, value]) => [key, [...value]]));
const persist = __STATE__;
if (persist !== undefined && persist !== null) {
  try {
    const saved = JSON.parse(readFileSync(persist, "utf8"));
    for (const [key, value] of Object.entries(saved)) state.set(key, value);
  } catch {}
}
const save = () => {
  if (persist === undefined || persist === null) return;
  writeFileSync(persist, JSON.stringify(Object.fromEntries(state)), "utf8");
};

const send = (response, status, body) => {
  const text = body === undefined ? "" : JSON.stringify(body);
  response.writeHead(status, { "content-type": "application/json" });
  response.end(text);
};

const matchRoute = (method, pathname) => {
  const segments = pathname.split("/").filter(Boolean);
  for (const route of model.routes) {
    if (route.method !== method) continue;
    const expected = route.template.split("/").filter(Boolean);
    if (expected.length !== segments.length) continue;
    const id = expected.reduce((found, segment, index) => {
      if (found !== undefined) return found;
      return segment === "{id}" ? segments[index] : undefined;
    }, undefined);
    const matches = expected.every(
      (segment, index) => segment === "{id}" || segment === segments[index],
    );
    if (matches) return { route, id };
  }
  return undefined;
};

const body = async (request) =>
  new Promise((resolve) => {
    let raw = "";
    request.on("data", (chunk) => (raw += chunk));
    request.on("end", () => {
      try { resolve(raw === "" ? undefined : JSON.parse(raw)); } catch { resolve(undefined); }
    });
  });

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", "http://localhost");
  const found = matchRoute(request.method ?? "GET", url.pathname);
  if (found === undefined) return send(response, 404, { error: "no recorded route" });
  const { route, id } = found;
  const collection = route.collection;
  if (collection === undefined) return send(response, route.status, route.body);

  if (route.kind === "list") {
    const items = state.get(collection) ?? [];
    const limit = Number(url.searchParams.get("limit"));
    return send(response, 200, Number.isFinite(limit) && limit > 0 ? items.slice(0, limit) : items);
  }
  if (route.kind === "read") {
    const item = (state.get(collection) ?? []).find((candidate) => String(candidate.id) === String(id));
    return item === undefined ? send(response, 404, { error: "not found" }) : send(response, 200, item);
  }
  const items = state.get(collection) ?? [];
  if (route.kind === "create") {
    const payload = (await body(request)) ?? {};
    const nextId = items.reduce((max, item) => Math.max(max, Number(item.id) || 0), 0) + 1;
    const created = { ...payload, id: payload.id ?? nextId };
    items.push(created);
    state.set(collection, items);
    save();
    return send(response, 201, created);
  }
  if (route.kind === "update") {
    const payload = (await body(request)) ?? {};
    const index = items.findIndex((candidate) => String(candidate.id) === String(id));
    if (index < 0) return send(response, 404, { error: "not found" });
    items[index] = { ...items[index], ...payload, id: items[index].id };
    state.set(collection, items);
    save();
    return send(response, 200, items[index]);
  }
  if (route.kind === "delete") {
    const index = items.findIndex((candidate) => String(candidate.id) === String(id));
    if (index < 0) return send(response, 404, { error: "not found" });
    items.splice(index, 1);
    state.set(collection, items);
    save();
    return send(response, 204, undefined);
  }
  return send(response, route.status, route.body);
});
server.listen(Number(process.env.PORT ?? __PORT__), () => {
  const address = server.address();
  process.stdout.write(JSON.stringify({ port: typeof address === "object" && address ? address.port : null }) + "\n");
});
`;

/** Render the generated server source. */
export function renderMockServer(
  model: MockModel,
  options: MockServerOptions = {},
): string {
  const port = options.port ?? 8080;
  const header =
    options.header ??
    "Generated by XTNA from a recorded capture. State starts from the capture and lives in memory.";
  const source = RUNTIME.replace("__MODEL__", JSON.stringify(model))
    .replace("__STATE__", JSON.stringify(options.persist ?? null))
    .replace("__PORT__", String(port));
  return [
    `// ${header}`,
    ...(options.persist === undefined
      ? []
      : [`// State file: ${options.persist}`]),
    source,
  ].join("\n");
}
