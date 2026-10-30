/**
 * Runtime template for the generated mock server.
 *
 * Placeholders are substituted by `renderMockServer`: `__MODEL__`, `__STATE__`,
 * `__SQLITE__`, `__BACKEND__` and `__PORT__`. The generated module uses only
 * Node built-ins so it can run without installing anything.
 */
export const MOCK_SERVER_RUNTIME = String.raw`
import { createServer } from "node:http";
import { readFileSync, writeFileSync } from "node:fs";

const model = __MODEL__;
const persist = __STATE__;
const sqlitePath = __SQLITE__;
const preferredBackend = __BACKEND__;

const timestampsFor = (collection) => (model.timestamps ?? {})[collection] ?? [];
const pageFor = (method, template) => (model.pages ?? {})[method + " " + template];

const nowIso = () => new Date().toISOString();

const stampTimestamps = (record, fields) => {
  for (const field of fields) {
    if (record[field] === undefined) record[field] = nowIso();
  }
  return record;
};

const encodeCursor = (offset) =>
  Buffer.from(String(offset), "utf8").toString("base64url");

const decodeCursor = (value) => {
  try {
    const raw = Buffer.from(String(value), "base64url").toString("utf8");
    return /^[0-9]+$/u.test(raw) ? Number(raw) : undefined;
  } catch {
    return undefined;
  }
};

const nextNumericId = (items) =>
  items.reduce((max, item) => Math.max(max, Number(item && item.id) || 0), 0) + 1;

const createMemoryStore = (seed, stateFile) => {
  const state = new Map(
    Object.entries(seed ?? {}).map(([key, value]) => [key, value.slice()]),
  );
  if (stateFile !== null) {
    try {
      const saved = JSON.parse(readFileSync(stateFile, "utf8"));
      for (const [key, value] of Object.entries(saved)) state.set(key, value);
    } catch {}
  }
  const save = () => {
    if (stateFile === null) return;
    writeFileSync(stateFile, JSON.stringify(Object.fromEntries(state)), "utf8");
  };
  return {
    kind: "memory",
    all: (collection) => state.get(collection) ?? [],
    page: (collection, limit, offset) => {
      const items = state.get(collection) ?? [];
      return { items: items.slice(offset, offset + limit), total: items.length };
    },
    get: (collection, id) =>
      (state.get(collection) ?? []).find((item) => String(item.id) === String(id)),
    create: (collection, payload, timestamps) => {
      const items = state.get(collection) ?? [];
      const record = stampTimestamps(
        { ...payload, id: payload.id ?? nextNumericId(items) },
        timestamps,
      );
      items.push(record);
      state.set(collection, items);
      save();
      return record;
    },
    update: (collection, id, payload) => {
      const items = state.get(collection) ?? [];
      const index = items.findIndex((item) => String(item.id) === String(id));
      if (index < 0) return undefined;
      items[index] = { ...items[index], ...payload, id: items[index].id };
      state.set(collection, items);
      save();
      return items[index];
    },
    remove: (collection, id) => {
      const items = state.get(collection) ?? [];
      const index = items.findIndex((item) => String(item.id) === String(id));
      if (index < 0) return false;
      items.splice(index, 1);
      state.set(collection, items);
      save();
      return true;
    },
    close: () => {},
  };
};

const createSqliteStore = async (file, seed) => {
  const { DatabaseSync } = await import("node:sqlite");
  const database = new DatabaseSync(file);
  database.exec(
    "CREATE TABLE IF NOT EXISTS xtna_records (" +
      "collection TEXT NOT NULL, id TEXT NOT NULL, ordinal INTEGER NOT NULL, " +
      "body TEXT NOT NULL, PRIMARY KEY (collection, id))",
  );
  const total = database.prepare(
    "SELECT COUNT(*) AS total FROM xtna_records WHERE collection = ?",
  );
  const insert = database.prepare(
    "INSERT OR REPLACE INTO xtna_records (collection, id, ordinal, body) VALUES (?, ?, ?, ?)",
  );
  for (const [collection, items] of Object.entries(seed ?? {})) {
    if (Number(total.get(collection).total) > 0) continue;
    items.forEach((item, index) =>
      insert.run(collection, String(item.id), index + 1, JSON.stringify(item)),
    );
  }
  const selectPage = database.prepare(
    "SELECT body FROM xtna_records WHERE collection = ? ORDER BY ordinal LIMIT ? OFFSET ?",
  );
  const selectOne = database.prepare(
    "SELECT body FROM xtna_records WHERE collection = ? AND id = ?",
  );
  const nextOrdinal = database.prepare(
    "SELECT COALESCE(MAX(ordinal), 0) + 1 AS next FROM xtna_records WHERE collection = ?",
  );
  const deleteOne = database.prepare(
    "DELETE FROM xtna_records WHERE collection = ? AND id = ?",
  );
  const parse = (row) => (row === undefined ? undefined : JSON.parse(row.body));
  const all = (collection) =>
    selectPage
      .all(collection, 1000000, 0)
      .map((row) => JSON.parse(row.body));
  return {
    kind: "sqlite",
    all,
    page: (collection, limit, offset) => ({
      items: selectPage
        .all(collection, limit, offset)
        .map((row) => JSON.parse(row.body)),
      total: Number(total.get(collection).total),
    }),
    get: (collection, id) => parse(selectOne.get(collection, String(id))),
    create: (collection, payload, timestamps) => {
      const items = all(collection);
      const record = stampTimestamps(
        { ...payload, id: payload.id ?? nextNumericId(items) },
        timestamps,
      );
      insert.run(
        collection,
        String(record.id),
        Number(nextOrdinal.get(collection).next),
        JSON.stringify(record),
      );
      return record;
    },
    update: (collection, id, payload) => {
      const existing = parse(selectOne.get(collection, String(id)));
      if (existing === undefined) return undefined;
      const merged = { ...existing, ...payload, id: existing.id };
      database
        .prepare(
          "UPDATE xtna_records SET body = ? WHERE collection = ? AND id = ?",
        )
        .run(JSON.stringify(merged), collection, String(id));
      return merged;
    },
    remove: (collection, id) =>
      Number(deleteOne.run(collection, String(id)).changes) > 0,
    close: () => database.close(),
  };
};

const openStore = async () => {
  if (preferredBackend === "sqlite") {
    try {
      return await createSqliteStore(sqlitePath, model.seed);
    } catch (error) {
      const reason = error && error.message ? error.message : String(error);
      process.stderr.write(
        "xtna mock: node:sqlite unavailable (" + reason + "); using memory state\n",
      );
    }
  }
  return createMemoryStore(model.seed, persist);
};

const store = await openStore();

const RESERVED_QUERY = new Set(["limit", "cursor", "sort", "order"]);

const viewOf = (items, url) => {
  const filters = [];
  let sortField;
  let order = "asc";
  for (const [key, value] of url.searchParams) {
    if (key === "sort") {
      sortField = value;
      continue;
    }
    if (key === "order") {
      order = value === "desc" ? "desc" : "asc";
      continue;
    }
    if (RESERVED_QUERY.has(key)) continue;
    filters.push([key, value]);
  }
  let view = items;
  if (filters.length > 0)
    view = view.filter((item) =>
      filters.every(
        ([field, value]) =>
          item !== null &&
          typeof item === "object" &&
          String(item[field]) === value,
      ),
    );
  if (sortField !== undefined) {
    const indexed = view.map((item, index) => ({ item, index }));
    indexed.sort((left, right) => {
      const a = left.item?.[sortField];
      const b = right.item?.[sortField];
      if (a === b) return left.index - right.index;
      if (a === undefined || a === null) return 1;
      if (b === undefined || b === null) return -1;
      const comparison =
        typeof a === "number" && typeof b === "number"
          ? a - b
          : String(a).localeCompare(String(b));
      return order === "desc" ? -comparison : comparison;
    });
    view = indexed.map((entry) => entry.item);
  }
  return view;
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
    const page = pageFor(route.method, route.template);
    const requested = Number(url.searchParams.get("limit"));
    const limit = Number.isFinite(requested) && requested > 0 ? Math.floor(requested) : undefined;
    const view = viewOf(store.all(collection), url);
    if (page === undefined) {
      return send(response, 200, limit === undefined ? view : view.slice(0, limit));
    }
    let offset = 0;
    const cursor = url.searchParams.get("cursor");
    if (cursor !== null) {
      const decoded = decodeCursor(cursor);
      if (decoded === undefined) return send(response, 400, { error: "invalid cursor" });
      offset = decoded;
    }
    const size = limit ?? page.defaultLimit ?? 20;
    const items = view.slice(offset, offset + size);
    const result = { items, total: view.length };
    const next = offset + result.items.length < result.total ? encodeCursor(offset + result.items.length) : null;
    const envelope = {};
    envelope[page.itemsKey] = result.items;
    if (page.cursorKey !== undefined) envelope[page.cursorKey] = next;
    if (page.hasMoreKey !== undefined) envelope[page.hasMoreKey] = next !== null;
    return send(response, 200, envelope);
  }
  if (route.kind === "read") {
    const item = store.get(collection, id);
    return item === undefined ? send(response, 404, { error: "not found" }) : send(response, 200, item);
  }
  if (route.kind === "create") {
    const payload = (await body(request)) ?? {};
    const created = store.create(collection, payload, timestampsFor(collection));
    return send(response, 201, created);
  }
  if (route.kind === "update") {
    const payload = (await body(request)) ?? {};
    const updated = store.update(collection, id, payload);
    return updated === undefined ? send(response, 404, { error: "not found" }) : send(response, 200, updated);
  }
  if (route.kind === "delete") {
    return store.remove(collection, id)
      ? send(response, 204, undefined)
      : send(response, 404, { error: "not found" });
  }
  return send(response, route.status, route.body);
});
server.listen(Number(process.env.PORT ?? __PORT__), () => {
  const address = server.address();
  process.stdout.write(JSON.stringify({ port: typeof address === "object" && address ? address.port : null, backend: store.kind }) + "\n");
});
`;
