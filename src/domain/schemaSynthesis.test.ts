import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";

import {
  schemaSynthesisResultSchema,
  synthesizeJsonSchema,
  toOpenApi31,
} from "./schemaSynthesis.js";
import type { JsonValue } from "./jsonValue.js";

const schemaAt = (value: JsonValue, ...segments: string[]): any => {
  let current: any = value;
  for (const segment of segments) current = current[segment];
  return current;
};

// oxlint-disable-next-line max-lines-per-function -- The scenario matrix stays adjacent for auditability.
describe("schema synthesis", () => {
  it("derives required fields independently from explicit nulls", () => {
    const result = synthesizeJsonSchema([
      { id: 1, nickname: "one", active: true },
      { id: 2, nickname: null, active: false },
      { id: 3, active: true },
    ]);
    expect(result.schema).toMatchObject({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      required: ["active", "id"],
      properties: {
        id: { type: "integer" },
        active: { type: "boolean", enum: [false, true] },
        nickname: { type: ["string", "null"] },
      },
    });
    expect(
      result.evidence.find(({ json_pointer }) => json_pointer === "/nickname"),
    ).toMatchObject({ present_count: 2, missing_count: 1 });
    expect(result.ambiguities).toContainEqual(
      expect.objectContaining({
        code: "enum-not-inferred",
        json_pointer: "/nickname",
      }),
    );
    expect(schemaSynthesisResultSchema.parse(result)).toEqual(result);
  });

  it("preserves missing and null evidence at nested paths", () => {
    const result = synthesizeJsonSchema([
      { profile: { name: "Ada", address: null } },
      { profile: { name: "Grace" } },
      { profile: null },
    ]);
    const name = result.evidence.find(
      ({ json_pointer }) => json_pointer === "/profile/name",
    );
    expect(name?.observations).toEqual([
      {
        sample_pointer: "/0/profile/name",
        presence: "present",
        observed_type: "string",
      },
      {
        sample_pointer: "/1/profile/name",
        presence: "present",
        observed_type: "string",
      },
    ]);
    const address = result.evidence.find(
      ({ json_pointer }) => json_pointer === "/profile/address",
    );
    expect(address).toMatchObject({ present_count: 1, missing_count: 1 });
  });

  it("unifies array item observations without pretending empty items are known", () => {
    const result = synthesizeJsonSchema([
      { values: [1, 2.5], empty: [] },
      { values: [3], empty: [] },
    ]);
    expect(schemaAt(result.schema, "properties", "values", "items")).toEqual({
      type: "number",
    });
    expect(schemaAt(result.schema, "properties", "empty", "items")).toBe(true);
    expect(result.ambiguities).toContainEqual(
      expect.objectContaining({
        code: "empty-array-items",
        json_pointer: "/empty/items",
      }),
    );
  });

  it("retains mixed scalar alternatives and integer widening", () => {
    const mixed = synthesizeJsonSchema([{ value: 1 }, { value: "1" }]);
    expect(schemaAt(mixed.schema, "properties", "value", "type")).toEqual([
      "integer",
      "string",
    ]);
    expect(mixed.ambiguities).toContainEqual(
      expect.objectContaining({ code: "mixed-types", json_pointer: "/value" }),
    );
    const numeric = synthesizeJsonSchema([{ value: 1 }, { value: 2.5 }]);
    expect(schemaAt(numeric.schema, "properties", "value", "type")).toBe(
      "number",
    );
  });

  it("infers only repeated low-cardinality scalar enums", () => {
    const result = synthesizeJsonSchema([
      { state: "open", rank: 1, enabled: true },
      { state: "closed", rank: 2, enabled: false },
      { state: "open", rank: 1, enabled: true },
    ]);
    expect(schemaAt(result.schema, "properties", "state", "enum")).toEqual([
      "closed",
      "open",
    ]);
    expect(schemaAt(result.schema, "properties", "rank", "enum")).toEqual([
      1, 2,
    ]);
    expect(schemaAt(result.schema, "properties", "enabled", "enum")).toEqual([
      false,
      true,
    ]);
  });

  it("withholds all-unique and over-budget string enums with reasons", () => {
    const unique = synthesizeJsonSchema([{ name: "a" }, { name: "b" }]);
    expect(
      schemaAt(unique.schema, "properties", "name", "enum"),
    ).toBeUndefined();
    expect(unique.enum_candidates[0]).toMatchObject({
      status: "withheld",
      distinct_values: ["a", "b"],
    });
    const budget = synthesizeJsonSchema(
      [{ value: "a" }, { value: "b" }, { value: "a" }],
      { maxEnumValues: 1 },
    );
    expect(budget.enum_candidates[0]?.reason).toContain("maxEnumValues 1");
    expect(
      schemaAt(budget.schema, "properties", "value", "enum"),
    ).toBeUndefined();
  });

  it("escapes JSON Pointer segments and retains deterministic output", () => {
    const input = [{ "a/b": { "~key": "x" } }];
    const first = synthesizeJsonSchema(input);
    const second = synthesizeJsonSchema(input);
    expect(first).toEqual(second);
    expect(first.evidence.map(({ json_pointer }) => json_pointer)).toContain(
      "/a~1b/~0key",
    );
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.evidence)).toBe(true);
    expect(input).toEqual([{ "a/b": { "~key": "x" } }]);
  });

  it("validates synthesized draft 2020-12 schemas against actual samples", () => {
    const samples = [
      { id: 1, state: "open", child: { ok: true } },
      { id: 2, state: "open", child: null },
    ];
    const result = synthesizeJsonSchema(samples);
    const Ajv = Ajv2020 as unknown as typeof import("ajv").default;
    const ajv = new Ajv({ strict: true });
    const validate = ajv.compile(result.schema as object);
    for (const sample of samples) expect(validate(sample)).toBe(true);
    expect(validate({ id: 3, state: "other", child: null })).toBe(false);
    expect(validate({ state: "open", child: null })).toBe(false);
  });

  it("emits the identical schema inside OpenAPI 3.1 without nullable keywords", () => {
    const result = synthesizeJsonSchema([{ value: null }, { value: "x" }]);
    const document = toOpenApi31(result, "Example");
    expect(document.openapi).toBe("3.1.0");
    expect(document.components.schemas.Model).toEqual(result.schema);
    expect(JSON.stringify(document)).not.toContain("nullable");
    expect(document.info.title).toBe("Example");
  });

  it("marks single-sample and unconstrained-object limits explicitly", () => {
    const result = synthesizeJsonSchema([{ free: {} }]);
    expect(result.ambiguities).toContainEqual(
      expect.objectContaining({ code: "single-sample-generalization" }),
    );
    expect(schemaAt(result.schema, "properties", "free")).toMatchObject({
      additionalProperties: true,
      required: [],
    });
  });

  it("supports root scalars and rejects invalid boundaries", () => {
    expect(synthesizeJsonSchema([null, "x"]).schema).toMatchObject({
      type: ["string", "null"],
    });
    expect(() => synthesizeJsonSchema([])).toThrow();
    expect(() =>
      synthesizeJsonSchema([{ value: 1 }], { maxEnumValues: 0 }),
    ).toThrow();
    expect(() => synthesizeJsonSchema([{ value: Number.NaN }])).toThrow();
  });
});
