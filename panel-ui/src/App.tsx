import { useEffect, useState } from "react";

import { fetchState, type PanelSnapshot } from "./panel";
import { QueryConsole } from "./components/QueryConsole";
import { StateTables } from "./components/StateTables";
import { Topology, Waterfall } from "./components/Topology";

const runtimeUrl =
  import.meta.env.VITE_COPILOT_RUNTIME_URL ??
  "http://127.0.0.1:8200/api/copilotkit";

export function Dashboard() {
  const [snapshot, setSnapshot] = useState<PanelSnapshot | null>(null);
  const [error, setError] = useState("");

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

  if (error.length > 0)
    return (
      <div className="shell">
        <header>
          <h1>XTNA panel</h1>
        </header>
        <p className="error">
          Cannot read the panel state: {error}. Start{" "}
          <code>npm run panel:serve -- --evidence &lt;bundle.json&gt;</code>.
        </p>
      </div>
    );
  if (snapshot === null)
    return (
      <div className="shell">
        <header>
          <h1>XTNA panel</h1>
        </header>
        <p className="muted">Loading the investigation…</p>
      </div>
    );

  const { counts } = snapshot;
  return (
    <div className="shell">
      <header>
        <div>
          <h1>{snapshot.title}</h1>
          <p className="muted">
            generated {snapshot.generatedAt} · {snapshot.sources.evidence}
          </p>
        </div>
        <div className="counts">
          {(
            [
              ["records", counts.records],
              ["artifacts", counts.artifacts],
              ["unknowns", counts.unknowns],
              ["limitations", counts.limitations],
              ["symbols", counts.symbols],
              ["hypotheses", counts.hypotheses],
              ["checkpoints", counts.checkpoints],
            ] as const
          ).map(([label, value]) => (
            <div className="count" key={label}>
              <strong>{value}</strong>
              <span>{label}</span>
            </div>
          ))}
        </div>
      </header>

      <main className="grid">
        <section className="panel wide">
          <h2>Topology</h2>
          <p className="muted">
            nodes {snapshot.graph.nodes.length} · edges{" "}
            {snapshot.graph.edges.length}
          </p>
          <Topology graph={snapshot.graph} />
        </section>
        <section className="panel wide">
          <h2>Network waterfall</h2>
          <Waterfall waterfall={snapshot.waterfall} />
        </section>
        <QueryConsole />
        <StateTables snapshot={snapshot} />
      </main>
    </div>
  );
}

export const copilotRuntimeUrl = runtimeUrl;
