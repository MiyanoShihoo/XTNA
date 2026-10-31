/** Wire types for the frozen panel contract (v1.0.0). */

export interface PanelCounts {
  records: number;
  artifacts: number;
  unknowns: number;
  limitations: number;
  symbols: number;
  hypotheses: number;
  checkpoints: number;
}

export interface PanelNode {
  id: string;
  label?: string;
  address?: string;
  depth?: number;
}

export interface PanelEdge {
  source?: string;
  target?: string;
  from?: string;
  to?: string;
  source_address?: string;
  target_address?: string;
}

export interface PanelGraph {
  nodes: PanelNode[];
  edges: PanelEdge[];
  truncated: boolean;
}

export interface WaterfallEntry {
  method: string;
  url: string;
  status: number | null;
  startedAt: string | null;
  elapsedMs: number | null;
}

export interface PanelWaterfall {
  entries: WaterfallEntry[];
  timed: boolean;
  truncated: boolean;
}

export interface PanelRecord {
  id: string;
  operation: string;
  provider: string;
  authority: string;
  confidence: string;
  limitations: number;
}

export interface PanelSnapshot {
  generatedAt: string;
  title: string;
  sources: {
    evidence: string;
    overlay: string | null;
    hypotheses: string | null;
    checkpoints: string | null;
  };
  counts: PanelCounts;
  graph: PanelGraph;
  waterfall: PanelWaterfall;
  records?: PanelRecord[];
  recordsTruncated?: boolean;
  limitations: { operation: string; text: string }[];
  symbols: {
    address: string;
    name: string;
    kind: string;
    confidence: string;
  }[];
  hypotheses: {
    id: string;
    claim: string;
    status: string;
    confidence: string;
  }[];
  checkpoints: { name: string; bytes: number; modifiedAt: string }[];
}

export interface QueryInfo {
  enabled: boolean;
  tools: string[];
  writeTools?: string[];
}

export interface QueryResult {
  ok: boolean;
  tool: string;
  result?: unknown;
  error?: string;
}

export const fetchState = async (): Promise<PanelSnapshot> => {
  const response = await fetch("/api/state");
  if (!response.ok) throw new Error(`state ${response.status}`);
  return (await response.json()) as PanelSnapshot;
};

export const fetchQueryInfo = async (): Promise<QueryInfo> => {
  const response = await fetch("/api/query");
  if (response.status === 404) return { enabled: false, tools: [] };
  if (!response.ok) throw new Error(`query ${response.status}`);
  return (await response.json()) as QueryInfo;
};

export const runQuery = async (
  tool: string,
  args: Record<string, string>,
  token: string,
  confirm?: { requestId: string; code: string },
): Promise<{ status: number; body: QueryResult & { requestId?: string } }> => {
  const response = await fetch("/api/query", {
    method: "POST",
    headers: { "content-type": "application/json", "x-xtna-token": token },
    body: JSON.stringify({
      tool,
      args,
      ...(confirm === undefined ? {} : { confirm }),
    }),
  });
  return {
    status: response.status,
    body: (await response.json()) as QueryResult,
  };
};
