import type { PanelSnapshot } from "../panel";
import { useI18n } from "../i18n";

type Row = Record<string, unknown>;

function DataTable({
  rows,
  columns,
  mono,
}: {
  rows: Row[];
  columns: { key: string; label: string; mono?: boolean }[];
  mono?: string[];
}) {
  if (rows.length === 0) return <p className="dim">—</p>;
  return (
    <div className="tableWrap">
      <table>
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column.key}>{column.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={index}>
              {columns.map((column) => (
                <td
                  key={column.key}
                  className={
                    mono?.includes(column.key) === true ? "mono" : undefined
                  }
                >
                  {String(row[column.key] ?? "—")}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function InspectorTables({ snapshot }: { snapshot: PanelSnapshot }) {
  const { t } = useI18n();
  return (
    <section className="inspectorStrip" aria-label="Inspector tables">
      <div className="stripSection">
        <div className="panelHead">
          <h2>{t("symbols")}</h2>
          <span className="countBadge">{snapshot.symbols.length}</span>
        </div>
        <DataTable
          rows={snapshot.symbols}
          columns={[
            { key: "address", label: t("address") },
            { key: "name", label: "name" },
            { key: "kind", label: "kind" },
            { key: "confidence", label: "confidence" },
          ]}
          mono={["address", "name"]}
        />
      </div>

      <div className="stripSection">
        <div className="panelHead">
          <h2>{t("hypotheses")}</h2>
          <span className="countBadge">{snapshot.hypotheses.length}</span>
        </div>
        <DataTable
          rows={snapshot.hypotheses}
          columns={[
            { key: "id", label: "id" },
            { key: "claim", label: "claim" },
            { key: "status", label: "status" },
            { key: "confidence", label: "confidence" },
          ]}
          mono={["id"]}
        />
      </div>

      <div className="stripSection">
        <div className="panelHead">
          <h2>{t("checkpoints")}</h2>
          <span className="countBadge">{snapshot.checkpoints.length}</span>
        </div>
        <DataTable
          rows={snapshot.checkpoints}
          columns={[
            { key: "name", label: "name" },
            { key: "bytes", label: "bytes" },
            { key: "modifiedAt", label: t("checkpointAt") },
          ]}
          mono={["name", "bytes", "modifiedAt"]}
        />
      </div>
    </section>
  );
}
