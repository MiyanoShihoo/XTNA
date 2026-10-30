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

/**
 * Tool tiers. `read` is the shipped default surface; `write` and `attach`
 * change session or target state and are only reachable when the operator
 * names them in `--allow-write-tools`, one tool at a time, and approves each
 * call from the panel's terminal. Tools that need a file path, URL or shell
 * command never pass argument validation, whatever their tier.
 */
export const TOOL_TIERS = Object.freeze({
  // session metadata
  set_address_name: "write",
  set_addresses_names: "write",
  set_comment: "write",
  set_inline_comment: "write",
  set_bookmark: "write",
  unset_bookmark: "write",
  annotate_native_function: "write",
  update_analysis_settings: "write",
  goto_address: "write",
  close_binary: "write",
  // target attachment / device state
  resume_frida_session: "attach",
  close_frida_session: "attach",
  start_frida_session: "attach",
  unload_frida_script: "attach",
  start_gdb_session: "attach",
  start_rizin_debug_session: "attach",
  start_adb_app: "attach",
  stop_adb_app: "attach",
  uninstall_adb_package: "attach",
});

const FORBIDDEN_KEY =
  /(path|file|dir|folder|url|uri|host|port|cmd|command|script|exec|shell|env|token|secret|password|argv|binary|apk|ipa|elf|pe)/iu;
const KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,40}$/u;
const MAX_KEYS = 12;
const MAX_STRING = 512;
const MAX_TOOL_NAME = 64;
const MAX_NUMBER = 1_000_000_000;

const tierOf = (tool) => TOOL_TIERS[tool] ?? "read";
const reject = (reason) => ({ ok: false, reason });

/**
 * Validate one query payload against an allowlist.
 * Returns `{ok: true, tool, args}` or `{ok: false, reason}`.
 */
export const validatePanelQuery = (
  payload,
  { allowedTools = DEFAULT_READ_ONLY_TOOLS, allowWriteTools = [] } = {},
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
  const tier = tierOf(tool);
  if (tier === "read") {
    if (!allowedTools.includes(tool))
      return reject(`tool ${tool} is not allowlisted`);
  } else if (!allowWriteTools.includes(tool)) {
    return reject(
      `tool ${tool} needs --allow-write-tools and terminal approval`,
    );
  }
  if (payload.confirm !== undefined && payload.confirm !== null) {
    const confirm = payload.confirm;
    if (
      typeof confirm !== "object" ||
      typeof confirm.requestId !== "string" ||
      typeof confirm.code !== "string"
    )
      return reject("confirm must carry requestId and code strings");
  }
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
  return { ok: true, tool, args, tier };
};

/** Parse a comma-separated tool list; unknown entries are kept so the operator notices. */
export const parseToolList = (value) =>
  value === undefined
    ? undefined
    : value
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
