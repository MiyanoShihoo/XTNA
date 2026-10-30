import { z } from "zod";

import { freezeJsonSnapshot } from "./immutableJson.js";
import { jsonValueSchema, type JsonValue } from "./jsonValue.js";

export const jsonTypeNameSchema = z.enum([
  "array",
  "boolean",
  "integer",
  "null",
  "number",
  "object",
  "string",
]);

export type JsonTypeName = z.infer<typeof jsonTypeNameSchema>;

export const schemaSampleObservationSchema = z
  .object({
    sample_pointer: z.string(),
    presence: z.enum(["present", "missing"]),
    observed_type: jsonTypeNameSchema.optional(),
  })
  .strict();

export const schemaPathEvidenceSchema = z
  .object({
    json_pointer: z.string(),
    observations: z.array(schemaSampleObservationSchema),
    present_count: z.number().int().nonnegative(),
    missing_count: z.number().int().nonnegative(),
    observed_types: z.array(jsonTypeNameSchema),
  })
  .strict();

export const schemaAmbiguitySchema = z
  .object({
    code: z.enum([
      "empty-array-items",
      "enum-not-inferred",
      "mixed-types",
      "single-sample-generalization",
    ]),
    json_pointer: z.string(),
    observed_types: z.array(jsonTypeNameSchema),
    reason: z.string().min(1),
  })
  .strict();

export const enumCandidateSchema = z
  .object({
    json_pointer: z.string(),
    status: z.enum(["inferred", "withheld"]),
    distinct_values: z.array(jsonValueSchema),
    sample_count: z.number().int().positive(),
    reason: z.string().min(1).optional(),
  })
  .strict();

export const schemaSynthesisResultSchema = z
  .object({
    schema: jsonValueSchema,
    schema_dialect: z.literal("https://json-schema.org/draft/2020-12/schema"),
    sample_count: z.number().int().positive(),
    evidence: z.array(schemaPathEvidenceSchema),
    ambiguities: z.array(schemaAmbiguitySchema),
    enum_candidates: z.array(enumCandidateSchema),
  })
  .strict();

export const schemaSynthesisOptionsSchema = z
  .object({
    maxEnumValues: z.number().int().min(1).max(100).default(8),
  })
  .strict();

export type SchemaSynthesisResult = z.infer<typeof schemaSynthesisResultSchema>;
export type SchemaSynthesisOptions = z.input<
  typeof schemaSynthesisOptionsSchema
>;
export type OpenApi31Document = {
  readonly openapi: "3.1.0";
  readonly info: { readonly title: string; readonly version: string };
  readonly paths: Readonly<Record<string, never>>;
  readonly components: {
    readonly schemas: { readonly Model: JsonValue };
  };
};

type Sample = { readonly pointer: string; readonly value: JsonValue };
type JsonObject = { [key: string]: JsonValue };

const typeOf = (value: JsonValue): JsonTypeName => {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "object") return "object";
  if (typeof value === "string") return "string";
  if (typeof value === "boolean") return "boolean";
  return Number.isInteger(value) ? "integer" : "number";
};

const pointerSegment = (value: string | number): string =>
  String(value).replaceAll("~", "~0").replaceAll("/", "~1");

const childPointer = (pointer: string, segment: string | number): string =>
  `${pointer}/${pointerSegment(segment)}`;

const schemaType = (
  types: readonly JsonTypeName[],
): string | string[] | undefined => {
  const normalized: JsonTypeName[] = [
    ...new Set(
      types.includes("number")
        ? types.filter((type) => type !== "integer")
        : types,
    ),
  ]
    .filter((type) => type !== "null")
    .sort();
  if (types.includes("null")) normalized.push("null");
  if (normalized.length === 0) return undefined;
  return normalized.length === 1 ? normalized[0] : normalized;
};

interface Accumulator {
  readonly evidence: z.infer<typeof schemaPathEvidenceSchema>[];
  readonly ambiguities: z.infer<typeof schemaAmbiguitySchema>[];
  readonly enumCandidates: z.infer<typeof enumCandidateSchema>[];
}

const mergeType = (
  types: readonly JsonTypeName[],
  kind: "array" | "object",
): boolean => types.every((type) => type === kind || type === "null");

/** Infer only constraints exhibited by the supplied samples. */
export const synthesizeJsonSchema = (
  inputSamples: readonly JsonValue[],
  options: SchemaSynthesisOptions = {},
): SchemaSynthesisResult => {
  const samples = z.array(jsonValueSchema).min(1).parse(inputSamples);
  const settings = schemaSynthesisOptionsSchema.parse(options);
  const accumulator: Accumulator = {
    evidence: [],
    ambiguities: [],
    enumCandidates: [],
  };
  if (samples.length === 1)
    accumulator.ambiguities.push({
      code: "single-sample-generalization",
      json_pointer: "",
      observed_types: [typeOf(samples[0]!)],
      reason:
        "One sample cannot establish that omitted fields, unseen values, or observed types are exhaustive.",
    });
  const schema = infer(
    samples.map((value, index) => ({
      pointer: childPointer("", index),
      value,
    })),
    "",
    accumulator,
    settings.maxEnumValues,
  );
  return freezeJsonSnapshot({
    schema,
    schema_dialect: "https://json-schema.org/draft/2020-12/schema",
    sample_count: samples.length,
    evidence: accumulator.evidence,
    ambiguities: accumulator.ambiguities,
    enum_candidates: accumulator.enumCandidates,
  } as JsonValue) as unknown as SchemaSynthesisResult;
};

function infer(
  samples: readonly Sample[],
  pointer: string,
  accumulator: Accumulator,
  maxEnumValues: number,
): JsonObject {
  const types = [...new Set(samples.map(({ value }) => typeOf(value)))].sort();
  accumulator.evidence.push({
    json_pointer: pointer,
    observations: samples.map(({ pointer: samplePointer, value }) => ({
      sample_pointer: samplePointer,
      presence: "present",
      observed_type: typeOf(value),
    })),
    present_count: samples.length,
    missing_count: 0,
    observed_types: types,
  });
  const schema: JsonObject = {};
  if (pointer === "")
    schema.$schema = "https://json-schema.org/draft/2020-12/schema";
  const type = schemaType(types);
  if (type !== undefined) schema.type = type;
  if (
    types.filter((type) => type !== "null" && type !== "integer").length > 1 ||
    (types.includes("integer") &&
      types.some((type) => !["integer", "null", "number"].includes(type)))
  )
    accumulator.ambiguities.push({
      code: "mixed-types",
      json_pointer: pointer,
      observed_types: types,
      reason:
        "Observed types are not one numeric family; the union is sample evidence, not a closed-world assertion.",
    });
  if (mergeType(types, "object")) {
    const objects = samples.filter(
      (sample): sample is Sample & { readonly value: JsonObject } =>
        typeof sample.value === "object" &&
        sample.value !== null &&
        !Array.isArray(sample.value),
    );
    const properties: JsonObject = {};
    const required: string[] = [];
    const keys = [
      ...new Set(objects.flatMap(({ value }) => Object.keys(value))),
    ].sort();
    for (const key of keys) {
      const fieldPointer = childPointer(pointer, key);
      const present = objects.flatMap((sample) =>
        Object.hasOwn(sample.value, key)
          ? [
              {
                pointer: childPointer(sample.pointer, key),
                value: sample.value[key]!,
              },
            ]
          : [],
      );
      const missing = objects.filter(
        (sample) => !Object.hasOwn(sample.value, key),
      );
      properties[key] = infer(
        present,
        fieldPointer,
        accumulator,
        maxEnumValues,
      );
      const evidence = accumulator.evidence.find(
        (entry) => entry.json_pointer === fieldPointer,
      )!;
      evidence.observations.push(
        ...missing.map((sample) => ({
          sample_pointer: sample.pointer,
          presence: "missing" as const,
        })),
      );
      evidence.missing_count = missing.length;
      if (missing.length === 0) required.push(key);
    }
    schema.properties = properties;
    schema.required = required;
    schema.additionalProperties = true;
  }
  if (mergeType(types, "array")) {
    const items = samples.flatMap((sample) =>
      Array.isArray(sample.value)
        ? sample.value.map((value, index) => ({
            pointer: childPointer(sample.pointer, index),
            value,
          }))
        : [],
    );
    if (items.length === 0) {
      schema.items = true;
      accumulator.ambiguities.push({
        code: "empty-array-items",
        json_pointer: childPointer(pointer, "items"),
        observed_types: [],
        reason:
          "Every observed array is empty; no item type can be inferred without inventing a constraint.",
      });
    } else {
      schema.items = infer(
        items,
        childPointer(pointer, "items"),
        accumulator,
        maxEnumValues,
      );
    }
  }
  inferStrings(samples, pointer, schema, accumulator, maxEnumValues);
  inferScalars(samples, pointer, schema, accumulator);
  return schema;
}

function inferScalars(
  samples: readonly Sample[],
  pointer: string,
  schema: JsonObject,
  accumulator: Accumulator,
): void {
  const values = samples.map(({ value }) => value);
  const types = new Set(values.map(typeOf));
  if (
    ![...types].every((type) => ["boolean", "integer", "number"].includes(type))
  )
    return;
  const distinct = [
    ...new Map(values.map((value) => [JSON.stringify(value), value])).values(),
  ].sort((left, right) =>
    JSON.stringify(left).localeCompare(JSON.stringify(right)),
  );
  if (distinct.length === 0 || distinct.length >= values.length) return;
  schema.enum = distinct;
  accumulator.enumCandidates.push({
    json_pointer: pointer,
    status: "inferred",
    distinct_values: distinct,
    sample_count: values.length,
  });
}

const typesContainNonString = (samples: readonly Sample[]): boolean =>
  samples.some(({ value }) => value !== null && typeof value !== "string");

function inferStrings(
  samples: readonly Sample[],
  pointer: string,
  schema: JsonObject,
  accumulator: Accumulator,
  maxEnumValues: number,
): void {
  const values = samples.flatMap(({ value }) =>
    typeof value === "string" ? [value] : [],
  );
  if (values.length === 0 || typesContainNonString(samples)) return;
  const distinct = [...new Set(values)].sort();
  if (distinct.length <= maxEnumValues && distinct.length < values.length) {
    schema.enum = distinct;
    accumulator.enumCandidates.push({
      json_pointer: pointer,
      status: "inferred",
      distinct_values: distinct,
      sample_count: values.length,
    });
    return;
  }
  const reason =
    distinct.length > maxEnumValues
      ? `Distinct string count ${distinct.length} exceeds maxEnumValues ${maxEnumValues}; enum was withheld.`
      : "No observed string repeats; an enum would reject every unseen value without supporting evidence.";
  accumulator.enumCandidates.push({
    json_pointer: pointer,
    status: "withheld",
    distinct_values: distinct,
    sample_count: values.length,
    reason,
  });
  accumulator.ambiguities.push({
    code: "enum-not-inferred",
    json_pointer: pointer,
    observed_types: ["string"],
    reason,
  });
}

/** Wrap a draft 2020-12 schema as an OpenAPI 3.1 components document. */
export const toOpenApi31 = (
  synthesis: SchemaSynthesisResult,
  title = "Model",
): OpenApi31Document => {
  const checked = schemaSynthesisResultSchema.parse(synthesis);
  if (!/^\S+$/u.test(title))
    throw new TypeError("OpenAPI title must not be empty");
  return freezeJsonSnapshot({
    openapi: "3.1.0",
    info: { title, version: "0.0.0-inferred" },
    paths: {},
    components: { schemas: { Model: checked.schema } },
  }) as OpenApi31Document;
};
