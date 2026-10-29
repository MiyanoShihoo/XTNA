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

Schema inference maps strings, integers, numbers, booleans, nulls, arrays and objects.
`required` keeps only the fields present in **every** sample, so a field seen once is optional.

## Limits

- Types come from JSON only; headers, cookies, auth schemes and content negotiation are not
  modelled.
- Path parameters are always `string`, even when the sample was numeric.
- Query parameters are typed `string`, with `required: false`.
- Merging incompatible types emits `anyOf` rather than a guess.
- The document describes what was recorded, not what the server accepts.
