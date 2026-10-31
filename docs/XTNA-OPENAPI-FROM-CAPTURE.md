# OpenAPI from a capture

`npm run api:spec -- --in capture.har --out openapi.json` turns recorded HTTP traffic into an
OpenAPI 3.1 document with per-operation request and response schemas.

## Why

A capture proves what the client sent and what the server returned. Turning that into a
contract by hand is slow and loses samples. Grouping by method and path template, then merging
the recorded JSON bodies, gets a usable first draft — one a human still has to review.

## Output

```json
{
  "openapi": "3.1.0",
  "info": { "title": "Users", "version": "1.0.0" },
  "servers": [{ "url": "https://api.test" }],
  "paths": {
    "/users": { "get": { … }, "post": { … } },
    "/users/{id}": { "get": { … } }
  }
}
```

| Element       | Source                                                                         |
| ------------- | ------------------------------------------------------------------------------ |
| path template | numeric and UUID segments become `{id}`                                        |
| parameters    | path parameters required, query parameters optional, both typed `string`       |
| requestBody   | merged schema of every recorded JSON request body                              |
| responses     | merged schema of every recorded JSON response, keyed by the lowest status seen |

Schema inference is delegated to the typed `synthesizeJsonSchema` contract
(`src/domain/schemaSynthesis.ts`), not a second hand-rolled merge. It records per-pointer evidence,
mixed-type ambiguities and enum candidates (visible enums are inferred, non-repeating strings are
withheld with a reason). `required` keeps only fields present in every sample.

With `--synthesis`, each operation carries `x-xtna-synthesis: {request?, response?}` — the complete
typed result with its dialect, sample count, evidence, ambiguities and enum candidates.

## Limits

- Types come from JSON only; headers, cookies, auth schemes and content negotiation are not
  modelled.
- Path parameters are always `string`, even when the sample was numeric.
- Query parameters are typed `string`, with `required: false`.
- Incompatible observed types become a JSON Schema type union with a `mixed-types` ambiguity,
  not a closed-world `anyOf` guess.
- The typed synthesis result is OPT-IN (`--synthesis`); without it the document stays compact.
- The document describes what was recorded, not what the server accepts.

## MCP

`openapi_from_capture` exposes the same builder over MCP: input is `capture_path`, optional
`title`/`version`/`server_url`, and `with_synthesis`. It reads one local capture and never
replays requests or contacts the recorded origin. Missing or malformed captures are returned as a
typed input error, not an empty document.
