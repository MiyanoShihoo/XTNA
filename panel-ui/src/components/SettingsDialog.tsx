import { useEffect, useState } from "react";

import { useI18n } from "../i18n";

interface RuntimeConfig {
  baseUrl: string;
  model: string;
  apiStyle: "chat" | "responses" | "auto";
  hasKey: boolean;
}

const emptyConfig: RuntimeConfig = {
  baseUrl: "",
  model: "gpt-4o-mini",
  apiStyle: "chat",
  hasKey: false,
};

export function SettingsDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [config, setConfig] = useState<RuntimeConfig>(emptyConfig);
  const [apiKey, setApiKey] = useState("");
  const [status, setStatus] = useState("");
  const [reachable, setReachable] = useState(true);

  useEffect(() => {
    if (!open) return;
    setStatus("");
    fetch("/control/config")
      .then(async (response) => {
        if (!response.ok) throw new Error(`config ${response.status}`);
        const value = (await response.json()) as RuntimeConfig;
        setConfig(value);
        setReachable(true);
      })
      .catch(() => setReachable(false));
  }, [open]);

  if (!open) return null;

  const save = async () => {
    setStatus(t("saving"));
    try {
      const response = await fetch("/control/config", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          baseUrl: config.baseUrl,
          model: config.model,
          apiStyle: config.apiStyle,
          ...(apiKey.length === 0 ? {} : { apiKey }),
        }),
      });
      if (!response.ok) throw new Error(`save ${response.status}`);
      setStatus(t("saved"));
      setApiKey("");
    } catch (error) {
      setStatus(`failed: ${String(error)}`);
    }
  };

  return (
    <div className="modalBackdrop" role="dialog" aria-modal="true">
      <div className="modal">
        <div className="panelHead">
          <h2>{t("settings")}</h2>
          <button type="button" className="ghost" onClick={onClose}>
            {t("close")}
          </button>
        </div>
        {!reachable ? (
          <p className="error">
            Control API not reachable. Start the panel with{" "}
            <code>npm run panel:dev -- --evidence &lt;bundle.json&gt;</code>.
          </p>
        ) : (
          <>
            <p className="muted">{t("settingsHint")}</p>
            <label className="field">
              <span>{t("baseUrl")}</span>
              <input
                value={config.baseUrl}
                placeholder="https://openrouter.ai/api/v1"
                onChange={(event) =>
                  setConfig({ ...config, baseUrl: event.target.value })
                }
              />
            </label>
            <label className="field">
              <span>{t("apiKey")}</span>
              <input
                type="password"
                value={apiKey}
                placeholder={config.hasKey ? t("keyStored") : "sk-..."}
                onChange={(event) => setApiKey(event.target.value)}
              />
            </label>
            <label className="field">
              <span>{t("model")}</span>
              <input
                value={config.model}
                placeholder="gpt-4o-mini"
                onChange={(event) =>
                  setConfig({ ...config, model: event.target.value })
                }
              />
            </label>
            <label className="field">
              <span>{t("apiStyle")}</span>
              <select
                value={config.apiStyle}
                onChange={(event) =>
                  setConfig({
                    ...config,
                    apiStyle: event.target.value as RuntimeConfig["apiStyle"],
                  })
                }
              >
                <option value="chat">chat</option>
                <option value="responses">responses</option>
                <option value="auto">auto</option>
              </select>
            </label>
            <div className="modalActions">
              <button type="button" onClick={() => void save()}>
                {t("save")}
              </button>
              <span className="muted">{status}</span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
