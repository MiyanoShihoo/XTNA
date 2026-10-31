import type { PanelGraph, PanelWaterfall } from "../panel";
import { useI18n } from "../i18n";

export function Topology({ graph }: { graph: PanelGraph }) {
  const { t } = useI18n();
  if (graph.nodes.length === 0) return <p className="empty">{t("noGraph")}</p>;
  const columns = new Map<number, typeof graph.nodes>();
  for (const node of graph.nodes) {
    const depth = node.depth ?? 0;
    columns.set(depth, [...(columns.get(depth) ?? []), node]);
  }
  const positions = new Map<string, { x: number; y: number }>();
  for (const [depth, nodes] of [...columns.entries()].sort(
    (a, b) => a[0] - b[0],
  ))
    nodes.forEach((node, index) =>
      positions.set(node.id, { x: 80 + depth * 190, y: 50 + index * 62 }),
    );
  const width = 160 + Math.max(...columns.keys(), 0) * 190;
  const height =
    60 +
    Math.max(...[...columns.values()].map((nodes) => nodes.length), 1) * 62;
  return (
    <div className="graph">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label="Call topology"
      >
        {graph.edges.map((edge, index) => {
          const from = positions.get(
            edge.source ?? edge.from ?? edge.source_address ?? "",
          );
          const to = positions.get(
            edge.target ?? edge.to ?? edge.target_address ?? "",
          );
          if (from === undefined || to === undefined) return null;
          return (
            <line
              key={index}
              x1={from.x}
              y1={from.y}
              x2={to.x}
              y2={to.y}
              className="edge"
            />
          );
        })}
        {graph.nodes.map((node) => {
          const position = positions.get(node.id);
          if (position === undefined) return null;
          return (
            <g key={node.id}>
              <circle cx={position.x} cy={position.y} r={9} className="node" />
              <text x={position.x + 15} y={position.y + 4} className="label">
                {node.label ?? node.address ?? node.id}
              </text>
            </g>
          );
        })}
      </svg>
      {graph.truncated && (
        <p className="muted">truncated at 400 nodes / 1,200 edges</p>
      )}
    </div>
  );
}

export function Waterfall({ waterfall }: { waterfall: PanelWaterfall }) {
  const { t } = useI18n();
  if (waterfall.entries.length === 0)
    return <p className="empty">{t("noWaterfall")}</p>;
  const starts = waterfall.entries
    .map((entry) =>
      entry.startedAt === null ? null : Date.parse(entry.startedAt),
    )
    .filter(
      (value): value is number => value !== null && Number.isFinite(value),
    );
  const origin = starts.length > 0 ? Math.min(...starts) : 0;
  const spans = waterfall.entries.map((entry) => {
    const parsed =
      entry.startedAt === null ? Number.NaN : Date.parse(entry.startedAt);
    return {
      entry,
      offset: Number.isFinite(parsed) ? Math.max(0, parsed - origin) : 0,
      duration: entry.elapsedMs === null ? 10 : Math.max(1, entry.elapsedMs),
    };
  });
  const total = Math.max(
    ...spans.map((span) => span.offset + span.duration),
    1,
  );
  return (
    <div className="waterfall">
      {spans.map((span, index) => {
        const failed = span.entry.status !== null && span.entry.status >= 400;
        return (
          <div className="wf-row" key={index}>
            <span className="wf-name">
              {span.entry.method} {span.entry.url}
            </span>
            <span className="wf-track">
              <span
                className={failed ? "wf-bar error" : "wf-bar"}
                style={{
                  left: `${(span.offset / total) * 100}%`,
                  width: `${Math.max(0.5, (span.duration / total) * 100)}%`,
                }}
              />
            </span>
            <span className="muted">{span.entry.status ?? "-"}</span>
          </div>
        );
      })}
      {!waterfall.timed && (
        <p className="muted">no timings recorded, order only</p>
      )}
      {waterfall.truncated && (
        <p className="muted">truncated at 200 transactions</p>
      )}
    </div>
  );
}
