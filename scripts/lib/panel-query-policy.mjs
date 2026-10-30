/**
 * Admission policy for the panel's read-only query relay.
 *
 * The relay never executes a tool itself: it forwards one allowlisted,
 * argument-shaped request to an MCP server the operator already started, and
 * the server owns every provider session. This module is the only place that
 * decides what may cross that boundary, and it fails closed.
 */

/**
 * Tools that only read the already-open analysis session. Anything that
 * attaches, launches, writes, extracts, captures or changes settings is
 * deliberately absent.
 */
export const DEFAULT_READ_ONLY_TOOLS = Object.freeze([
  "analysis_view",
  "analyze_function",
  "inspect_address_context",
  "inspect_native_api",
  "inspect_native_instruction",
  "list_names",
  "list_procedures",
  "list_segments",
  "list_strings",
  "procedure_address",
  "procedure_assembly",
  "procedure_callees",
  "procedure_callers",
  "procedure_info",
  "procedure_pseudo_code",
  "read_bytes",
  "resolve_containing_procedure",
  "resolve_native_call_targets",
  "search_procedures",
  "search_strings",
  "xrefs",
]);

const FORBIDDEN_KEY =
  /(path|file|dir|folder|url|uri|host|port|cmd|command|script|exec|shell|env|token|secret|password|argv|binary|apk|ipa|elf|pe)/iu;
const KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,40}$/u;
const MAX_KEYS = 12;
const MAX_STRING = 512;
const MAX_TOOL_NAME = 64;
const MAX_NUMBER = 1_000_000_000;

const reject = (reason) => ({ ok: false, reason });

/**
 * Validate one query payload against an allowlist.
 * Returns `{ok: true, tool, args}` or `{ok: false, reason}`.
 */
export const validatePanelQuery = (
  payload,
  { allowedTools = DEFAULT_READ_ONLY_TOOLS } = {},
) => {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload))
    return reject("payload must be an object");
  const tool = payload.tool;
  if (
    typeof tool !== "string" ||
    tool.length === 0 ||
    tool.length > MAX_TOOL_NAME
  )
    return reject("tool must be a non-empty name");
  if (!allowedTools.includes(tool))
    return reject(`tool ${tool} is not allowlisted`);
  const rawArgs = payload.args ?? {};
  if (rawArgs === null || typeof rawArgs !== "object" || Array.isArray(rawArgs))
    return reject("args must be an object");
  const entries = Object.entries(rawArgs);
  if (entries.length > MAX_KEYS) return reject("too many arguments");
  const args = {};
  for (const [key, value] of entries) {
    if (!KEY_PATTERN.test(key))
      return reject(`argument ${key} has an invalid name`);
    if (FORBIDDEN_KEY.test(key))
      return reject(
        `argument ${key} would select a file, process or shell surface`,
      );
    if (value === null || typeof value === "boolean") {
      args[key] = value;
      continue;
    }
    if (typeof value === "number") {
      if (!Number.isFinite(value) || Math.abs(value) > MAX_NUMBER)
        return reject(`argument ${key} is out of range`);
      args[key] = value;
      continue;
    }
    if (typeof value === "string") {
      if (value.length > MAX_STRING)
        return reject(`argument ${key} is too long`);
      if (/[\u0000-\u001f\u007f]/u.test(value))
        return reject(`argument ${key} contains control characters`);
      args[key] = value;
      continue;
    }
    return reject(`argument ${key} must be a string, number, boolean or null`);
  }
  return { ok: true, tool, args };
};

/** Parse a comma-separated tool list; unknown entries are kept so the operator notices. */
export const parseToolList = (value) =>
  value === undefined
    ? undefined
    : value
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
