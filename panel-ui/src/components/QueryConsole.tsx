import { useEffect, useState } from "react";

import {
  fetchQueryInfo,
  runQuery,
  setQueryToken,
  type QueryInfo,
} from "../panel";

interface Pending {
  requestId: string;
  tool: string;
  args: Record<string, string>;
}

export function QueryConsole() {
  const [info, setInfo] = useState<QueryInfo>({ enabled: false, tools: [] });
  const [token, setToken] = useState("");
  const [tool, setTool] = useState("");
  const [key, setKey] = useState("procedure");
  const [value, setValue] = useState("");
  const [code, setCode] = useState("");
  const [status, setStatus] = useState("");
  const [result, setResult] = useState("");
  const [pending, setPending] = useState<Pending | null>(null);

  useEffect(() => {
    fetchQueryInfo()
      .then((next) => {
        setInfo(next);
        setTool(next.tools[0] ?? "");
      })
      .catch(() => setInfo({ enabled: false, tools: [] }));
  }, []);

  if (!info.enabled)
    return (
      <section className="panel">
        <h2>Provider query</h2>
        <p className="muted">
          Disabled. Start the panel with <code>--mcp-url</code> and{" "}
          <code>--query-token</code>.
        </p>
      </section>
    );

  const submit = async () => {
    const args = value.trim().length === 0 ? {} : { [key]: value.trim() };
    setStatus("running…");
    setResult("");
    try {
      const response = await runQuery(
        tool,
        args,
        token,
        pending === null || code.trim().length === 0
          ? undefined
          : { requestId: pending.requestId, code: code.trim() },
      );
      if (response.status === 202) {
        const requestId = response.body.requestId ?? "";
        setPending({ requestId, tool, args });
        setStatus("approve in the panel terminal, then paste the code");
        setResult(JSON.stringify(response.body, null, 2));
        return;
      }
      setPending(null);
      setCode("");
      setStatus(
        response.status === 200 ? "ok" : `rejected (${response.status})`,
      );
      setResult(
        JSON.stringify(
          response.status === 200 ? response.body.result : response.body.error,
          null,
          2,
        ),
      );
    } catch (error) {
      setStatus(`failed: ${String(error)}`);
    }
  };

  return (
    <section className="panel">
      <h2>Provider query</h2>
      <p className="muted">
        Read-only allowlist; write tools need <code>--allow-write-tools</code>{" "}
        plus a terminal approval code.
      </p>
      <div className="query-row">
        <select value={tool} onChange={(event) => setTool(event.target.value)}>
          {info.tools.map((entry) => (
            <option key={entry} value={entry}>
              {entry}
            </option>
          ))}
          {(info.writeTools ?? []).map((entry) => (
            <option key={entry} value={entry}>
              {entry} (approval)
            </option>
          ))}
        </select>
        <select value={key} onChange={(event) => setKey(event.target.value)}>
          <option value="procedure">procedure</option>
          <option value="address">address</option>
          <option value="name">name</option>
          <option value="pattern">pattern</option>
        </select>
        <input
          placeholder="value"
          value={value}
          onChange={(event) => setValue(event.target.value)}
        />
      </div>
      <div className="query-row">
        <input
          type="password"
          placeholder="x-xtna-token"
          value={token}
          onChange={(event) => {
            setToken(event.target.value);
            setQueryToken(event.target.value);
          }}
        />
        <input
          placeholder="approval code (if pending)"
          value={code}
          onChange={(event) => setCode(event.target.value)}
        />
        <button onClick={() => void submit()}>Query</button>
        <span className="muted">{status}</span>
      </div>
      {result.length > 0 && <pre className="result">{result}</pre>}
    </section>
  );
}
