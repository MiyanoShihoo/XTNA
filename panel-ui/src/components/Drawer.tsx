import { useEffect, useMemo, useRef, useState } from "react";

import type {
  PanelGraph,
  PanelLimitation,
  PanelNode,
  PanelRecord,
} from "../panel";
import { useI18n } from "../i18n";
import { AnnotationsPanel } from "./AnnotationsPanel";

export type DrawerTab = "node" | "evidence" | "limitations" | "notes";

const tabs: DrawerTab[] = ["node", "evidence", "limitations", "notes"];

const edgeSource = (edge: PanelGraph["edges"][number]): string =>
  edge.source ?? edge.from ?? edge.source_address ?? "";

const edgeTarget = (edge: PanelGraph["edges"][number]): string =>
  edge.target ?? edge.to ?? edge.target_address ?? "";

const focusable = (host: HTMLElement): HTMLElement[] =>
  Array.from(
    host.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
    ),
  ).filter((item) => item.offsetParent !== null);

export function Drawer({
  open,
  node,
  graph,
  records,
  recordsTruncated,
  limitations,
  tab,
  origin,
  refreshTick,
  onTab,
  onClose,
}: {
  open: boolean;
  node: PanelNode | null;
  graph: PanelGraph;
  records: PanelRecord[];
  recordsTruncated: boolean;
  limitations: PanelLimitation[];
  tab: DrawerTab;
  origin: "node" | "notes";
  refreshTick: number;
  onTab: (tab: DrawerTab) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const hostRef = useRef<HTMLElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const nodeRef = useRef(node);
  const originRef = useRef(origin);
  const [search, setSearch] = useState("");

  useEffect(() => {
    originRef.current = origin;
  }, [origin]);

  useEffect(() => {
    nodeRef.current = node;
  }, [node]);

  const nodeDetail = useMemo(() => {
    if (node === null) return null;
    const inbound = graph.edges.filter((edge) => edgeTarget(edge) === node.id);
    const outbound = graph.edges.filter((edge) => edgeSource(edge) === node.id);
    const neighborIds = new Set<string>();
    for (const edge of [...inbound, ...outbound]) {
      neighborIds.add(edgeSource(edge));
      neighborIds.add(edgeTarget(edge));
    }
    neighborIds.delete(node.id);
    const labels = [...neighborIds].map((id) => {
      const found = graph.nodes.find((candidate) => candidate.id === id);
      return found?.label ?? found?.address ?? id;
    });
    return { inbound: inbound.length, outbound: outbound.length, labels };
  }, [graph, node]);

  const filteredRecords = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (needle.length === 0) return records;
    return records.filter((record) =>
      [record.operation, record.provider, record.id]
        .join(" ")
        .toLowerCase()
        .includes(needle),
    );
  }, [records, search]);

  useEffect(() => {
    if (!open) return;
    const previous =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const root = document.getElementById("workbench-root");
    root?.setAttribute("inert", "");
    const overflow = document.documentElement.style.overflow;
    document.documentElement.style.overflow = "hidden";
    const timer = window.setTimeout(() => closeRef.current?.focus(), 0);

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const host = hostRef.current;
      if (host === null) return;
      const items = focusable(host);
      if (items.length === 0) return;
      const first = items[0]!;
      const last = items[items.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("keydown", onKeyDown);
      root?.removeAttribute("inert");
      document.documentElement.style.overflow = overflow;
      const selectedId = nodeRef.current?.id;
      const selected =
        selectedId === undefined
          ? null
          : document.querySelector<HTMLElement>(
              `[data-node-id="${CSS.escape(selectedId)}"]`,
            );
      const trigger = document.querySelector<HTMLElement>(
        "[data-drawer-trigger]",
      );
      const target =
        originRef.current === "node" &&
        selected !== null &&
        selected.isConnected
          ? selected
          : previous !== null && previous.isConnected
            ? previous
            : trigger;
      if (target !== null) target.focus();
    };
  }, [open, onClose]);

  useEffect(() => {
    setSearch("");
  }, [open, tab]);

  if (!open) return null;

  return (
    <div className="drawerLayer">
      <button
        type="button"
        className="drawerBackdrop"
        aria-label={t("closeDrawer")}
        onClick={onClose}
      />
      <aside
        className="drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="drawer-title"
        ref={hostRef}
        data-testid="drawer"
      >
        <header className="drawerHead">
          <div>
            <span className="eyebrow">{t("drawer")}</span>
            <h2 id="drawer-title">
              {node?.label ?? node?.address ?? node?.id ?? t("openNotes")}
            </h2>
          </div>
          <button
            type="button"
            className="iconButton"
            onClick={onClose}
            aria-label={t("closeDrawer")}
            ref={closeRef}
          >
            ×
          </button>
        </header>

        <div className="tabs" role="tablist" aria-label={t("drawer")}>
          {tabs.map((entry) => (
            <button
              key={entry}
              type="button"
              role="tab"
              aria-selected={tab === entry}
              className={tab === entry ? "tab active" : "tab"}
              onClick={() => onTab(entry)}
            >
              {entry === "node"
                ? t("tabNode")
                : entry === "evidence"
                  ? t("tabEvidence")
                  : entry === "limitations"
                    ? t("tabLimitations")
                    : t("tabNotes")}
            </button>
          ))}
        </div>

        <div className="drawerBody" role="tabpanel">
          {tab === "node" &&
            (node === null || nodeDetail === null ? (
              <p className="dim">{t("noSelection")}</p>
            ) : (
              <div className="nodeDetail">
                <dl>
                  <div>
                    <dt>{t("node")}</dt>
                    <dd className="mono">{node.id}</dd>
                  </div>
                  {node.address !== undefined && (
                    <div>
                      <dt>{t("address")}</dt>
                      <dd className="mono">{node.address}</dd>
                    </div>
                  )}
                  <div>
                    <dt>{t("depth")}</dt>
                    <dd className="mono">{node.depth ?? 0}</dd>
                  </div>
                  <div>
                    <dt>{t("inbound")}</dt>
                    <dd className="mono bright">{nodeDetail.inbound}</dd>
                  </div>
                  <div>
                    <dt>{t("outbound")}</dt>
                    <dd className="mono bright">{nodeDetail.outbound}</dd>
                  </div>
                </dl>
                <div>
                  <span className="eyebrow">{t("neighbors")}</span>
                  <p className="mono dim">
                    {nodeDetail.labels.length === 0
                      ? t("none")
                      : nodeDetail.labels.join(" · ")}
                  </p>
                </div>
                <p className="scopeNote">{t("evidenceScope")}</p>
              </div>
            ))}

          {tab === "evidence" && (
            <div>
              <div className="panelHead">
                <span className="eyebrow">{t("allRecords")}</span>
                <span className="dim mono">
                  {filteredRecords.length}/{records.length}
                  {recordsTruncated ? " · 200" : ""}
                </span>
              </div>
              <input
                className="search"
                placeholder={t("searchEvidence")}
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
              {filteredRecords.length === 0 ? (
                <p className="dim">{t("noEvidence")}</p>
              ) : (
                <ul className="evidenceList">
                  {filteredRecords.map((record) => (
                    <li key={record.id}>
                      <div className="evidenceTop">
                        <strong>{record.operation}</strong>
                        <span className="chip">{record.provider}</span>
                      </div>
                      <div className="evidenceMeta">
                        <span>{record.authority}</span>
                        <span>{record.confidence}</span>
                        <span>{record.limitations} lim</span>
                      </div>
                      <code>{record.id}</code>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {tab === "limitations" && (
            <div>
              <span className="eyebrow">{t("allLimitations")}</span>
              {limitations.length === 0 ? (
                <p className="dim">{t("noLimitations")}</p>
              ) : (
                <ul className="limitationList">
                  {limitations.map((limitation, index) => (
                    <li key={`${limitation.operation}:${index}`}>
                      <span className="mono emerald">
                        {limitation.operation}
                      </span>
                      <p>{limitation.text}</p>
                    </li>
                  ))}
                </ul>
              )}
              <p className="scopeNote">{t("limitationScope")}</p>
            </div>
          )}

          {tab === "notes" && (
            <AnnotationsPanel
              target={node?.address ?? node?.id ?? node?.label ?? ""}
              refreshTick={refreshTick}
            />
          )}
        </div>
      </aside>
    </div>
  );
}
