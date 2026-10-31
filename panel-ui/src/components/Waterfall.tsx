import type { PanelWaterfall } from "../panel";
import { useI18n } from "../i18n";

export function Waterfall({ waterfall }: { waterfall: PanelWaterfall }) {
  const { t } = useI18n();
  if (waterfall.entries.length === 0)
    return <p className="emptyState">{t("noWaterfall")}</p>;
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
      duration: entry.elapsedMs === null ? 8 : Math.max(2, entry.elapsedMs),
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
          <div className="wfRow" key={index}>
            <div className="wfLine">
              <span className="wfMethod mono">{span.entry.method}</span>
              <span className="wfUrl mono">{span.entry.url}</span>
              <span
                className={
                  failed ? "wfStatus mono warn" : "wfStatus mono emerald"
                }
              >
                {span.entry.status ?? "—"}
              </span>
              <span className="wfTime mono dim">
                {span.entry.elapsedMs === null
                  ? "—"
                  : `${String(span.entry.elapsedMs)}ms`}
              </span>
            </div>
            <div className="wfTrack">
              <span
                className={failed ? "wfBar error" : "wfBar"}
                style={{
                  left: `${(span.offset / total) * 100}%`,
                  width: `${Math.max(0.5, (span.duration / total) * 100)}%`,
                }}
              />
            </div>
          </div>
        );
      })}
      {!waterfall.timed && <p className="dim small">{t("noTimings")}</p>}
      {waterfall.truncated && (
        <p className="warnText small">{t("truncatedTransactions")}</p>
      )}
    </div>
  );
}
