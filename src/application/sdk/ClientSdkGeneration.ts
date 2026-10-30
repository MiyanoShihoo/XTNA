/**
 * Generate a typed, dependency-free client from recorded HTTP traffic.
 *
 * The input is a HAR document (or any object with a `log.entries` array). Each
 * request becomes one client method; requests that share a method and a path
 * template are merged into one operation with the union of their query
 * parameters and response shapes. Nothing is executed and no network access
 * happens here: this is a pure projection from recorded bytes to source text.
 */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/** Auth scheme observed in the capture; the generated client sends it back. */
export interface SdkAuth {
  readonly kind: "bearer" | "basic" | "api-key";
  readonly header: string;
}

export interface SdkRetry {
  readonly attempts: number;
  readonly statuses: readonly number[];
}

export interface SdkOperation {
  readonly name: string;
  readonly method: string;
  readonly pathTemplate: string;
  readonly pathParams: ReadonlyArray<{ name: string; type: string }>;
  readonly queryParams: ReadonlyArray<{
    name: string;
    type: string;
    optional: boolean;
  }>;
  readonly requestBody: string | undefined;
  readonly responseType: string;
  readonly statuses: readonly number[];
  readonly auth: SdkAuth | undefined;
  readonly retry: SdkRetry | undefined;
}

export interface ClientSdk {
  readonly operations: readonly SdkOperation[];
  readonly typescript: string;
  readonly python: string;
  readonly typescriptTest: string;
  readonly pythonTest: string;
}

export interface SdkOptions {
  /** Class name used by both languages. Defaults to "ApiClient". */
  readonly clientName?: string;
  /** Base URL written into the constructor default. */
  readonly baseUrl?: string;
  /** Emitted at the top of each file. */
  readonly header?: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asArray = (value: unknown): unknown[] =>
  Array.isArray(value) ? value : [];

const segmentParam = (segment: string): string | undefined => {
  if (/^\d+$/u.test(segment)) return "id";
  if (
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(
      segment,
    )
  )
    return "id";
  return undefined;
};

const templatePath = (pathname: string): string => {
  const segments = pathname.split("/").filter((segment) => segment.length > 0);
  const rendered = segments.map((segment) => {
    const param = segmentParam(segment);
    return param === undefined ? segment : `{${param}}`;
  });
  return `/${rendered.join("/")}`;
};

const camel = (text: string, first = false): string => {
  const parts = text
    .replace(/[^A-Za-z0-9]+/gu, " ")
    .trim()
    .split(/\s+/u)
    .filter(Boolean);
  const joined = parts
    .map((part, index) =>
      index === 0 && first
        ? part.toLowerCase()
        : part.charAt(0).toUpperCase() + part.slice(1),
    )
    .join("");
  return joined.length > 0 ? joined : "value";
};

const operationName = (method: string, template: string): string => {
  const segments = template.split("/").filter(Boolean);
  const parts = [method.toLowerCase()].concat(
    segments.map((part) =>
      part.startsWith("{") ? `by-${part.slice(1, -1)}` : part,
    ),
  );
  const name = camel(parts.join("-"));
  return name.charAt(0).toLowerCase() + name.slice(1);
};

interface Shape {
  readonly kind: "string" | "number" | "boolean" | "null" | "array" | "object";
  readonly optional?: boolean;
  readonly items?: Shape;
  readonly fields?: ReadonlyMap<string, Shape>;
}

const mergeShapes = (shapes: readonly Shape[]): Shape => {
  const present = shapes.filter((shape) => shape.kind !== "null");
  const nullable = present.length !== shapes.length;
  if (present.length === 0) return { kind: "null" };
  if (present.every((shape) => shape.kind === "string"))
    return { kind: "string", ...(nullable ? { optional: true } : {}) };
  if (present.every((shape) => shape.kind === "number"))
    return { kind: "number", ...(nullable ? { optional: true } : {}) };
  if (present.every((shape) => shape.kind === "boolean"))
    return { kind: "boolean", ...(nullable ? { optional: true } : {}) };
  if (present.every((shape) => shape.kind === "array"))
    return {
      kind: "array",
      items: mergeShapes(
        present.map((shape) => shape.items ?? { kind: "null" }),
      ),
      ...(nullable ? { optional: true } : {}),
    };
  if (present.every((shape) => shape.kind === "object")) {
    const names = new Set<string>();
    for (const shape of present)
      for (const name of shape.fields?.keys() ?? []) names.add(name);
    const fields = new Map<string, Shape>();
    for (const name of [...names].sort()) {
      const collected = present.map(
        (shape) => shape.fields?.get(name) ?? { kind: "null" as const },
      );
      const merged = mergeShapes(collected);
      const optional = collected.some((shape) => shape.kind === "null");
      fields.set(name, optional ? { ...merged, optional: true } : merged);
    }
    return { kind: "object", fields, ...(nullable ? { optional: true } : {}) };
  }
  return { kind: "string", ...(nullable ? { optional: true } : {}) };
};

const shapeOf = (value: unknown): Shape => {
  if (value === null || value === undefined) return { kind: "null" };
  if (typeof value === "string") return { kind: "string" };
  if (typeof value === "number") return { kind: "number" };
  if (typeof value === "boolean") return { kind: "boolean" };
  if (Array.isArray(value))
    return { kind: "array", items: mergeShapes(value.map(shapeOf)) };
  if (isRecord(value)) {
    const fields = new Map<string, Shape>();
    for (const [name, child] of Object.entries(value))
      fields.set(name, shapeOf(child));
    return { kind: "object", fields };
  }
  return { kind: "string" };
};

const tsType = (shape: Shape): string => {
  const base =
    shape.kind === "string"
      ? "string"
      : shape.kind === "number"
        ? "number"
        : shape.kind === "boolean"
          ? "boolean"
          : shape.kind === "null"
            ? "null"
            : shape.kind === "array"
              ? `Array<${tsType(shape.items ?? { kind: "string" })}>`
              : `{ ${[...(shape.fields ?? new Map<string, Shape>())]
                  .map(
                    ([name, field]) =>
                      `${JSON.stringify(name)}${field.optional ? "?" : ""}: ${tsType(field)}`,
                  )
                  .join("; ")} }`;
  return shape.optional === true && shape.kind !== "null"
    ? `${base} | undefined`
    : base;
};

interface Sampled {
  readonly method: string;
  readonly pathTemplate: string;
  readonly query: Map<string, Shape>;
  readonly responses: Shape[];
  readonly bodies: Shape[];
  readonly statuses: Set<number>;
  readonly paramNames: string[];
  auth: SdkAuth | undefined;
}

const parseJson = (text: unknown): unknown => {
  if (typeof text !== "string" || text.trim() === "") return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

const entriesOf = (document: unknown): unknown[] => {
  if (!isRecord(document)) return [];
  const log = document.log;
  if (isRecord(log)) return asArray(log.entries);
  return asArray(document.entries);
};

const AUTH_HEADERS = [
  "authorization",
  "x-api-key",
  "api-key",
  "x-auth-token",
  "x-access-token",
] as const;

const authOf = (headers: ReadonlyMap<string, string>): SdkAuth | undefined => {
  const authorization = headers.get("authorization");
  if (authorization !== undefined) {
    const lowered = authorization.toLowerCase();
    if (lowered.startsWith("bearer "))
      return { kind: "bearer", header: "authorization" };
    if (lowered.startsWith("basic "))
      return { kind: "basic", header: "authorization" };
  }
  for (const name of AUTH_HEADERS) {
    if (name === "authorization") continue;
    if (headers.has(name)) return { kind: "api-key", header: name };
  }
  return undefined;
};

const requestHeaders = (
  request: Record<string, unknown>,
): Map<string, string> => {
  const headers = new Map<string, string>();
  for (const raw of asArray(request.headers)) {
    if (!isRecord(raw) || typeof raw.name !== "string") continue;
    headers.set(raw.name.toLowerCase(), String(raw.value ?? ""));
  }
  return headers;
};

const IDEMPOTENT = new Set(["GET", "HEAD", "PUT", "DELETE", "OPTIONS"]);
const RETRYABLE_STATUSES = [429, 500, 502, 503, 504];

const retryOf = (
  method: string,
  statuses: ReadonlySet<number>,
): SdkRetry | undefined => {
  const transient = [...statuses].some(
    (status) => status === 429 || status >= 500,
  );
  if (!IDEMPOTENT.has(method) && !transient) return undefined;
  return {
    attempts: IDEMPOTENT.has(method) || transient ? 3 : 1,
    statuses: RETRYABLE_STATUSES,
  };
};

const collect = (document: unknown): Map<string, Sampled> => {
  const operations = new Map<string, Sampled>();
  for (const entry of entriesOf(document)) {
    if (!isRecord(entry) || !isRecord(entry.request)) continue;
    const request = entry.request;
    const response = isRecord(entry.response) ? entry.response : undefined;
    const method =
      typeof request.method === "string" ? request.method.toUpperCase() : "GET";
    const rawUrl = typeof request.url === "string" ? request.url : "";
    let pathname = "/";
    let search = new URLSearchParams();
    try {
      const url = new URL(rawUrl);
      pathname = url.pathname;
      search = url.searchParams;
    } catch {
      const [path = "", query = ""] = rawUrl.split("?");
      pathname = path.length > 0 ? path : "/";
      search = new URLSearchParams(query);
    }
    const template = templatePath(pathname);
    const key = `${method} ${template}`;
    const existing = operations.get(key) ?? {
      method,
      pathTemplate: template,
      query: new Map<string, Shape>(),
      responses: [],
      bodies: [],
      statuses: new Set<number>(),
      paramNames: [],
      auth: undefined,
    };
    if (existing.auth === undefined)
      existing.auth = authOf(requestHeaders(request));
    for (const [name, value] of search)
      existing.query.set(
        name,
        mergeShapes([
          existing.query.get(name) ?? { kind: "null" },
          shapeOf(value),
        ]),
      );
    const bodyText = isRecord(request.postData)
      ? request.postData.text
      : undefined;
    const bodyJson = parseJson(bodyText);
    if (bodyJson !== undefined) existing.bodies.push(shapeOf(bodyJson));
    if (response !== undefined) {
      if (typeof response.status === "number")
        existing.statuses.add(response.status);
      const responseText = isRecord(response.content)
        ? response.content.text
        : undefined;
      const responseJson = parseJson(responseText);
      if (responseJson !== undefined)
        existing.responses.push(shapeOf(responseJson));
    }
    for (const segment of template.split("/"))
      if (segment.startsWith("{") && segment.endsWith("}")) {
        const name = segment.slice(1, -1);
        if (!existing.paramNames.includes(name)) existing.paramNames.push(name);
      }
    operations.set(key, existing);
  }
  return operations;
};

const renderTypeScript = (
  operations: readonly SdkOperation[],
  className: string,
  baseUrl: string,
  header: string | undefined,
): string => {
  const lines: string[] = [];
  if (header !== undefined) lines.push(`// ${header}`, "");
  const attempts = Math.max(
    1,
    ...operations.map((operation) => operation.retry?.attempts ?? 1),
  );
  lines.push(
    "export interface AuthOptions {",
    '  kind: "bearer" | "basic" | "api-key";',
    "  token?: string;",
    "  username?: string;",
    "  password?: string;",
    "  key?: string;",
    "  header?: string;",
    "}",
    "",
    "export interface ClientOptions {",
    "  baseUrl?: string;",
    "  headers?: Record<string, string>;",
    "  auth?: AuthOptions;",
    "}",
    "",
  );
  for (const operation of operations)
    lines.push(
      `export type ${operation.name.charAt(0).toUpperCase() + operation.name.slice(1)}Response = ${operation.responseType};`,
      "",
    );
  lines.push(
    `export class ${className} {`,
    "  private readonly baseUrl: string;",
    "  private readonly headers: Record<string, string>;",
    "  private readonly auth: AuthOptions | undefined;",
    `  private readonly retryAttempts = ${String(attempts)};`,
    "",
    "  constructor(options: ClientOptions = {}) {",
    `    this.baseUrl = options.baseUrl ?? ${JSON.stringify(baseUrl)};`,
    "    this.headers = options.headers ?? {};",
    "    this.auth = options.auth;",
    "  }",
    "",
    "  private authHeaders(): Record<string, string> {",
    "    const auth = this.auth;",
    "    if (auth === undefined) return {};",
    '    if (auth.kind === "bearer")',
    "      return auth.token === undefined ? {} : { authorization: `Bearer ${auth.token}` };",
    '    if (auth.kind === "basic")',
    "      return auth.username === undefined || auth.password === undefined",
    "        ? {}",
    "        : { authorization: `Basic ${btoa(`${auth.username}:${auth.password}`)}` };",
    '    const header = auth.header ?? "x-api-key";',
    "    return auth.key === undefined ? {} : { [header]: auth.key };",
    "  }",
    "",
    "  private async call<T>(",
    "    method: string,",
    "    path: string,",
    "    query: Record<string, unknown>,",
    "    body: unknown,",
    "  ): Promise<T> {",
    "    const url = new URL(this.baseUrl + path);",
    "    for (const [key, value] of Object.entries(query)) {",
    "      if (value === undefined || value === null) continue;",
    "      url.searchParams.set(key, String(value));",
    "    }",
    "    const attempts = this.retryAttempts;",
    "    let lastError: unknown;",
    "    for (let attempt = 0; attempt < attempts; attempt += 1) {",
    "      try {",
    "        const response = await fetch(url, {",
    "          method,",
    "          headers: {",
    '            "content-type": "application/json",',
    "            ...this.headers,",
    "            ...this.authHeaders(),",
    "          },",
    "          ...(body === undefined ? {} : { body: JSON.stringify(body) }),",
    "        });",
    "        if (!response.ok) {",
    "          const retryable = response.status === 429 || response.status >= 500;",
    "          if (retryable && attempt + 1 < attempts) {",
    '            const retryAfter = Number(response.headers.get("retry-after"));',
    "            const delay = Number.isFinite(retryAfter) && retryAfter > 0",
    "              ? retryAfter * 1000",
    "              : 100 * 2 ** attempt;",
    "            await new Promise((resolve) => setTimeout(resolve, delay));",
    "            continue;",
    "          }",
    "          throw new Error(`${method} ${path} failed: ${response.status}`);",
    "        }",
    "        const text = await response.text();",
    '        return (text === "" ? undefined : JSON.parse(text)) as T;',
    "      } catch (error) {",
    "        lastError = error;",
    "        if (attempt + 1 >= attempts) throw error;",
    "        await new Promise((resolve) => setTimeout(resolve, 100 * 2 ** attempt));",
    "      }",
    "    }",
    '    throw lastError instanceof Error ? lastError : new Error("request failed");',
    "  }",
    "",
  );
  for (const operation of operations) {
    const responseName = `${operation.name.charAt(0).toUpperCase() + operation.name.slice(1)}Response`;
    const params = [
      ...operation.pathParams.map((param) => `${param.name}: ${param.type}`),
      ...(operation.queryParams.length === 0
        ? []
        : [
            `query: { ${operation.queryParams
              .map(
                (param) =>
                  `${JSON.stringify(param.name)}${param.optional ? "?" : ""}: ${param.type}`,
              )
              .join("; ")} } = {}`,
          ]),
      ...(operation.requestBody === undefined
        ? []
        : [`body: ${operation.requestBody}`]),
    ];
    const path = `\`${operation.pathTemplate.replace(/\{(\w+)\}/gu, "${$1}")}\``;
    lines.push(
      `  async ${operation.name}(${params.join(", ")}): Promise<${responseName}> {`,
      `    return this.call<${responseName}>(${JSON.stringify(operation.method)}, ${path}, ${operation.queryParams.length === 0 ? "{}" : "query"}, ${operation.requestBody === undefined ? "undefined" : "body"});`,
      "  }",
      "",
    );
  }
  lines.push("}", "");
  return lines.join("\n");
};

const renderPython = (
  operations: readonly SdkOperation[],
  className: string,
  baseUrl: string,
  header: string | undefined,
): string => {
  const lines: string[] = [];
  if (header !== undefined) lines.push(`# ${header}`, "");
  const attempts = Math.max(
    1,
    ...operations.map((operation) => operation.retry?.attempts ?? 1),
  );
  lines.push(
    "from __future__ import annotations",
    "",
    "import base64",
    "import json",
    "import time",
    "import urllib.error",
    "import urllib.parse",
    "import urllib.request",
    "from typing import Any, Dict, Optional",
    "",
    "",
    `class ${className}:`,
    `    def __init__(self, base_url: str = ${JSON.stringify(baseUrl)}, headers: Optional[Dict[str, str]] = None, auth: Optional[Dict[str, str]] = None):`,
    "        self.base_url = base_url.rstrip('/')",
    "        self.headers = headers or {}",
    "        self.auth = auth or {}",
    `        self.retry_attempts = ${String(attempts)}`,
    "",
    "    def _auth_headers(self) -> Dict[str, str]:",
    "        auth = self.auth",
    "        if not auth:",
    "            return {}",
    "        kind = auth.get('kind')",
    "        if kind == 'bearer' and auth.get('token'):",
    "            return {'authorization': 'Bearer ' + str(auth['token'])}",
    "        if kind == 'basic' and auth.get('username') is not None:",
    "            raw = str(auth.get('username')) + ':' + str(auth.get('password', ''))",
    "            return {'authorization': 'Basic ' + base64.b64encode(raw.encode()).decode()}",
    "        if kind == 'api-key' and auth.get('key') is not None:",
    "            return {auth.get('header', 'x-api-key'): str(auth['key'])}",
    "        return {}",
    "",
    "    def _call(self, method: str, path: str, query: Dict[str, Any], body: Any) -> Any:",
    "        url = self.base_url + path",
    "        encoded = {key: str(value) for key, value in query.items() if value is not None}",
    "        if encoded:",
    "            url += '?' + urllib.parse.urlencode(encoded)",
    "        data = None if body is None else json.dumps(body).encode('utf-8')",
    "        headers = {'content-type': 'application/json', **self.headers, **self._auth_headers()}",
    "        last_error: Any = None",
    "        for attempt in range(max(1, self.retry_attempts)):",
    "            request = urllib.request.Request(url, data=data, headers=headers, method=method)",
    "            try:",
    "                with urllib.request.urlopen(request) as response:",
    "                    text = response.read().decode('utf-8')",
    "                return json.loads(text) if text else None",
    "            except urllib.error.HTTPError as error:",
    "                last_error = error",
    "                retryable = error.code == 429 or error.code >= 500",
    "                if retryable and attempt + 1 < max(1, self.retry_attempts):",
    "                    retry_after = error.headers.get('Retry-After') if error.headers else None",
    "                    delay = float(retry_after) if retry_after and retry_after.isdigit() else 0.1 * (2 ** attempt)",
    "                    time.sleep(delay)",
    "                    continue",
    "                raise RuntimeError(f'{method} {path} failed: {error.code}') from error",
    "        raise RuntimeError(f'{method} {path} failed') from last_error",
    "",
  );
  for (const operation of operations) {
    const signature = [
      "self",
      ...operation.pathParams.map(
        (param) => `${param.name}: ${pyTypeFromName(param.type)}`,
      ),
      ...(operation.queryParams.length === 0
        ? []
        : [`query: Optional[Dict[str, Any]] = None`]),
      ...(operation.requestBody === undefined
        ? []
        : ["body: Optional[Dict[str, Any]] = None"]),
    ];
    const path =
      operation.pathParams.length === 0
        ? JSON.stringify(operation.pathTemplate)
        : `f"${operation.pathTemplate.replace(/\{(\w+)\}/gu, "{$1}")}"`;
    lines.push(
      `    def ${snake(operation.name)}(${signature.join(", ")}) -> Any:`,
      `        return self._call(${JSON.stringify(operation.method)}, ${path}, ${operation.queryParams.length === 0 ? "{}" : "query or {}"}, ${operation.requestBody === undefined ? "None" : "body"})`,
      "",
    );
  }
  return lines.join("\n");
};

const examplePath = (operation: SdkOperation): string =>
  operation.pathTemplate.replace(/\{\w+\}/gu, "example");

const tsCallArguments = (operation: SdkOperation): string[] => [
  ...operation.pathParams.map(() => JSON.stringify("example")),
  ...(operation.queryParams.length === 0 ? [] : ["{}"]),
  ...(operation.requestBody === undefined ? [] : ["{} as never"]),
];

const renderTypeScriptTest = (
  operations: readonly SdkOperation[],
  className: string,
  header: string | undefined,
): string => {
  const lines: string[] = [];
  if (header !== undefined) lines.push(`// ${header}`, "");
  lines.push(
    'import { describe, expect, it, vi } from "vitest";',
    "",
    `import { ${className} } from "./client.js";`,
    "",
    'describe("generated client smoke", () => {',
  );
  for (const operation of operations) {
    const args = tsCallArguments(operation);
    lines.push(
      `  it(${JSON.stringify(operation.name)}, async () => {`,
      `    const client = new ${className}();`,
      '    const call = vi.spyOn(client as unknown as { call: (...args: unknown[]) => Promise<unknown> }, "call").mockResolvedValue({});',
      `    await client.${operation.name}(${args.join(", ")});`,
      `    expect(call).toHaveBeenCalledWith(${JSON.stringify(operation.method)}, ${JSON.stringify(examplePath(operation))}, {}, ${operation.requestBody === undefined ? "undefined" : "{}"});`,
      "  });",
    );
  }
  lines.push("});", "");
  return lines.join("\n");
};

const pythonCallArguments = (operation: SdkOperation): string[] => [
  ...operation.pathParams.map(() => JSON.stringify("example")),
  ...(operation.queryParams.length === 0 ? [] : ["query={}"]),
  ...(operation.requestBody === undefined ? [] : ["body={}"]),
];

const renderPythonTest = (
  operations: readonly SdkOperation[],
  className: string,
  header: string | undefined,
): string => {
  const lines: string[] = [];
  if (header !== undefined) lines.push(`# ${header}`, "");
  lines.push(
    "import unittest",
    "from unittest.mock import patch",
    "",
    `from client import ${className}`,
    "",
    "",
    "class GeneratedClientSmoke(unittest.TestCase):",
    "    def test_operations(self):",
    `        client = ${className}()`,
  );
  if (operations.length === 0) lines.push("        self.assertTrue(True)");
  for (const operation of operations) {
    const args = pythonCallArguments(operation);
    lines.push(
      '        with patch.object(client, "_call", return_value={}) as call:',
      `            client.${snake(operation.name)}(${args.join(", ")})`,
      `            call.assert_called_once_with(${JSON.stringify(operation.method)}, ${JSON.stringify(examplePath(operation))}, {}, ${operation.requestBody === undefined ? "None" : "{}"})`,
    );
  }
  lines.push("", "", 'if __name__ == "__main__":', "    unittest.main()", "");
  return lines.join("\n");
};

const pyTypeFromName = (type: string): string =>
  type === "string" ? "str" : type === "number" ? "float" : "Any";

const snake = (name: string): string =>
  name.replace(/[A-Z]/gu, (letter) => `_${letter.toLowerCase()}`);

/** Project a recorded HTTP capture into typed client source. */
export function generateClientSdk(
  document: unknown,
  options: SdkOptions = {},
): ClientSdk {
  const className = options.clientName ?? "ApiClient";
  const baseUrl = options.baseUrl ?? "http://localhost:8080";
  const sampled = [...collect(document).values()].sort((left, right) =>
    `${left.method} ${left.pathTemplate}`.localeCompare(
      `${right.method} ${right.pathTemplate}`,
    ),
  );
  const operations: SdkOperation[] = sampled.map((item) => {
    const name = operationName(item.method, item.pathTemplate);
    const responseShape =
      item.responses.length === 0
        ? ({ kind: "null" } as Shape)
        : mergeShapes(item.responses);
    const bodyShape =
      item.bodies.length === 0 ? undefined : mergeShapes(item.bodies);
    return {
      name,
      method: item.method,
      pathTemplate: item.pathTemplate,
      pathParams: item.paramNames.map((param) => ({
        name: param,
        type: "string | number",
      })),
      queryParams: [...item.query.keys()].sort().map((key) => {
        const shape = item.query.get(key) ?? { kind: "string" };
        return {
          name: key,
          type: tsType(shape),
          optional: shape.optional === true,
        };
      }),
      requestBody: bodyShape === undefined ? undefined : tsType(bodyShape),
      responseType: tsType(responseShape),
      statuses: [...item.statuses].sort((a, b) => a - b),
      auth: item.auth,
      retry: retryOf(item.method, item.statuses),
    };
  });
  return {
    operations,
    typescript: renderTypeScript(
      operations,
      className,
      baseUrl,
      options.header,
    ),
    python: renderPython(operations, className, baseUrl, options.header),
    typescriptTest: renderTypeScriptTest(operations, className, options.header),
    pythonTest: renderPythonTest(operations, className, options.header),
  };
}
