import { describe, expect, it } from "vitest";

import {
  correlateEvents,
  mergeTimeline,
  summarizeTimeline,
  type TraceEvent,
} from "./CausalTimeline.js";

const event = (
  source: TraceEvent["source"],
  timestamp: number,
  name: string,
  rest: Partial<TraceEvent> = {},
): TraceEvent => ({ source, timestamp, name, ...rest });

describe("timeline merge", () => {
  it("orders events across streams and records gaps", () => {
    const timeline = mergeTimeline([
      event("native", 1_000, "enter"),
      event("browser", 900, "click"),
      event("ipc", 940, "send"),
    ]);
    expect(timeline.map((entry) => entry.name)).toEqual([
      "click",
      "send",
      "enter",
    ]);
    expect(timeline.map((entry) => entry.gapMs)).toEqual([0, 40, 60]);
    expect(timeline.map((entry) => entry.index)).toEqual([0, 1, 2]);
  });

  it("breaks timestamp ties deterministically by source", () => {
    const timeline = mergeTimeline([
      event("probe", 5, "b"),
      event("browser", 5, "a"),
    ]);
    expect(timeline.map((entry) => entry.source)).toEqual(["browser", "probe"]);
  });
});

describe("causal chains", () => {
  it("groups explicit trace ids regardless of distance", () => {
    const chains = correlateEvents([
      event("browser", 1_000, "click", { traceId: "t1" }),
      event("probe", 9_000, "enter", { traceId: "t1" }),
    ]);
    const chained = chains.filter((chain) => chain.basis === "trace-id");
    expect(chained).toHaveLength(1);
    expect(chained[0]?.spanMs).toBe(8_000);
  });

  it("links untagged events inside the window and splits outside it", () => {
    const chains = correlateEvents(
      [
        event("browser", 1_000, "click"),
        event("ipc", 1_020, "send"),
        event("native", 1_030, "enter"),
        event("browser", 5_000, "idle"),
      ],
      { windowMs: 50 },
    );
    const windowed = chains.filter((chain) => chain.basis === "time-window");
    expect(windowed).toHaveLength(1);
    expect(windowed[0]?.events.map((entry) => entry.name)).toEqual([
      "click",
      "send",
      "enter",
    ]);
  });

  it("drops chains shorter than the minimum", () => {
    const chains = correlateEvents([event("browser", 1_000, "solo")], {
      minChainLength: 2,
    });
    expect(chains).toEqual([]);
  });

  it("uses span duration when the producer measured one", () => {
    const chains = correlateEvents(
      [
        event("probe", 1_000, "enter", { traceId: "t", durationMs: 250 }),
        event("probe", 1_010, "leave", { traceId: "t" }),
      ],
      {},
    );
    expect(chains[0]?.spanMs).toBe(250);
  });
});

describe("summary", () => {
  it("counts by source and reports the largest gap", () => {
    const timeline = mergeTimeline([
      event("browser", 1_000, "a"),
      event("browser", 1_100, "b"),
      event("probe", 1_400, "c"),
    ]);
    const summary = summarizeTimeline(timeline);
    expect(summary.events).toBe(3);
    expect(summary.bySource.browser).toBe(2);
    expect(summary.bySource.probe).toBe(1);
    expect(summary.largestGapMs).toBe(300);
    expect(summary.spanMs).toBe(400);
  });
});
