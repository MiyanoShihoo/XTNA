/**
 * Projection of evidence records into the two visual views of the live panel:
 * a call topology graph and a network waterfall.
 *
 * Both views are read-only projections of what an investigation already
 * recorded. Recognition is deliberately narrow: a record contributes only when
 * its payload matches one of the documented shapes below, and everything else
 * stays out instead of being guessed at.
 *
 * Graph shapes:
 * - `nodes[]` with `address` plus optional `name`/`label`, and `edges[]` with
 *   `source_address`/`target_address` (call path traces) or `from`/`to`.
 *
 * Waterfall shapes:
 * - `transactions[]`/`network_transactions[]` entries carrying `url`, optional
 *   `method`, `status`, `started_at`/`observed_at` and `elapsed_ms`/`duration_ms`;
 * - browser scenario `events.items[]` where `request`/`response` events share a
 *   `transaction_id` (the request supplies url/method/time, the response status).
 */

export interface PanelGraphNode {
  readonly id: string;
  readonly label: string;
  readonly depth: number | null;
}

export interface PanelGraphEdge {
  readonly source: string;
  readonly target: string;
}

export interface PanelGraph {
  readonly nodes: readonly PanelGraphNode[];
  readonly edges: readonly PanelGraphEdge[];
  readonly truncated: boolean;
}

export interface PanelWaterfallEntry {
  readonly id: string;
  readonly method: string;
  readonly url: string;
  readonly status: number | null;
  readonly startedAt: string | null;
  readonly elapsedMs: number | null;
}

export interface PanelWaterfall {
  readonly entries: readonly PanelWaterfallEntry[];
  readonly timed: boolean;
  readonly truncated: boolean;
}

export const PANEL_LIMITS = {
  nodes: 400,
  edges: 1200,
  entries: 200,
} as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asArray = (value: unknown): unknown[] =>
  Array.isArray(value) ? value : [];

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

const numberOrNull = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

/** The payload a record contributes, if it carries an object result. */
const payloadOf = (record: unknown): Record<string, unknown> | undefined => {
  if (!isRecord(record)) return undefined;
  for (const key of ["normalized_result", "result", "payload"] as const) {
    if (isRecord(record[key])) return record[key];
  }
  return undefined;
};

const nodeIdOf = (node: Record<string, unknown>): string | undefined =>
  text(node.address) ?? text(node.id) ?? text(node.symbol);

const edgeOf = (
  edge: Record<string, unknown>,
): { source: string; target: string } | undefined => {
  const source =
    text(edge.source_address) ?? text(edge.from) ?? text(edge.source);
  const target =
    text(edge.target_address) ?? text(edge.to) ?? text(edge.target);
  return source === undefined || target === undefined
    ? undefined
    : { source, target };
};

/** Merge every recognized graph shape into one bounded node/edge set. */
export function projectGraph(records: readonly unknown[]): PanelGraph {
  const nodes = new Map<string, PanelGraphNode>();
  const edges = new Map<string, PanelGraphEdge>();
  let truncated = false;
  for (const record of records) {
    const payload = payloadOf(record);
    if (payload === undefined) continue;
    const rawNodes = asArray(payload.nodes);
    for (const raw of rawNodes) {
      if (!isRecord(raw)) continue;
      const id = nodeIdOf(raw);
      if (id === undefined) continue;
      if (!nodes.has(id)) {
        if (nodes.size >= PANEL_LIMITS.nodes) {
          truncated = true;
          continue;
        }
        const depth = numberOrNull(raw.depth);
        nodes.set(id, {
          id,
          label: text(raw.name) ?? text(raw.label) ?? id,
          depth: depth === null ? null : Math.trunc(depth),
        });
      }
    }
    for (const raw of asArray(payload.edges)) {
      if (!isRecord(raw)) continue;
      const edge = edgeOf(raw);
      if (edge === undefined) continue;
      if (edges.size >= PANEL_LIMITS.edges) {
        truncated = true;
        break;
      }
      const key = `${edge.source}\u0000${edge.target}`;
      if (!edges.has(key)) edges.set(key, edge);
    }
  }
  return { nodes: [...nodes.values()], edges: [...edges.values()], truncated };
}

interface PendingEntry {
  id: string;
  method: string;
  url: string;
  status: number | null;
  startedAt: string | null;
  elapsedMs: number | null;
}

const entryFromTransaction = (
  value: unknown,
  index: number,
): PendingEntry | undefined => {
  if (!isRecord(value)) return undefined;
  const url = text(value.url);
  if (url === undefined) return undefined;
  const id =
    text(value.id) ??
    text(value.transaction_id) ??
    text(value.request_id) ??
    `transaction-${String(index + 1)}`;
  return {
    id,
    method: (text(value.method) ?? "GET").toUpperCase(),
    url,
    status: numberOrNull(value.status),
    startedAt: text(value.started_at) ?? text(value.observed_at) ?? null,
    elapsedMs:
      numberOrNull(value.elapsed_ms) ?? numberOrNull(value.duration_ms),
  };
};

const collectionsOf = (payload: Record<string, unknown>): unknown[][] | [] => {
  const found: unknown[][] = [];
  for (const key of ["transactions", "network_transactions"] as const)
    if (Array.isArray(payload[key])) found.push(payload[key]);
  return found.length > 0 ? found : [];
};

/** Pair browser scenario request/response events by transaction id. */
const entriesFromEvents = (
  payload: Record<string, unknown>,
): PendingEntry[] | undefined => {
  const events = payload.events;
  if (!isRecord(events)) return undefined;
  const items = asArray(events.items);
  const pending = new Map<string, PendingEntry>();
  for (const raw of items) {
    if (!isRecord(raw)) continue;
    const transactionId = text(raw.transaction_id);
    if (transactionId === undefined) continue;
    if (raw.kind === "request") {
      const url = text(raw.url);
      if (url === undefined) continue;
      if (!pending.has(transactionId))
        pending.set(transactionId, {
          id: transactionId,
          method: (text(raw.method) ?? "GET").toUpperCase(),
          url,
          status: null,
          startedAt: text(raw.started_at) ?? text(raw.observed_at) ?? null,
          elapsedMs: null,
        });
      continue;
    }
    if (raw.kind !== "response") continue;
    const entry = pending.get(transactionId);
    if (entry === undefined) continue;
    pending.set(transactionId, {
      ...entry,
      status: numberOrNull(raw.status) ?? entry.status,
      elapsedMs: numberOrNull(raw.elapsed_ms) ?? entry.elapsedMs,
    });
  }
  return [...pending.values()];
};

/** Merge every recognized transaction shape into one bounded waterfall. */
export function projectWaterfall(records: readonly unknown[]): PanelWaterfall {
  const entries: PendingEntry[] = [];
  let truncated = false;
  for (const record of records) {
    const payload = payloadOf(record);
    if (payload === undefined) continue;
    const batches = collectionsOf(payload);
    for (const batch of batches)
      for (const [index, value] of batch.entries()) {
        const entry = entryFromTransaction(value, entries.length + index);
        if (entry !== undefined) entries.push(entry);
      }
    const eventEntries = entriesFromEvents(payload);
    if (eventEntries !== undefined) entries.push(...eventEntries);
  }
  const bounded = entries.slice(0, PANEL_LIMITS.entries);
  if (entries.length > bounded.length) truncated = true;
  const timed = bounded.some((entry) => entry.startedAt !== null);
  return {
    entries: bounded.map(
      ({ id, method, url, status, startedAt, elapsedMs }) => ({
        id,
        method,
        url,
        status,
        startedAt,
        elapsedMs,
      }),
    ),
    timed,
    truncated,
  };
}
