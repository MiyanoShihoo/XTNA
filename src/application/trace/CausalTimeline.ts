/**
 * Cross-boundary causal tracing.
 *
 * Browser/CDP events, IPC messages and native probe records arrive as separate
 * streams with their own clocks. This module puts them on one timeline and
 * groups them into candidate causal chains: explicitly by a shared trace id,
 * otherwise by a bounded time window. A chain is a *candidate*: static and
 * recorded evidence can order events, it cannot prove that one event caused
 * another.
 */
export type TraceSource = "browser" | "ipc" | "native" | "probe" | "log";

export interface TraceEvent {
  /** Which boundary produced the event. */
  readonly source: TraceSource;
  /** Milliseconds since the epoch. Sub-millisecond precision is preserved. */
  readonly timestamp: number;
  /** Short, stable event name, e.g. "click" or "ipc:config:read". */
  readonly name: string;
  /** Optional finer classification supplied by the producer. */
  readonly kind?: string;
  /** Correlation id assigned by the producer when one exists. */
  readonly traceId?: string;
  /** Span length when the producer measured one. */
  readonly durationMs?: number;
  /** Producer payload; kept verbatim apart from the fields above. */
  readonly detail?: Readonly<Record<string, unknown>>;
}

export interface TimelineEntry extends TraceEvent {
  /** Position in the merged timeline. */
  readonly index: number;
  /** Milliseconds since the previous entry; 0 for the first entry. */
  readonly gapMs: number;
}

export interface CausalChain {
  /** How the chain was formed: an explicit id or a time window. */
  readonly basis: "trace-id" | "time-window";
  readonly traceId: string | undefined;
  readonly startMs: number;
  readonly endMs: number;
  readonly spanMs: number;
  readonly events: readonly TimelineEntry[];
}

export interface CorrelateOptions {
  /**
   * Maximum gap between consecutive events of a window-based chain.
   * Defaults to 50 ms.
   */
  readonly windowMs?: number;
  /** Drop chains with fewer than this many events. Defaults to 2. */
  readonly minChainLength?: number;
}

const byTime = (left: TraceEvent, right: TraceEvent): number =>
  left.timestamp - right.timestamp || left.source.localeCompare(right.source);

/** Merge streams into one ordered timeline with per-entry gaps. */
export function mergeTimeline(events: readonly TraceEvent[]): TimelineEntry[] {
  const ordered = [...events].sort(byTime);
  let previous: number | undefined;
  return ordered.map((event, index) => {
    const gapMs = previous === undefined ? 0 : event.timestamp - previous;
    previous = event.timestamp;
    return { ...event, index, gapMs };
  });
}

/**
 * Group a merged timeline into candidate chains.
 *
 * Events that carry a trace id are grouped by it regardless of distance; the
 * remaining events are grouped by `windowMs`. Ordering inside a chain is the
 * timeline order, never the arrival order of the input arrays.
 */
export function correlateEvents(
  events: readonly TraceEvent[],
  options: CorrelateOptions = {},
): CausalChain[] {
  const windowMs = options.windowMs ?? 50;
  const minChainLength = options.minChainLength ?? 2;
  const timeline = mergeTimeline(events);
  const chains: CausalChain[] = [];

  const byTraceId = new Map<string, TimelineEntry[]>();
  for (const entry of timeline)
    if (entry.traceId !== undefined) {
      const list = byTraceId.get(entry.traceId) ?? [];
      list.push(entry);
      byTraceId.set(entry.traceId, list);
    }

  for (const [traceId, entries] of byTraceId) {
    if (entries.length < minChainLength) continue;
    chains.push(makeChain("trace-id", traceId, entries));
  }

  let current: TimelineEntry[] = [];
  const flush = () => {
    if (current.length >= minChainLength)
      chains.push(makeChain("time-window", undefined, current));
    current = [];
  };
  for (const entry of timeline) {
    if (entry.traceId !== undefined) continue;
    if (current.length === 0) {
      current.push(entry);
      continue;
    }
    const previous = current[current.length - 1]!;
    if (entry.timestamp - previous.timestamp <= windowMs) current.push(entry);
    else {
      flush();
      current.push(entry);
    }
  }
  flush();

  return chains.sort(
    (left, right) => left.startMs - right.startMs || left.spanMs - right.spanMs,
  );
}

const makeChain = (
  basis: CausalChain["basis"],
  traceId: string | undefined,
  events: readonly TimelineEntry[],
): CausalChain => {
  const startMs = events[0]?.timestamp ?? 0;
  const endMs = Math.max(
    ...events.map((event) => event.timestamp + (event.durationMs ?? 0)),
  );
  return {
    basis,
    traceId,
    startMs,
    endMs,
    spanMs: Math.max(0, endMs - startMs),
    events,
  };
};

export interface TimelineSummary {
  readonly events: number;
  readonly chains: number;
  readonly bySource: Readonly<Record<TraceSource, number>>;
  readonly spanMs: number;
  readonly largestGapMs: number;
}

/** Aggregate counts used for headers and quick sanity checks. */
export function summarizeTimeline(
  entries: readonly TimelineEntry[],
): TimelineSummary {
  const bySource: Record<TraceSource, number> = {
    browser: 0,
    ipc: 0,
    native: 0,
    probe: 0,
    log: 0,
  };
  let largestGapMs = 0;
  for (const entry of entries) {
    bySource[entry.source] += 1;
    largestGapMs = Math.max(largestGapMs, entry.gapMs);
  }
  const first = entries[0]?.timestamp ?? 0;
  const last = entries[entries.length - 1];
  const endMs =
    last === undefined ? 0 : last.timestamp + (last.durationMs ?? 0);
  return {
    events: entries.length,
    chains: 0,
    bySource,
    spanMs: Math.max(0, endMs - first),
    largestGapMs,
  };
}
