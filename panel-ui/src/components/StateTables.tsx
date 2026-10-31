import type { PanelSnapshot } from "../panel";

const Table = ({
  rows,
  columns,
}: {
  rows: Record<string, unknown>[];
  columns: string[];
}) => (
  <table>
    <thead>
      <tr>
        {columns.map((column) => (
          <th key={column}>{column}</th>
        ))}
      </tr>
    </thead>
    <tbody>
      {rows.map((row, index) => (
        <tr key={index}>
          {columns.map((column) => (
            <td key={column}>{String(row[column] ?? "")}</td>
          ))}
        </tr>
      ))}
    </tbody>
  </table>
);

export function StateTables({ snapshot }: { snapshot: PanelSnapshot }) {
  return (
    <>
      <section className="panel">
        <h2>Evidence cards</h2>
        <p className="muted">
          records {snapshot.records?.length ?? 0}
          {snapshot.recordsTruncated === true ? " (truncated at 200)" : ""}
        </p>
        <div className="cards">
          {(snapshot.records ?? []).map((record) => (
            <article className="card" key={record.id}>
              <h3>{record.operation}</h3>
              <p className="muted">
                {record.provider} · authority {record.authority} · confidence{" "}
                {record.confidence} · limitations {record.limitations}
              </p>
              <p className="id">{record.id}</p>
            </article>
          ))}
        </div>
      </section>
      <section className="panel">
        <h2>Limitations</h2>
        <Table rows={snapshot.limitations} columns={["operation", "text"]} />
      </section>
      <section className="panel">
        <h2>Symbols</h2>
        <Table
          rows={snapshot.symbols}
          columns={["address", "name", "kind", "confidence"]}
        />
      </section>
      <section className="panel">
        <h2>Hypotheses</h2>
        <Table
          rows={snapshot.hypotheses}
          columns={["id", "claim", "status", "confidence"]}
        />
      </section>
      <section className="panel">
        <h2>Checkpoints</h2>
        <Table
          rows={snapshot.checkpoints}
          columns={["name", "bytes", "modifiedAt"]}
        />
      </section>
    </>
  );
}
