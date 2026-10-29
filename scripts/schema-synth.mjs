#!/usr/bin/env node
/** Infer a typed contract from JSON samples. */
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  const value = index >= 0 ? args[index + 1] : undefined;
  return value === undefined ? fallback : value;
};
const inputPath = flag("input");
if (inputPath === undefined) {
  process.stderr.write(
    "usage: node scripts/schema-synth.mjs --input samples.json [--name Model] [--format ts|pydantic|openapi] [--out file]\n",
  );
  process.exit(2);
}
const rootName = flag("name", "Model");
const format = flag("format", "ts");
if (!["ts", "pydantic", "openapi"].includes(format)) {
  process.stderr.write("--format must be ts, pydantic or openapi\n");
  process.exit(2);
}

const parsed = JSON.parse(
  (await readFile(resolve(inputPath), "utf8")).replace(/^\uFEFF/u, ""),
);
const samples = Array.isArray(parsed) ? parsed : [parsed];
if (
  samples.length === 0 ||
  samples.some((s) => s === null || typeof s !== "object" || Array.isArray(s))
) {
  process.stderr.write("input must be an object or an array of objects\n");
  process.exit(2);
}

const isPlainObject = (v) =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const camel = (t) =>
  t
    .replace(/[^A-Za-z0-9]+(.)?/gu, (_, c) => (c ? c.toUpperCase() : ""))
    .replace(/^(.)/u, (c) => c.toUpperCase());

const infer = (values) => {
  const present = values.filter((v) => v !== null && v !== undefined);
  const nullable = present.length !== values.length;
  if (present.length === 0) return { kind: "null" };
  if (present.every(isPlainObject))
    return { kind: "object", nullable, fields: inferFields(present) };
  if (present.every(Array.isArray))
    return { kind: "array", nullable, items: infer(present.flat()) };
  if (present.every((v) => typeof v === "string")) {
    const distinct = [...new Set(present)].sort();
    return {
      kind: "string",
      nullable,
      enums:
        distinct.length <= 8 && distinct.length < present.length
          ? distinct
          : null,
    };
  }
  if (present.every((v) => typeof v === "number"))
    return {
      kind: present.every((v) => Number.isInteger(v)) ? "int" : "number",
      nullable,
    };
  if (present.every((v) => typeof v === "boolean"))
    return { kind: "boolean", nullable };
  return { kind: "unknown", nullable };
};

function inferFields(objects) {
  const keys = [...new Set(objects.flatMap((o) => Object.keys(o)))].sort();
  const fields = {};
  for (const key of keys) {
    const values = objects.filter((o) => key in o).map((o) => o[key]);
    fields[key] = {
      descriptor: infer(values),
      optional: values.length < objects.length,
    };
  }
  return fields;
}

const root = inferFields(samples);

const tsType = (d, hint, decls) => {
  const union = [];
  if (d.kind === "string")
    union.push(
      d.enums ? d.enums.map((v) => JSON.stringify(v)).join(" | ") : "string",
    );
  else if (d.kind === "number" || d.kind === "int") union.push("number");
  else if (d.kind === "boolean") union.push("boolean");
  else if (d.kind === "null") union.push("null");
  else if (d.kind === "unknown") union.push("unknown");
  else if (d.kind === "array")
    union.push(`Array<${tsType(d.items, hint + "Item", decls)}>`);
  else {
    decls.push(renderInterface(hint, d.fields, 1, decls));
    union.push(hint);
  }
  if (d.nullable && !union.includes("null")) union.push("null");
  return union.join(" | ");
};

const renderInterface = (name, fields, level, decls) => {
  const pad = "  ".repeat(level);
  const lines = [`${pad}export interface ${name} {`];
  for (const [key, field] of Object.entries(fields))
    lines.push(
      `${pad}  ${key}${field.optional ? "?" : ""}: ${tsType(field.descriptor, name + camel(key), decls)};`,
    );
  lines.push(`${pad}}`);
  return lines.join("\n");
};

const renderTs = () => {
  const decls = [];
  const main = renderInterface(rootName, root, 0, decls);
  return [...decls, "", main, ""].join("\n\n").replace(/\n{3,}/gu, "\n\n");
};

const pyType = (d, hint, decls) => {
  let base;
  if (d.kind === "string")
    base = d.enums
      ? `Literal[${d.enums.map((v) => JSON.stringify(v)).join(", ")}]`
      : "str";
  else if (d.kind === "number") base = "float";
  else if (d.kind === "int") base = "int";
  else if (d.kind === "boolean") base = "bool";
  else if (d.kind === "null") base = "None";
  else if (d.kind === "array")
    base = `list[${pyType(d.items, hint + "Item", decls)}]`;
  else if (d.kind === "object") {
    decls.push(renderPyClass(hint, d.fields, decls));
    base = hint;
  } else base = "Any";
  return d.nullable ? `Optional[${base}]` : base;
};

const renderPyClass = (name, fields, decls) => {
  const lines = [`class ${name}(BaseModel):`];
  if (Object.keys(fields).length === 0) lines.push("    pass");
  for (const [key, field] of Object.entries(fields))
    lines.push(
      `    ${key}: ${pyType(field.descriptor, name + camel(key), decls)}${field.optional ? " = None" : ""}`,
    );
  return lines.join("\n");
};

const renderPydantic = () => {
  const decls = [];
  const main = renderPyClass(rootName, root, decls);
  return [
    "from typing import Any, Literal, Optional",
    "from pydantic import BaseModel",
    "",
    ...decls,
    "",
    main,
    "",
  ].join("\n");
};

const jsonSchemaOf = (d) => {
  if (d.kind === "object") {
    const properties = {};
    const required = [];
    for (const [key, field] of Object.entries(d.fields)) {
      properties[key] = jsonSchemaOf(field.descriptor);
      if (!field.optional) required.push(key);
    }
    return { type: "object", properties, required };
  }
  if (d.kind === "array")
    return { type: "array", items: jsonSchemaOf(d.items) };
  if (d.kind === "string")
    return d.enums ? { type: "string", enum: d.enums } : { type: "string" };
  if (d.kind === "number") return { type: "number" };
  if (d.kind === "int") return { type: "integer" };
  if (d.kind === "boolean") return { type: "boolean" };
  if (d.kind === "null") return { type: "null" };
  return {};
};

const renderOpenapi = () =>
  JSON.stringify(
    {
      openapi: "3.1.0",
      info: { title: rootName, version: "0.0.0-inferred" },
      components: {
        schemas: { [rootName]: jsonSchemaOf({ kind: "object", fields: root }) },
      },
    },
    null,
    2,
  ) + "\n";

const output =
  format === "ts"
    ? renderTs()
    : format === "pydantic"
      ? renderPydantic()
      : renderOpenapi();
const outPath = flag("out");
if (outPath === undefined) process.stdout.write(output);
else {
  await writeFile(resolve(outPath), output, "utf8");
  process.stderr.write(`wrote ${format} schema to ${String(outPath)}\n`);
}
