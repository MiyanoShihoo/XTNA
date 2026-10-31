/**
 * Turn a recorded HTTP capture into an OpenAPI 3.1 document.
 *
 * Grouping follows the same rule as the client generator: requests that share a
 * method and a path template are one operation. Schemas are inferred from the
 * recorded JSON bodies and merged across samples; they describe what was seen,
 * not what the server promises.
 */
import { synthesizeJsonSchema } from "../../domain/schemaSynthesis.js";

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface OpenApiOptions {
  readonly title?: string;
  readonly version?: string;
  readonly serverUrl?: string;
  /** Attach the typed synthesis result (evidence and ambiguities) per operation. */
  readonly withSynthesis?: boolean;
}

export interface OpenApiDocument {
  readonly openapi: "3.1.0";
  readonly info: { title: string; version: string };
  readonly servers: ReadonlyArray<{ url: string }>;
  readonly paths: Record<string, Record<string, unknown>>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const entriesOf = (document: unknown): unknown[] => {
  if (!isRecord(document)) return [];
  const log = document.log;
  if (isRecord(log)) return Array.isArray(log.entries) ? log.entries : [];
  return Array.isArray(document.entries) ? document.entries : [];
};

const isIdSegment = (segment: string): boolean =>
  /^\d+$/u.test(segment) ||
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(
    segment,
  );

const templateOf = (pathname: string): string => {
  const segments = pathname.split("/").filter(Boolean);
  return `/${segments.map((segment) => (isIdSegment(segment) ? "{id}" : segment)).join("/")}`;
};

/** JSON Schema for one sampled value. */
export function schemaOf(value: unknown): Record<string, unknown> {
  if (value === null) return { type: "null" };
  if (typeof value === "string") return { type: "string" };
  if (typeof value === "number")
    return { type: Number.isInteger(value) ? "integer" : "number" };
  if (typeof value === "boolean") return { type: "boolean" };
  if (Array.isArray(value))
    return {
      type: "array",
      items: value.length === 0 ? {} : mergeSchemas(value.map(schemaOf)),
    };
  if (isRecord(value)) {
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const [name, child] of Object.entries(value)) {
      properties[name] = schemaOf(child);
      required.push(name);
    }
    return {
      type: "object",
      properties,
      ...(required.length === 0 ? {} : { required }),
    };
  }
  return {};
}

/** Merge schemas for several samples of the same position. */
export function mergeSchemas(
  schemas: readonly Record<string, unknown>[],
): Record<string, unknown> {
  if (schemas.length === 0) return {};
  if (schemas.length === 1) return schemas[0] as Record<string, unknown>;
  const types = [...new Set(schemas.map((schema) => schema.type))];
  if (types.length === 1 && types[0] === "object") {
    const names = new Set<string>();
    for (const schema of schemas)
      for (const name of Object.keys(
        (schema.properties as Record<string, unknown> | undefined) ?? {},
      ))
        names.add(name);
    const properties: Record<string, unknown> = {};
    for (const name of [...names].sort()) {
      const variants = schemas.map(
        (schema) =>
          ((schema.properties as Record<string, unknown> | undefined) ?? {})[
            name
          ] ?? {},
      );
      properties[name] = mergeSchemas(variants as Record<string, unknown>[]);
    }
    const required = schemas
      .map((schema) => new Set((schema.required as string[] | undefined) ?? []))
      .reduce(
        (left, right) => new Set([...left].filter((name) => right.has(name))),
      );
    return {
      type: "object",
      properties,
      ...(required.size === 0 ? {} : { required: [...required] }),
    };
  }
  if (types.length === 1 && types[0] === "array") {
    const items = schemas.map(
      (schema) => (schema.items as Record<string, unknown>) ?? {},
    );
    return { type: "array", items: mergeSchemas(items) };
  }
  if (types.length === 1) return schemas[0] as Record<string, unknown>;
  return { anyOf: schemas };
}

const parseJson = (value: unknown): unknown => {
  if (typeof value !== "string" || value.trim() === "") return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
};

interface Operation {
  method: string;
  template: string;
  query: Set<string>;
  pathParams: Set<string>;
  responseSamples: unknown[];
  requestSamples: unknown[];
  statuses: Set<number>;
}

/** Build an OpenAPI 3.1 document from a HAR capture. */
export function buildOpenApi(
  document: unknown,
  options: OpenApiOptions = {},
): OpenApiDocument {
  const operations = new Map<string, Operation>();
  let origin = "http://localhost";
  for (const entry of entriesOf(document)) {
    if (!isRecord(entry) || !isRecord(entry.request)) continue;
    const request = entry.request;
    const response = isRecord(entry.response) ? entry.response : undefined;
    const method =
      typeof request.method === "string" ? request.method.toUpperCase() : "GET";
    const rawUrl = typeof request.url === "string" ? request.url : "";
    let pathname = "/";
    let search: URLSearchParams | undefined;
    try {
      const url = new URL(rawUrl);
      origin = url.origin;
      pathname = url.pathname;
      search = url.searchParams;
    } catch {
      pathname = rawUrl.split("?")[0] || "/";
    }
    const template = templateOf(pathname);
    const key = `${method} ${template}`;
    const operation =
      operations.get(key) ??
      ({
        method,
        template,
        query: new Set<string>(),
        pathParams: new Set<string>(),
        responseSamples: [],
        requestSamples: [],
        statuses: new Set<number>(),
      } satisfies Operation);
    for (const name of search?.keys() ?? []) operation.query.add(name);
    for (const segment of template.split("/"))
      if (segment.startsWith("{") && segment.endsWith("}"))
        operation.pathParams.add(segment.slice(1, -1));
    const requestJson = parseJson(
      isRecord(request.postData) ? request.postData.text : undefined,
    );
    if (requestJson !== undefined) operation.requestSamples.push(requestJson);
    const responseJson = parseJson(
      isRecord(response?.content) ? response.content.text : undefined,
    );
    if (responseJson !== undefined)
      operation.responseSamples.push(responseJson);
    if (typeof response?.status === "number")
      operation.statuses.add(response.status);
    operations.set(key, operation);
  }

  const paths: Record<string, Record<string, unknown>> = {};
  for (const operation of [...operations.values()].sort((left, right) =>
    `${left.method} ${left.template}`.localeCompare(
      `${right.method} ${right.template}`,
    ),
  )) {
    const status =
      operation.statuses.size === 0 ? 200 : Math.min(...operation.statuses);
    const responseSynthesis =
      operation.responseSamples.length === 0
        ? undefined
        : synthesizeJsonSchema(operation.responseSamples as JsonValue[]);
    const requestSynthesis =
      operation.requestSamples.length === 0
        ? undefined
        : synthesizeJsonSchema(operation.requestSamples as JsonValue[]);
    const responseSchema = responseSynthesis?.schema ?? {};
    const pathEntry = (paths[operation.template] ??= {});
    pathEntry[operation.method.toLowerCase()] = {
      operationId: `${operation.method.toLowerCase()}_${operation.template
        .replace(/[^A-Za-z0-9]+/gu, "_")
        .replace(/^_+|_+$/gu, "")}`,
      parameters: [
        ...[...operation.pathParams].map((name) => ({
          name,
          in: "path",
          required: true,
          schema: { type: "string" },
        })),
        ...[...operation.query].sort().map((name) => ({
          name,
          in: "query",
          required: false,
          schema: { type: "string" },
        })),
      ],
      ...(requestSynthesis === undefined
        ? {}
        : {
            requestBody: {
              content: {
                "application/json": { schema: requestSynthesis.schema },
              },
            },
          }),
      ...(options.withSynthesis !== true
        ? {}
        : {
            "x-xtna-synthesis": {
              ...(requestSynthesis === undefined
                ? {}
                : { request: requestSynthesis }),
              ...(responseSynthesis === undefined
                ? {}
                : { response: responseSynthesis }),
            },
          }),
      responses: {
        [String(status)]: {
          description: "Recorded response",
          ...(Object.keys(responseSchema).length === 0
            ? {}
            : { content: { "application/json": { schema: responseSchema } } }),
        },
      },
    };
  }

  return {
    openapi: "3.1.0",
    info: {
      title: options.title ?? "Recorded API",
      version: options.version ?? "0.0.0",
    },
    servers: [{ url: options.serverUrl ?? origin }],
    paths,
  };
}
