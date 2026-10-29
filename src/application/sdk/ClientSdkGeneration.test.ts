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
});

describe("empty input", () => {
  it("returns empty clients rather than throwing", () => {
    const sdk = generateClientSdk({ log: { entries: [] } });
    expect(sdk.operations).toEqual([]);
    expect(sdk.typescript).toContain("export class ApiClient");
  });
});
