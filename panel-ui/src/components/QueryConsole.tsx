import { useEffect, useState } from "react";

import {
  fetchQueryInfo,
  runQuery,
  setQueryToken,
  type QueryInfo,
} from "../panel";
import { useI18n } from "../i18n";

interface Pending {
  requestId: string;
  tool: string;
  args: Record<string, string>;
}

export function QueryConsole() {
  const { t } = useI18n();
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
        <div className="panelHead">
          <h2>{t("providerQuery")}</h2>
        </div>
        <p className="muted">{t("queryDisabled")}</p>
      </section>
    );

  const submit = async () => {
    const args = value.trim().length === 0 ? {} : { [key]: value.trim() };
    setStatus(t("running"));
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
        setStatus(t("approvePending"));
        setResult(JSON.stringify(response.body, null, 2));
        return;
      }
      setPending(null);
      setCode("");
      setStatus(
        response.status === 200
          ? t("ok")
          : `${t("rejected")} (${response.status})`,
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
      <div className="panelHead">
        <h2>{t("providerQuery")}</h2>
      </div>
      <p className="muted">{t("queryHint")}</p>
      <div className="queryRow">
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
          placeholder={t("value")}
          value={value}
          onChange={(event) => setValue(event.target.value)}
        />
      </div>
      <div className="queryRow">
        <input
          type="password"
          placeholder={t("token")}
          value={token}
          onChange={(event) => {
            setToken(event.target.value);
            setQueryToken(event.target.value);
          }}
        />
        <input
          placeholder={t("approvalCode")}
          value={code}
          onChange={(event) => setCode(event.target.value)}
        />
        <button type="button" onClick={() => void submit()}>
          {t("query")}
        </button>
        <span className="muted">{status}</span>
      </div>
      {result.length > 0 && <pre className="result">{result}</pre>}
    </section>
  );
}
