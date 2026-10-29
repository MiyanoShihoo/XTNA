/**
 * Turn a structural comparison into a change narrative.
 *
 * The input is two reports of the same shape — an inventory of functions, a
 * list of application records, an API surface. Records are paired by a stable
 * key; everything else is derived by comparing the records' own fields. The
 * output is a projection, not a verdict: it says what differs, never why.
 */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface DiffRecord {
  readonly key: string;
  readonly before?: JsonValue;
  readonly after?: JsonValue;
  /** Top-level fields whose value differs, sorted. */
  readonly changedFields: readonly string[];
}

export interface DocumentDiff {
  readonly key: string;
  readonly added: readonly DiffRecord[];
  readonly removed: readonly DiffRecord[];
  readonly changed: readonly DiffRecord[];
  readonly unchanged: number;
}

export interface DiffOptions {
  /** Field used to pair records. Defaults to "name", then "id". */
  readonly key?: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const same = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

/** Find the first array of objects in a document, root array included. */
const collectionOf = (value: unknown): Record<string, unknown>[] => {
  if (Array.isArray(value)) return value.filter(isRecord);
  if (!isRecord(value)) return [];
  for (const candidate of [
    "items",
    "entries",
    "records",
    "functions",
    "results",
  ])
    if (Array.isArray(value[candidate]))
      return (value[candidate] as unknown[]).filter(isRecord);
  for (const nested of Object.values(value)) {
    const found = collectionOf(nested);
    if (found.length > 0) return found;
  }
  return [];
};

const keyOf = (
  record: Record<string, unknown>,
  key: string | undefined,
): string | undefined => {
  for (const candidate of key === undefined ? ["name", "id", "path"] : [key]) {
    const value = record[candidate];
    if (typeof value === "string" || typeof value === "number")
      return String(value);
  }
  return undefined;
};

const changedFields = (
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  key: string,
): string[] => {
  const names = new Set([...Object.keys(before), ...Object.keys(after)]);
  names.delete(key);
  const changed: string[] = [];
  for (const name of [...names].sort())
    if (!same(before[name], after[name])) changed.push(name);
  return changed;
};

/** Pair two documents by key and classify every record. */
export function diffDocuments(
  before: unknown,
  after: unknown,
  options: DiffOptions = {},
): DocumentDiff {
  const key = options.key;
  const beforeRecords = collectionOf(before);
  const afterRecords = collectionOf(after);
  const effectiveKey =
    key ??
    (beforeRecords.some((record) => "name" in record) ||
    afterRecords.some((record) => "name" in record)
      ? "name"
      : "id");
  const beforeMap = new Map<string, Record<string, unknown>>();
  for (const record of beforeRecords) {
    const name = keyOf(record, effectiveKey);
    if (name !== undefined) beforeMap.set(name, record);
  }
  const afterMap = new Map<string, Record<string, unknown>>();
  for (const record of afterRecords) {
    const name = keyOf(record, effectiveKey);
    if (name !== undefined) afterMap.set(name, record);
  }
  const added: DiffRecord[] = [];
  const removed: DiffRecord[] = [];
  const changed: DiffRecord[] = [];
  let unchanged = 0;
  for (const [name, record] of afterMap) {
    const previous = beforeMap.get(name);
    if (previous === undefined) {
      added.push({ key: name, after: record as JsonValue, changedFields: [] });
      continue;
    }
    const fields = changedFields(previous, record, effectiveKey);
    if (fields.length === 0) unchanged += 1;
    else
      changed.push({
        key: name,
        before: previous as JsonValue,
        after: record as JsonValue,
        changedFields: fields,
      });
  }
  for (const [name, record] of beforeMap)
    if (!afterMap.has(name))
      removed.push({
        key: name,
        before: record as JsonValue,
        changedFields: [],
      });
  const byKey = (left: DiffRecord, right: DiffRecord) =>
    left.key.localeCompare(right.key);
  return {
    key: effectiveKey,
    added: [...added].sort(byKey),
    removed: [...removed].sort(byKey),
    changed: [...changed].sort(byKey),
    unchanged,
  };
}

/** Render the diff as Markdown with a one-paragraph summary. */
export function narrateDiff(
  diff: DocumentDiff,
  title = "Change narrative",
): string {
  const lines: string[] = [`# ${title}`, ""];
  const total = diff.added.length + diff.removed.length + diff.changed.length;
  if (total === 0) {
    lines.push(
      `No structural change across ${String(diff.unchanged)} records keyed by \`${diff.key}\`.`,
      "",
    );
    return lines.join("\n");
  }
  lines.push(
    `${String(diff.added.length)} added, ${String(diff.removed.length)} removed, ` +
      `${String(diff.changed.length)} changed, ${String(diff.unchanged)} unchanged — keyed by \`${diff.key}\`.`,
    "",
  );
  const section = (
    heading: string,
    rows: readonly DiffRecord[],
    describe: (row: DiffRecord) => string,
  ) => {
    if (rows.length === 0) return;
    lines.push(`## ${heading}`, "");
    for (const row of rows) lines.push(`- ${describe(row)}`);
    lines.push("");
  };
  section("Added", diff.added, (row) => `\`${row.key}\``);
  section("Removed", diff.removed, (row) => `\`${row.key}\``);
  section(
    "Changed",
    diff.changed,
    (row) =>
      `\`${row.key}\` — ${row.changedFields.map((field) => `\`${field}\``).join(", ")}`,
  );
  return lines.join("\n");
}
