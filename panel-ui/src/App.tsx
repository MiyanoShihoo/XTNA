import { useEffect, useState } from "react";
import { useAgentContext } from "@copilotkit/react-core/v2";
import type { JsonSerializable } from "@copilotkit/react-core/v2";

import { fetchState, type PanelSnapshot } from "./panel";
import { QueryConsole } from "./components/QueryConsole";
import { SettingsDialog } from "./components/SettingsDialog";
import { StateTables } from "./components/StateTables";
import { Topology, Waterfall } from "./components/Topology";
import { useI18n } from "./i18n";
import { usePanelTools } from "./tools";

const countKeys = [
  ["records", "records"],
  ["artifacts", "artifacts"],
  ["unknowns", "unknowns"],
  ["limitations", "limitations"],
  ["symbols", "symbols"],
  ["hypotheses", "hypotheses"],
  ["checkpoints", "checkpoints"],
] as const;

export function Dashboard() {
  const { t, language, setLanguage } = useI18n();
  const [snapshot, setSnapshot] = useState<PanelSnapshot | null>(null);
  const [error, setError] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);

  usePanelTools();

  useAgentContext({
    description:
      "Current XTNA panel snapshot (wire contract v1.0.0). Answer questions about counts, topology nodes, waterfall requests, evidence and hypotheses from this state only.",
    value: (snapshot ?? {}) as unknown as JsonSerializable,
  });

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      fetchState()
        .then((next) => {
          if (!cancelled) {
            setSnapshot(next);
            setError("");
          }
        })
        .catch((cause: unknown) => {
          if (!cancelled) setError(String(cause));
        });
    };
    load();
    const events = new EventSource("/events");
    events.addEventListener("refresh", load);
    const timer = setInterval(load, 10_000);
    return () => {
      cancelled = true;
      events.close();
      clearInterval(timer);
    };
  }, []);

  const toolbar = (
    <div className="toolbar">
      <button
        type="button"
        className="ghost"
        onClick={() => setLanguage(language === "zh" ? "en" : "zh")}
        title={t("language")}
      >
        {language === "zh" ? "EN" : "中文"}
      </button>
      <button
        type="button"
        className="ghost"
        onClick={() => setSettingsOpen(true)}
        title={t("settings")}
      >
        {t("settings")}
      </button>
    </div>
  );

  const shell = (body: React.ReactNode) => (
    <div className="shell">
      <header>
        <div className="titleBlock">
          <h1>{snapshot?.title || t("appTitle")}</h1>
          {snapshot !== null && (
            <p className="muted">
              {t("generated")} {snapshot.generatedAt} ·{" "}
              {snapshot.sources.evidence}
            </p>
          )}
        </div>
        {toolbar}
      </header>
      {body}
      <SettingsDialog
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
      />
    </div>
  );

  if (error.length > 0)
    return shell(
      <p className="error">
        {t("stateError")}: {error}
      </p>,
    );
  if (snapshot === null) return shell(<p className="muted">{t("loading")}</p>);

  const { counts } = snapshot;
  return shell(
    <>
      <div className="counts">
        {countKeys.map(([labelKey, countKey]) => (
          <div className="count" key={labelKey}>
            <strong>{counts[countKey]}</strong>
            <span>{t(labelKey)}</span>
          </div>
        ))}
      </div>

      <main className="grid">
        <section className="panel wide">
          <div className="panelHead">
            <h2>{t("topology")}</h2>
            <span className="muted">
              nodes {snapshot.graph.nodes.length} · edges{" "}
              {snapshot.graph.edges.length}
            </span>
          </div>
          <Topology graph={snapshot.graph} />
        </section>
        <section className="panel wide">
          <div className="panelHead">
            <h2>{t("waterfall")}</h2>
          </div>
          <Waterfall waterfall={snapshot.waterfall} />
        </section>
        <QueryConsole />
        <StateTables snapshot={snapshot} />
      </main>
    </>,
  );
}

export const copilotRuntimeUrl =
  import.meta.env.VITE_COPILOT_RUNTIME_URL ??
  "http://127.0.0.1:8200/api/copilotkit";
