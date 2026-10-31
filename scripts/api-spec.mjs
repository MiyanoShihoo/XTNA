#!/usr/bin/env node
/**
 * Infer an OpenAPI 3.1 document from a recorded HTTP capture.
 *
 * Requests are grouped by method and path template; request and response
 * schemas come from the recorded JSON bodies, merged across samples. The
 * result describes what was observed, not what the server promises.
 */
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const args = process.argv.slice(2);
const flag = (name) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};

const input = flag("in");
const output = flag("out");

if (input === undefined || output === undefined) {
  process.stderr.write(
    "usage: node scripts/api-spec.mjs --in <capture.har> --out <openapi.json> [--title Name] [--version 1.0.0] [--server https://api.example] [--synthesis]\n",
  );
  process.exit(2);
}

const { buildOpenApi } = await import(
  new URL("../dist/application/api/OpenApiFromCapture.js", import.meta.url).href
);

const document = JSON.parse(
  (await readFile(resolve(input), "utf8")).replace(/^\uFEFF/u, ""),
);
const openapi = buildOpenApi(document, {
  ...(flag("title") === undefined ? {} : { title: flag("title") }),
  ...(flag("version") === undefined ? {} : { version: flag("version") }),
  ...(flag("server") === undefined ? {} : { serverUrl: flag("server") }),
  ...(args.includes("--synthesis") ? { withSynthesis: true } : {}),
});

const target = resolve(output);
await writeFile(target, `${JSON.stringify(openapi, null, 2)}\n`, "utf8");
process.stdout.write(
  `${JSON.stringify(
    {
      output: target,
      openapi: openapi.openapi,
      paths: Object.keys(openapi.paths).length,
      synthesis: args.includes("--synthesis"),
      operations: Object.values(openapi.paths).reduce(
        (count, entry) => count + Object.keys(entry).length,
        0,
      ),
    },
    null,
    2,
  )}\n`,
);
