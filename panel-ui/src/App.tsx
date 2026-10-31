import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAgentContext } from "@copilotkit/react-core/v2";
import type { JsonSerializable } from "@copilotkit/react-core/v2";

import { Drawer, type DrawerTab } from "./components/Drawer";
import { InspectorTables } from "./components/InspectorTables";
import { QueryConsole } from "./components/QueryConsole";
import { SettingsDialog } from "./components/SettingsDialog";
import { TopologyCanvas } from "./components/TopologyCanvas";
import { Waterfall } from "./components/Waterfall";
import { fetchState, type PanelSnapshot } from "./panel";
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

type Connection = "connecting" | "live" | "offline";

const basename = (path: string): string => {
  const parts = path.split(/[\\/]/u);
  return parts[parts.length - 1] ?? path;
};

export function Dashboard() {
  const { t, language, setLanguage } = useI18n();
  const [snapshot, setSnapshot] = useState<PanelSnapshot | null>(null);
  const [error, setError] = useState("");
  const [connection, setConnection] = useState<Connection>("connecting");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerTab, setDrawerTab] = useState<DrawerTab>("node");
  const [drawerOrigin, setDrawerOrigin] = useState<"node" | "notes">("node");
  const [refreshTick, setRefreshTick] = useState(0);
  const [notice, setNotice] = useState("");
  const requestSequence = useRef(0);
  const inFlight = useRef<Promise<void> | null>(null);
  const queued = useRef(false);
  const loadRef = useRef<(() => Promise<void>) | null>(null);

  usePanelTools();

  useAgentContext({
    description:
      "Current XTNA panel snapshot (wire contract v1.0.0). Answer questions about counts, topology nodes, waterfall requests, evidence and hypotheses from this state only.",
    value: (snapshot ?? {}) as unknown as JsonSerializable,
  });

  const load = useCallback(() => {
    if (inFlight.current !== null) {
      queued.current = true;
      return inFlight.current;
    }
    const run = (async () => {
      const id = ++requestSequence.current;
      try {
        const next = await fetchState();
        if (id !== requestSequence.current) return;
        setSnapshot(next);
        setError("");
      } catch (cause: unknown) {
        if (id !== requestSequence.current) return;
        setError(String(cause));
      } finally {
        inFlight.current = null;
        if (queued.current) {
          queued.current = false;
          void loadRef.current?.();
        }
      }
    })();
    inFlight.current = run;
    return run;
  }, []);

  useEffect(() => {
    loadRef.current = load;
  }, [load]);

  useEffect(() => {
    void load();
    const events = new EventSource("/events");
    events.onopen = () => setConnection("live");
    events.onerror = () => setConnection("offline");
    events.addEventListener("refresh", () => {
      setRefreshTick((value) => value + 1);
      void load();
    });
    const timer = setInterval(() => {
      setRefreshTick((value) => value + 1);
      void load();
    }, 10_000);
    return () => {
      events.close();
      clearInterval(timer);
      requestSequence.current += 1;
    };
  }, [load]);

  const selectedNode = useMemo(() => {
    if (snapshot === null || selectedId === null) return null;
    return snapshot.graph.nodes.find((node) => node.id === selectedId) ?? null;
  }, [snapshot, selectedId]);

  useEffect(() => {
    if (selectedId !== null && snapshot !== null && selectedNode === null) {
      setSelectedId(null);
      setDrawerOpen(false);
      setNotice(t("nodeGone"));
    }
  }, [selectedId, selectedNode, snapshot, t]);

  useEffect(() => {
    if (notice.length === 0) return;
    const timer = window.setTimeout(() => setNotice(""), 6000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const openNode = (id: string) => {
    setNotice("");
    setSelectedId(id);
    setDrawerTab("node");
    setDrawerOrigin("node");
    setDrawerOpen(true);
  };

  const openNotes = () => {
    setDrawerOrigin("notes");
    setDrawerTab("notes");
    setDrawerOpen(true);
  };

  const closeDrawer = useCallback(() => setDrawerOpen(false), []);

  const connectionLabel =
    connection === "live"
      ? t("live")
      : connection === "offline"
        ? t("offline")
        : t("connecting");

  const header = (
    <header className="topbar">
      <div className="brand">
        <span className="brandMark" aria-hidden="true">
          ◈
        </span>
        <div className="brandText">
          <span className="eyebrow">XTNA // REA</span>
          <h1>{snapshot?.title || t("appTitle")}</h1>
        </div>
      </div>
      <div className="statusLine">
        <span className={`statusDot ${connection}`} aria-hidden="true" />
        <span className="mono small" aria-live="polite">
          {connectionLabel}
        </span>
        {snapshot !== null && (
          <>
            <span className="sep" aria-hidden="true">
              /
            </span>
            <span className="mono small dim" title={snapshot.sources.evidence}>
              {basename(snapshot.sources.evidence)}
            </span>
            <span className="sep" aria-hidden="true">
              /
            </span>
            <span className="mono small dim">
              {new Date(snapshot.generatedAt).toLocaleTimeString()}
            </span>
          </>
        )}
      </div>
      <div className="topActions">
        <button
          type="button"
          className="ghost"
          onClick={openNotes}
          data-drawer-trigger
        >
          {t("openNotes")}
        </button>
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
          aria-label={t("settings")}
        >
          ⚙
        </button>
      </div>
    </header>
  );

  if (snapshot === null && error.length > 0) {
    return (
      <>
        <div id="workbench-root" className="app appError">
          {header}
          <div className="fatalError">
            <span className="eyebrow">STATE ERROR</span>
            <h2>{t("stateError")}</h2>
            <p className="mono">{error}</p>
            <button type="button" onClick={() => void load()}>
              {t("retry")}
            </button>
          </div>
        </div>
        <SettingsDialog
          open={settingsOpen}
          onClose={() => setSettingsOpen(false)}
        />
      </>
    );
  }

  if (snapshot === null) {
    return (
      <>
        <div id="workbench-root" className="app">
          {header}
          <div className="loadingState">
            <span className="loadingBar" />
            <p className="mono dim">{t("loading")}</p>
          </div>
        </div>
        <SettingsDialog
          open={settingsOpen}
          onClose={() => setSettingsOpen(false)}
        />
      </>
    );
  }

  const { counts } = snapshot;
  return (
    <>
      <div id="workbench-root" className="app">
        {header}

        <div className="metrics" role="list" aria-label="Bundle counters">
          {countKeys.map(([labelKey, countKey]) => (
            <div className="metric" role="listitem" key={labelKey}>
              <span className="metricValue mono">{counts[countKey]}</span>
              <span className="metricLabel">{t(labelKey)}</span>
            </div>
          ))}
        </div>

        {error.length > 0 && (
          <div className="banner" role="status">
            <span className="warn">▲</span>
            <span>{t("stateStale")}</span>
            <button type="button" className="ghost" onClick={() => void load()}>
              {t("retry")}
            </button>
          </div>
        )}

        <div className="srOnly" aria-live="polite">
          {notice}
        </div>
        {notice.length > 0 && (
          <div className="banner notice" role="status">
            <span className="emerald">●</span>
            <span>{notice}</span>
          </div>
        )}

        <div className="workbench">
          <section className="topoSection" aria-label={t("topology")}>
            <TopologyCanvas
              graph={snapshot.graph}
              selectedId={selectedId}
              onSelect={openNode}
            />
          </section>

          <aside className="rail" aria-label="Live activity">
            <section className="railPanel">
              <div className="panelHead">
                <h2>{t("waterfall")}</h2>
                <span className="countBadge">
                  {snapshot.waterfall.entries.length}
                </span>
              </div>
              <Waterfall waterfall={snapshot.waterfall} />
            </section>

            <QueryConsole />

            <section className="railPanel activityPanel">
              <div className="panelHead">
                <h2>{t("activity")}</h2>
              </div>
              <dl className="activityList">
                <div>
                  <dt>{t("generated")}</dt>
                  <dd className="mono small">{snapshot.generatedAt}</dd>
                </div>
                <div>
                  <dt>{t("bundle")}</dt>
                  <dd className="mono small" title={snapshot.sources.evidence}>
                    {basename(snapshot.sources.evidence)}
                  </dd>
                </div>
                <div>
                  <dt>{t("unknownCount")}</dt>
                  <dd className="mono small bright">{counts.unknowns}</dd>
                </div>
                <div>
                  <dt>{t("recordsCap")}</dt>
                  <dd className="mono small dim">
                    {snapshot.records?.length ?? 0}
                  </dd>
                </div>
              </dl>
            </section>
          </aside>
        </div>

        <InspectorTables snapshot={snapshot} />
      </div>

      <Drawer
        open={drawerOpen}
        node={selectedNode}
        graph={snapshot.graph}
        records={snapshot.records ?? []}
        recordsTruncated={snapshot.recordsTruncated === true}
        limitations={snapshot.limitations}
        tab={drawerTab}
        origin={drawerOrigin}
        refreshTick={refreshTick}
        onTab={setDrawerTab}
        onClose={closeDrawer}
      />

      <SettingsDialog
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
      />
    </>
  );
}

export const copilotRuntimeUrl =
  import.meta.env.VITE_COPILOT_RUNTIME_URL ??
  "http://127.0.0.1:8200/api/copilotkit";
