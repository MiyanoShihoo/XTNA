/**
 * Frozen wire contract for the live panel.
 *
 * The UI skill consumes these shapes; changing a field means bumping
 * PANEL_CONTRACT_VERSION. Validation is deliberately narrow: it checks the
 * fields a consumer may rely on and refuses a snapshot that violates them,
 * rather than re-deriving the projection.
 */

export const PANEL_CONTRACT_VERSION = "1.0.0";

const isRecord = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isString = (value) => typeof value === "string";
const isNumber = (value) => typeof value === "number" && Number.isFinite(value);
const isArray = Array.isArray;

const requireFields = (value, fields, prefix, errors) => {
  if (!isRecord(value)) {
    errors.push(`${prefix} must be an object`);
    return;
  }
  for (const [name, check] of Object.entries(fields))
    if (!check(value[name]))
      errors.push(`${prefix}.${name} has the wrong type`);
};

/** Validate the `/api/state` snapshot. Returns an array of human-readable errors. */
export const validatePanelState = (snapshot) => {
  const errors = [];
  requireFields(
    snapshot,
    {
      generatedAt: isString,
      title: isString,
      sources: isRecord,
      counts: isRecord,
      graph: isRecord,
      waterfall: isRecord,
    },
    "state",
    errors,
  );
  if (!isRecord(snapshot)) return errors;
  requireFields(
    snapshot.counts,
    {
      records: isNumber,
      artifacts: isNumber,
      unknowns: isNumber,
      limitations: isNumber,
      symbols: isNumber,
      hypotheses: isNumber,
      checkpoints: isNumber,
    },
    "state.counts",
    errors,
  );
  requireFields(
    snapshot.sources,
    { evidence: isString },
    "state.sources",
    errors,
  );
  requireFields(
    snapshot.graph,
    {
      nodes: isArray,
      edges: isArray,
      truncated: (value) => typeof value === "boolean",
    },
    "state.graph",
    errors,
  );
  requireFields(
    snapshot.waterfall,
    {
      entries: isArray,
      timed: (value) => typeof value === "boolean",
      truncated: (value) => typeof value === "boolean",
    },
    "state.waterfall",
    errors,
  );
  for (const field of ["limitations", "symbols", "hypotheses", "checkpoints"])
    if (!isArray(snapshot[field]))
      errors.push(`state.${field} must be an array`);
  if (snapshot.records !== undefined && !isArray(snapshot.records))
    errors.push("state.records must be an array when present");
  return errors;
};

/** Validate one `/api/query` request body (after JSON parsing, before policy). */
export const validateQueryRequestShape = (payload) => {
  const errors = [];
  requireFields(
    payload,
    {
      tool: isString,
      args: (value) => value === undefined || isRecord(value),
    },
    "query",
    errors,
  );
  return errors;
};

/** Validate one `/api/query` success payload. */
export const validateQueryResponseShape = (payload) => {
  const errors = [];
  requireFields(
    payload,
    {
      ok: (value) => typeof value === "boolean",
      tool: isString,
    },
    "queryResult",
    errors,
  );
  if (isRecord(payload) && payload.ok === true && payload.result === undefined)
    errors.push("queryResult.result is required when ok is true");
  return errors;
};

/** Describe the contract for `GET /api/contract`. */
export const panelContract = () => ({
  version: PANEL_CONTRACT_VERSION,
  state: {
    required: [
      "generatedAt",
      "title",
      "sources",
      "counts",
      "graph",
      "waterfall",
      "limitations",
      "symbols",
      "hypotheses",
      "checkpoints",
    ],
    optional: ["records", "recordsTruncated"],
    counts: [
      "records",
      "artifacts",
      "unknowns",
      "limitations",
      "symbols",
      "hypotheses",
      "checkpoints",
    ],
    graph: ["nodes", "edges", "truncated"],
    waterfall: ["entries", "timed", "truncated"],
  },
  query: {
    request: { tool: "string", args: "object (scalar values only)" },
    pending: { status: "pending", requestId: "string", expiresAt: "ISO-8601" },
    success: { ok: true, tool: "string", result: "MCP tool result" },
    error: { error: "string" },
    headers: { token: "x-xtna-token" },
  },
  changePolicy:
    "Additive fields bump the minor version; removing or retyping a field bumps the major version.",
});
