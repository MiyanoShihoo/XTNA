import { describe, expect, it } from "vitest";
import ts from "typescript6";

import { generateClientSdk } from "./ClientSdkGeneration.js";

const har = {
  log: {
    entries: [
      {
        request: {
          method: "GET",
          url: "https://api.example.test/users/42",
        },
        response: {
          status: 200,
          content: {
            text: JSON.stringify({ id: 42, name: "Ada", active: true }),
          },
        },
      },
      {
        request: {
          method: "GET",
          url: "https://api.example.test/users?limit=10",
        },
        response: {
          status: 200,
          content: {
            text: JSON.stringify([{ id: 42, name: "Ada", active: true }]),
          },
        },
      },
      {
        request: {
          method: "POST",
          url: "https://api.example.test/users",
          postData: {
            text: JSON.stringify({ name: "Ada", active: true }),
          },
        },
        response: {
          status: 201,
          content: { text: JSON.stringify({ id: 7, name: "Ada" }) },
        },
      },
    ],
  },
};

describe("operation extraction", () => {
  it("merges requests that share a method and path template", () => {
    const sdk = generateClientSdk(har);
    expect(sdk.operations).toHaveLength(3);
    const list = sdk.operations.find(
      (operation) => operation.name === "getUsers",
    );
    expect(list?.method).toBe("GET");
    expect(list?.pathTemplate).toBe("/users");
    expect(
      sdk.operations.some(
        (operation) => operation.pathTemplate === "/users/{id}",
      ),
    ).toBe(true);
  });

  it("records path parameters, query parameters and bodies", () => {
    const sdk = generateClientSdk(har);
    const byId = sdk.operations.find(
      (operation) => operation.pathTemplate === "/users/{id}",
    );
    expect(byId?.pathParams.map((param) => param.name)).toEqual(["id"]);
    const list = sdk.operations.find(
      (operation) => operation.name === "getUsers",
    );
    expect(list?.queryParams.map((param) => param.name)).toEqual(["limit"]);
    const create = sdk.operations.find(
      (operation) => operation.method === "POST",
    );
    expect(create?.requestBody).toContain("name");
    expect(create?.statuses).toEqual([201]);
  });
});

describe("TypeScript output", () => {
  it("emits a class with one method per operation and no syntax errors", () => {
    const sdk = generateClientSdk(har, { clientName: "UsersClient" });
    expect(sdk.typescript).toContain("export class UsersClient");
    expect(sdk.typescript).toContain("async getUsers(");
    expect(sdk.typescript).toContain("async getUsersById(");
    expect(sdk.typescript).toContain("async postUsers(");
    const source = ts.createSourceFile(
      "client.ts",
      sdk.typescript,
      ts.ScriptTarget.Latest,
      true,
    );
    expect(
      (source as unknown as { parseDiagnostics?: readonly unknown[] })
        .parseDiagnostics ?? [],
    ).toEqual([]);
  });

  it("emits a smoke test for every operation", () => {
    const sdk = generateClientSdk(har, { clientName: "UsersClient" });
    expect(sdk.typescriptTest).toContain('describe("generated client smoke"');
    expect(sdk.typescriptTest).toContain("async () => {");
    expect(sdk.typescriptTest).toContain("vi.spyOn");
    expect(sdk.typescriptTest).toContain("getUsersById");
    const source = ts.createSourceFile(
      "client.test.ts",
      sdk.typescriptTest,
      ts.ScriptTarget.Latest,
      true,
    );
    expect(
      (source as unknown as { parseDiagnostics?: readonly unknown[] })
        .parseDiagnostics ?? [],
    ).toEqual([]);
  });

  it("is deterministic", () => {
    expect(generateClientSdk(har).typescript).toBe(
      generateClientSdk(har).typescript,
    );
  });
});

describe("Python output", () => {
  it("emits a dependency-free client", () => {
    const sdk = generateClientSdk(har, { clientName: "UsersClient" });
    expect(sdk.python).toContain("class UsersClient:");
    expect(sdk.python).toContain("import urllib.request");
    expect(sdk.python).toContain("import urllib.error");
    expect(sdk.python).toContain("def get_users(");
    expect(sdk.python).toContain("def get_users_by_id(");
    expect(sdk.python).not.toContain("requests");
  });

  it("emits a unittest smoke test with mocked transport", () => {
    const sdk = generateClientSdk(har, { clientName: "UsersClient" });
    expect(sdk.pythonTest).toContain("class GeneratedClientSmoke");
    expect(sdk.pythonTest).toContain('patch.object(client, "_call"');
    expect(sdk.pythonTest).toContain(
      'call.assert_called_once_with("GET", "/users/example"',
    );
    expect(sdk.pythonTest).toContain("from client import UsersClient");
  });
});

describe("empty input", () => {
  it("returns empty clients rather than throwing", () => {
    const sdk = generateClientSdk({ log: { entries: [] } });
    expect(sdk.operations).toEqual([]);
    expect(sdk.typescript).toContain("export class ApiClient");
  });
});

describe("auth and retry inference", () => {
  const authorized = {
    log: {
      entries: [
        {
          request: {
            method: "GET",
            url: "https://api.test/orders",
            headers: [{ name: "Authorization", value: "Bearer abc123" }],
          },
          response: {
            status: 503,
            headers: [{ name: "Retry-After", value: "2" }],
            content: { text: JSON.stringify({ error: "busy" }) },
          },
        },
        {
          request: {
            method: "POST",
            url: "https://api.test/orders",
            headers: [{ name: "X-API-Key", value: "key-9" }],
            postData: { text: JSON.stringify({ sku: "a" }) },
          },
          response: {
            status: 201,
            content: { text: JSON.stringify({ id: 1 }) },
          },
        },
      ],
    },
  };

  it("recognizes bearer and api-key headers", () => {
    const sdk = generateClientSdk(authorized);
    const get = sdk.operations.find((operation) => operation.method === "GET");
    expect(get?.auth).toEqual({ kind: "bearer", header: "authorization" });
    const post = sdk.operations.find(
      (operation) => operation.method === "POST",
    );
    expect(post?.auth).toEqual({ kind: "api-key", header: "x-api-key" });

    expect(sdk.typescript).toContain("AuthOptions");
    expect(sdk.typescript).toContain("this.authHeaders()");
    expect(sdk.typescript).toContain('"bearer"');
    expect(sdk.python).toContain("def _auth_headers");
    expect(sdk.python).toContain("base64.b64encode");
  });

  it("retries idempotent calls and transient failures only", () => {
    const sdk = generateClientSdk(authorized);
    const get = sdk.operations.find((operation) => operation.method === "GET");
    expect(get?.retry).toEqual({
      attempts: 3,
      statuses: [429, 500, 502, 503, 504],
    });
    const post = sdk.operations.find(
      (operation) => operation.method === "POST",
    );
    expect(post?.retry).toBeUndefined();

    const alwaysFailing = generateClientSdk({
      log: {
        entries: [
          {
            request: { method: "POST", url: "https://api.test/orders" },
            response: { status: 500, content: { text: "{}" } },
          },
        ],
      },
    });
    expect(alwaysFailing.operations[0]?.retry?.attempts).toBe(3);
    expect(sdk.typescript).toContain("retry-after");
    expect(sdk.typescript).toContain("this.retryAttempts");
    expect(sdk.python).toContain("self.retry_attempts");
  });

  it("keeps the generated TypeScript parseable", () => {
    const sdk = generateClientSdk(authorized);
    const source = ts.createSourceFile(
      "client.ts",
      sdk.typescript,
      ts.ScriptTarget.Latest,
      true,
    );
    expect(
      (source as unknown as { parseDiagnostics?: readonly unknown[] })
        .parseDiagnostics ?? [],
    ).toEqual([]);
  });
});

describe("pagination inference", () => {
  const cursorHar = {
    log: {
      entries: [
        {
          request: {
            method: "GET",
            url: "https://api.test/events?limit=2",
          },
          response: {
            status: 200,
            content: {
              text: JSON.stringify({
                items: [{ id: 1 }, { id: 2 }],
                next_cursor: "abc",
              }),
            },
          },
        },
        {
          request: {
            method: "GET",
            url: "https://api.test/users?page=1&per_page=2",
          },
          response: {
            status: 200,
            content: { text: JSON.stringify([{ id: 1 }, { id: 2 }]) },
          },
        },
      ],
    },
  };

  it("detects cursor envelopes and page parameters", () => {
    const sdk = generateClientSdk(cursorHar);
    const events = sdk.operations.find(
      (operation) => operation.pathTemplate === "/events",
    );
    expect(events?.pagination).toEqual({
      kind: "cursor",
      param: "cursor",
      limitParam: "limit",
      itemsKey: "items",
      cursorKey: "next_cursor",
    });
    const users = sdk.operations.find(
      (operation) => operation.pathTemplate === "/users",
    );
    expect(users?.pagination).toMatchObject({
      kind: "page",
      param: "page",
      limitParam: "per_page",
    });
  });

  it("emits pages helpers in both languages", () => {
    const sdk = generateClientSdk(cursorHar);
    expect(sdk.typescript).toContain("async getEventsPages(");
    expect(sdk.typescript).toContain("async getUsersPages(");
    expect(sdk.python).toContain("def get_events_pages(");
    expect(sdk.python).toContain("def get_users_pages(");
    const source = ts.createSourceFile(
      "client.ts",
      sdk.typescript,
      ts.ScriptTarget.Latest,
      true,
    );
    expect(
      (source as unknown as { parseDiagnostics?: readonly unknown[] })
        .parseDiagnostics ?? [],
    ).toEqual([]);
  });

  it("does not paginate a plain list without paging parameters", () => {
    const sdk = generateClientSdk(har);
    expect(
      sdk.operations.find((operation) => operation.pathTemplate === "/users")
        ?.pagination,
    ).toBeUndefined();
  });
});

describe("oauth inference", () => {
  const tokenHar = {
    log: {
      entries: [
        {
          request: {
            method: "POST",
            url: "https://api.test/oauth/token",
            postData: {
              mimeType: "application/x-www-form-urlencoded",
              text: "grant_type=client_credentials&client_id=demo",
            },
          },
          response: {
            status: 200,
            content: { text: JSON.stringify({ access_token: "tok" }) },
          },
        },
        {
          request: {
            method: "GET",
            url: "https://api.test/me",
            headers: [{ name: "Authorization", value: "Bearer tok" }],
          },
          response: {
            status: 200,
            content: { text: JSON.stringify({ id: 1 }) },
          },
        },
      ],
    },
  };

  it("detects a captured token request", () => {
    const sdk = generateClientSdk(tokenHar);
    expect(sdk.oauth).toEqual({
      path: "/oauth/token",
      grantType: "client_credentials",
      fields: ["grant_type", "client_id"],
    });
    expect(sdk.oauth).toBe(
      generateClientSdk(har).oauth === undefined ? sdk.oauth : sdk.oauth,
    );
    expect(generateClientSdk(har).oauth).toBeUndefined();
  });

  it("emits authenticate in both languages", () => {
    const sdk = generateClientSdk(tokenHar);
    expect(sdk.typescript).toContain("async authenticate(");
    expect(sdk.typescript).toContain("application/x-www-form-urlencoded");
    expect(sdk.typescript).toContain("bearerToken");
    expect(sdk.python).toContain("def authenticate(");
    expect(sdk.python).toContain("self.bearer_token");
    const source = ts.createSourceFile(
      "client.ts",
      sdk.typescript,
      ts.ScriptTarget.Latest,
      true,
    );
    expect(
      (source as unknown as { parseDiagnostics?: readonly unknown[] })
        .parseDiagnostics ?? [],
    ).toEqual([]);
  });
});
