import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { PanelGraph, PanelNode } from "../panel";
import { useI18n } from "../i18n";

const COL_W = 230;
const ROW_H = 76;
const PAD_X = 118;
const PAD_Y = 84;
const NODE_R = 6;
const HALO_R = 18;
const MIN_ZOOM = 0.005;
const FIT_MIN_ZOOM = MIN_ZOOM;
const MAX_ZOOM = 2.5;

interface PositionedNode extends PanelNode {
  x: number;
  y: number;
}

interface Point {
  x: number;
  y: number;
}

const clamp = (value: number, low: number, high: number): number =>
  Math.min(high, Math.max(low, value));

const edgeSource = (edge: PanelGraph["edges"][number]): string =>
  edge.source ?? edge.from ?? edge.source_address ?? "";

const edgeTarget = (edge: PanelGraph["edges"][number]): string =>
  edge.target ?? edge.to ?? edge.target_address ?? "";

export function TopologyCanvas({
  graph,
  selectedId,
  onSelect,
}: {
  graph: PanelGraph;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const { t } = useI18n();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState<Point>({ x: 0, y: 0 });
  const zoomRef = useRef(zoom);
  const panRef = useRef(pan);
  const fittedKey = useRef("");
  const drag = useRef<{
    startX: number;
    startY: number;
    panX: number;
    panY: number;
    moved: boolean;
  } | null>(null);
  const suppressClick = useRef(false);

  useEffect(() => {
    zoomRef.current = zoom;
  }, [zoom]);
  useEffect(() => {
    panRef.current = pan;
  }, [pan]);

  const layout = useMemo(() => {
    const columns = new Map<number, PanelNode[]>();
    for (const node of graph.nodes) {
      const depth = node.depth ?? 0;
      columns.set(depth, [...(columns.get(depth) ?? []), node]);
    }
    const positioned: PositionedNode[] = [];
    const columnX = new Map<number, number>();
    for (const [depth, nodes] of [...columns.entries()].sort(
      (a, b) => a[0] - b[0],
    )) {
      columnX.set(depth, PAD_X + depth * COL_W);
      nodes.forEach((node, index) => {
        positioned.push({
          ...node,
          x: PAD_X + depth * COL_W,
          y: PAD_Y + index * ROW_H,
        });
      });
    }
    const minX = Math.min(...positioned.map((node) => node.x), PAD_X) - HALO_R;
    const maxX =
      Math.max(...positioned.map((node) => node.x), PAD_X) + 190 + HALO_R;
    const minY = Math.min(...positioned.map((node) => node.y), PAD_Y) - 48;
    const maxY =
      Math.max(...positioned.map((node) => node.y), PAD_Y) + HALO_R + 16;
    const positions = new Map(positioned.map((node) => [node.id, node]));
    return {
      positioned,
      positions,
      columns: [...columnX.entries()],
      bounds: {
        minX,
        maxX,
        minY,
        maxY,
        width: Math.max(1, maxX - minX),
        height: Math.max(1, maxY - minY),
      },
    };
  }, [graph.nodes]);

  useEffect(() => {
    const host = containerRef.current;
    if (host === null) return;
    const observer = new ResizeObserver((entries) => {
      const first = entries[0];
      if (first === undefined) return;
      setViewport({
        width: first.contentRect.width,
        height: first.contentRect.height,
      });
    });
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  const fit = useCallback(() => {
    const host = containerRef.current;
    if (host === null) return;
    const { width, height } = host.getBoundingClientRect();
    if (width <= 0 || height <= 0) return;
    const { bounds } = layout;
    const next = clamp(
      Math.min((width - 56) / bounds.width, (height - 56) / bounds.height, 1.8),
      FIT_MIN_ZOOM,
      MAX_ZOOM,
    );
    setZoom(next);
    setPan({
      x: (width - bounds.width * next) / 2 - bounds.minX * next,
      y: (height - bounds.height * next) / 2 - bounds.minY * next,
    });
  }, [layout]);

  useEffect(() => {
    if (viewport.width <= 0 || viewport.height <= 0) return;
    const key = `${graph.nodes.length}:${graph.edges.length}:${graph.nodes[0]?.id ?? ""}`;
    if (fittedKey.current === key) return;
    fittedKey.current = key;
    fit();
  }, [fit, graph.nodes, graph.edges.length, viewport.width, viewport.height]);

  useEffect(() => {
    const host = containerRef.current;
    if (host === null) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = host.getBoundingClientRect();
      const px = event.clientX - rect.left;
      const py = event.clientY - rect.top;
      const previous = zoomRef.current;
      const factor = event.deltaY < 0 ? 1.12 : 0.89;
      const next = clamp(previous * factor, MIN_ZOOM, MAX_ZOOM);
      const ratio = next / previous;
      const current = panRef.current;
      setZoom(next);
      setPan({
        x: px - (px - current.x) * ratio,
        y: py - (py - current.y) * ratio,
      });
    };
    host.addEventListener("wheel", onWheel, { passive: false });
    return () => host.removeEventListener("wheel", onWheel);
  }, []);

  const zoomBy = (factor: number) => {
    const host = containerRef.current;
    if (host === null) return;
    const rect = host.getBoundingClientRect();
    const px = rect.width / 2;
    const py = rect.height / 2;
    const current = zoomRef.current;
    const next = clamp(current * factor, MIN_ZOOM, MAX_ZOOM);
    const ratio = next / current;
    setZoom(next);
    setPan({
      x: px - (px - panRef.current.x) * ratio,
      y: py - (py - panRef.current.y) * ratio,
    });
  };

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const target = event.target as Element;
    if (
      target.closest(
        "[data-node-id], .topoControls, button, [role='button']",
      ) !== null
    )
      return;
    drag.current = {
      startX: event.clientX,
      startY: event.clientY,
      panX: panRef.current.x,
      panY: panRef.current.y,
      moved: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const state = drag.current;
    if (state === null) return;
    const dx = event.clientX - state.startX;
    const dy = event.clientY - state.startY;
    if (Math.abs(dx) + Math.abs(dy) > 3) state.moved = true;
    if (!state.moved) return;
    setPan({ x: state.panX + dx, y: state.panY + dy });
  };

  const onPointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    const state = drag.current;
    drag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
    if (state !== null && state.moved) {
      suppressClick.current = true;
      window.setTimeout(() => {
        suppressClick.current = false;
      }, 0);
    }
  };

  const select = (id: string) => {
    if (suppressClick.current) return;
    onSelect(id);
  };

  if (graph.nodes.length === 0) {
    return (
      <div className="topoStage topoEmpty">
        <div className="topoEmptyInner">
          <span className="eyebrow">NO SIGNAL</span>
          <p>{t("noGraph")}</p>
        </div>
      </div>
    );
  }

  const detailed = zoom >= 0.55;
  const selected =
    selectedId === null ? undefined : layout.positions.get(selectedId);

  return (
    <div
      className="topoStage"
      ref={containerRef}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      data-testid="topology-stage"
    >
      <div className="topoGrid" aria-hidden="true" />
      <div className="topoControls" role="group" aria-label="Topology viewport">
        <button
          type="button"
          className="iconButton"
          onClick={() => zoomBy(1.2)}
          aria-label={t("zoomIn")}
          title={t("zoomIn")}
        >
          +
        </button>
        <button
          type="button"
          className="iconButton"
          onClick={() => zoomBy(0.8)}
          aria-label={t("zoomOut")}
          title={t("zoomOut")}
        >
          −
        </button>
        <button
          type="button"
          className="iconButton wide"
          onClick={fit}
          title={t("fit")}
        >
          {t("fit")}
        </button>
      </div>

      <div className="topoMeta">
        <span className="eyebrow">{t("topology")}</span>
        <span className="mono dim">
          {graph.nodes.length} {t("nodes")} · {graph.edges.length} {t("edges")}
        </span>
        {!detailed && <span className="lodBadge">{t("levelOfDetail")}</span>}
        {graph.truncated && (
          <span className="warnBadge">{t("truncatedNodes")}</span>
        )}
      </div>

      <svg
        className="topoSvg"
        width="100%"
        height="100%"
        role="group"
        aria-label={t("topology")}
      >
        <defs>
          <radialGradient id="nodeHalo" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="rgba(16,185,129,0.42)" />
            <stop offset="60%" stopColor="rgba(16,185,129,0.10)" />
            <stop offset="100%" stopColor="rgba(16,185,129,0)" />
          </radialGradient>
          <filter id="nodeGlow" x="-80%" y="-80%" width="260%" height="260%">
            <feGaussianBlur stdDeviation="5" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>
        <g transform={`translate(${pan.x} ${pan.y}) scale(${zoom})`}>
          {layout.columns.map(([depth, x]) => (
            <g key={`depth-${depth}`}>
              <text className="depthLabel" x={x} y={PAD_Y - 44}>
                DEPTH {depth}
              </text>
            </g>
          ))}
          {graph.edges.map((edge, index) => {
            const from = layout.positions.get(edgeSource(edge));
            const to = layout.positions.get(edgeTarget(edge));
            if (from === undefined || to === undefined) return null;
            const active =
              selectedId !== null &&
              (edgeSource(edge) === selectedId ||
                edgeTarget(edge) === selectedId);
            const path = `M ${from.x} ${from.y} C ${from.x + 80} ${from.y}, ${to.x - 80} ${to.y}, ${to.x} ${to.y}`;
            return (
              <path
                key={index}
                d={path}
                className={active ? "topoEdge active" : "topoEdge"}
              />
            );
          })}
          {layout.positioned.map((node) => {
            const active = node.id === selectedId;
            return (
              <g
                key={node.id}
                className={active ? "topoNode active" : "topoNode"}
                role="button"
                tabIndex={0}
                aria-pressed={active}
                aria-label={node.label ?? node.address ?? node.id}
                data-node-id={node.id}
                onClick={() => select(node.id)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    select(node.id);
                  }
                }}
              >
                <circle
                  cx={node.x}
                  cy={node.y}
                  r={HALO_R}
                  fill="url(#nodeHalo)"
                  className="topoHalo"
                />
                <circle
                  cx={node.x}
                  cy={node.y}
                  r={NODE_R}
                  className="topoCore"
                  filter="url(#nodeGlow)"
                />
                {active && (
                  <circle
                    cx={node.x}
                    cy={node.y}
                    r={HALO_R + 6}
                    className="topoRing"
                  />
                )}
                {detailed && (
                  <text className="topoLabel" x={node.x + 16} y={node.y + 4}>
                    {node.label ?? node.address ?? node.id}
                  </text>
                )}
              </g>
            );
          })}
        </g>
      </svg>

      <div className="topoFooter">
        {selected === undefined ? (
          <span className="dim mono">click a node to inspect</span>
        ) : (
          <span className="mono">
            <span className="emerald">●</span> {selected.label ?? selected.id}
            {selected.address !== undefined && (
              <span className="dim"> · {selected.address}</span>
            )}
          </span>
        )}
      </div>
    </div>
  );
}
