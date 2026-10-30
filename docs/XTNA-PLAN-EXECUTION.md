# Bounded plan execution

`run_plan` is an MCP tool that runs a dependency-aware plan of read-only analysis tools in the
same REA server process. Independent tasks run concurrently up to `max_concurrency`; a task
starts only after every dependency completed.

## Input

```json
{
  "max_concurrency": 2,
  "tasks": [
    { "id": "names", "tool": "list_names", "arguments": {} },
    { "id": "strings", "tool": "list_strings", "arguments": {} },
    {
      "id": "summary",
      "tool": "search_strings",
      "arguments": { "pattern": "password" },
      "dependencies": ["names", "strings"]
    }
  ]
}
```

## Admission

- Only the static-analysis surface is admitted: `list_names`, `list_strings`,
  `list_procedures`, `analyze_function`, `search_strings`, `search_procedures`,
  `binary_overview`, `list_segments`, `list_documents`, `trace_call_path`, `find_xrefs_to_name`,
  `get_objc_classes`, `get_objc_protocols`, `compare_functions`, `compare_artifacts`,
  `search_bytes`, and `inspect_analysis_settings`.
- A task that names `run_plan` or any write/destructive/device/UI tool is rejected before
  scheduling.
- Each nested call passes through the registered tool's own validation, admission, Evidence
  recording, and delivery. It is not a bypass around the tool contract.
- `dry_run: true` records a completed dry-run result without invoking the nested tool.

## Output and limits

- Results retain the plan order with `completed`, `failed`, `blocked`, `skipped`, or `cancelled`
  status.
- Each task output is a bounded JSON projection. Outputs over 64 KiB are replaced by a preview,
  byte count, and SHA-256 digest.
- Maximum 64 tasks and concurrency 8.
- `CommandAuthority.ts` now classifies operations as L1 (read-only), L2 (sandbox-mutating) or
  L3 (host-critical). L2 requires `sandboxed: true`; L3 requires explicit approval plus a
  non-empty diff preview. This is a policy model, not a real container/sandbox or diff renderer.
- `ObservationCas` now pages immutable windows with opaque cursor tokens and bounded limits.
- This tool is an in-process DAG scheduler, not an autonomous agent runtime.
