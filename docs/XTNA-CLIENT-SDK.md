# Client SDK generation

`npm run sdk:gen -- --in <capture> --out <dir>` turns recorded HTTP traffic into a typed,
dependency-free client in TypeScript and Python.

## Input

A HAR document, or any object with `entries` / `log.entries`. Each entry needs `request.method`
and `request.url`; bodies and responses are used when present as JSON text.

## Output

| File             | Runtime requirement                      |
| ---------------- | ---------------------------------------- |
| `client.ts`      | global `fetch` (Node 18+, browsers)      |
| `client.test.ts` | Vitest; mocks the private transport      |
| `client.py`      | standard library only (`urllib`, `json`) |
| `test_client.py` | Python `unittest`; mocks `_call`         |

Each request becomes one method. Requests that share a method and a path template merge into
one operation: `/users/42` and `/users/7` both become `/users/{id}` with one `id` parameter.
Query parameters and their types come from the recorded URLs; response types come from the
recorded JSON bodies, merged with optionality where a field is missing or null in any sample.

```bash
npm run sdk:gen -- --in traffic.har --out ./client --name UsersClient \
  --base-url https://api.example.test
npm run sdk:gen -- --in traffic.har --out ./client --lang py
```

The command prints the operation count, the generated method names and the files it wrote.
Each generated smoke test calls every operation with placeholder arguments and mocks the
transport, so it verifies method wiring, path substitution, query/body passing and the HTTP
method without making network requests.

## What it will not do

- Execute anything, call the recorded URLs, or read credentials from headers.
- Infer authentication flows, retry policies or pagination. Those need a human decision.
- Produce UI code: the client is transport only.
- Guarantee the server still behaves as recorded — the capture is the only evidence it has.

## Limits

- Path templating recognises numeric and UUID segments. Named resources such as
  `/users/ada` stay literal; add a manual parameter afterwards.
- Response types are structural and inline. They describe the samples seen, not a schema the
  server promises.
- Bodies are treated as JSON. Binary and form payloads are ignored.
- Generated tests are smoke tests with mocked transport, not server contract tests or
  end-to-end authentication/retry verification.
- Generated code is a starting point: review error handling and base URL before shipping.
