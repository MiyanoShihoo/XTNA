import { describe, expect, it } from "vitest";

import { buildOpenApi, mergeSchemas, schemaOf } from "./OpenApiFromCapture.js";

const har = {
  log: {
    entries: [
      {
        request: { method: "GET", url: "https://api.test/users" },
        response: {
          status: 200,
          content: { text: JSON.stringify([{ id: 1, name: "Ada" }]) },
        },
      },
      {
        request: { method: "GET", url: "https://api.test/users?limit=10" },
        response: {
          status: 200,
          content: { text: JSON.stringify([{ id: 2, name: "Grace" }]) },
        },
      },
      {
        request: { method: "GET", url: "https://api.test/users/7" },
        response: {
          status: 200,
          content: { text: JSON.stringify({ id: 7, name: "Ada" }) },
        },
      },
      {
        request: {
          method: "POST",
          url: "https://api.test/users",
          postData: { text: JSON.stringify({ name: "New" }) },
        },
        response: {
          status: 201,
          content: { text: JSON.stringify({ id: 3, name: "New" }) },
        },
      },
    ],
  },
};

describe("schema inference", () => {
  it("maps primitives, arrays and objects", () => {
    expect(schemaOf("x")).toEqual({ type: "string" });
    expect(schemaOf(1.5)).toEqual({ type: "number" });
    expect(schemaOf(2)).toEqual({ type: "integer" });
    expect(schemaOf(true)).toEqual({ type: "boolean" });
    expect(schemaOf([1, 2])).toEqual({
      type: "array",
      items: { type: "integer" },
    });
    expect(schemaOf({ a: 1 })).toEqual({
      type: "object",
      properties: { a: { type: "integer" } },
      required: ["a"],
    });
  });

  it("keeps only the fields every sample declares as required", () => {
    const merged = mergeSchemas([
      schemaOf({ id: 1, name: "Ada" }),
      schemaOf({ id: 2 }),
    ]);
    expect(merged.required).toEqual(["id"]);
    expect(Object.keys(merged.properties as Record<string, unknown>)).toEqual([
      "id",
      "name",
    ]);
  });
});

describe("openapi document", () => {
  const document = buildOpenApi(har, { title: "Users", version: "1.0.0" });

  it("declares 3.1 and the server origin", () => {
    expect(document.openapi).toBe("3.1.0");
    expect(document.info).toEqual({ title: "Users", version: "1.0.0" });
    expect(document.servers).toEqual([{ url: "https://api.test" }]);
  });

  it("groups requests by method and path template", () => {
    expect(Object.keys(document.paths).sort()).toEqual([
      "/users",
      "/users/{id}",
    ]);
    const users = document.paths["/users"] as Record<string, unknown>;
    expect(Object.keys(users).sort()).toEqual(["get", "post"]);
  });

  it("describes path and query parameters", () => {
    const byId = (document.paths["/users/{id}"] as Record<string, unknown>)
      .get as {
      parameters: { name: string; in: string; required: boolean }[];
    };
    expect(byId.parameters).toEqual([
      { name: "id", in: "path", required: true, schema: { type: "string" } },
    ]);
    const list = (document.paths["/users"] as Record<string, unknown>).get as {
      parameters: { name: string; in: string; required: boolean }[];
    };
    expect(list.parameters).toEqual([
      {
        name: "limit",
        in: "query",
        required: false,
        schema: { type: "string" },
      },
    ]);
  });

  it("attaches request and response schemas", () => {
    const post = (document.paths["/users"] as Record<string, unknown>).post as {
      requestBody: {
        content: { "application/json": { schema: { required: string[] } } };
      };
      responses: Record<
        string,
        { content: { "application/json": { schema: { type: string } } } }
      >;
    };
    expect(
      post.requestBody.content["application/json"].schema.required,
    ).toEqual(["name"]);
    expect(post.responses["201"]?.content["application/json"].schema.type).toBe(
      "object",
    );
  });
});
