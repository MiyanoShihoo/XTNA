#!/usr/bin/env node
/**
 * Typed hypothesis board CLI.
 *
 * Wraps `src/domain/investigation/HypothesisBoard.ts`: every record is
 * validated on load, `create` and `command` go through the domain state
 * machine (checklist completeness, conflict backtracking), and the store is
 * written only after the transition succeeds.
 *
 * usage:
 *   node scripts/hypothesis-board.mjs create --id h1 --statement "..." [--checklist "c1=label:supporting"]...
 *   node scripts/hypothesis-board.mjs command --id h1 --json '{"kind":"start-investigation"}'
 *   node scripts/hypothesis-board.mjs list [--json]
 *   node scripts/hypothesis-board.mjs show --id h1
 *   node scripts/hypothesis-board.mjs check --evidence ev_...
 *
 * Store: --store <file>, else $XTNA_HYPOTHESIS_BOARD, else ./.xtna/hypothesis-board.json
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const args = process.argv.slice(2);
const command = args[0];
const flag = (name) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};
const valuesOf = (name) => {
  const out = [];
  for (let index = 0; index < args.length; index += 1)
    if (args[index] === `--${name}` && args[index + 1] !== undefined)
      out.push(args[index + 1]);
  return out;
};
const has = (name) => args.includes(`--${name}`);
const storePath = resolve(
  flag("store") ??
    process.env.XTNA_HYPOTHESIS_BOARD ??
    ".xtna/hypothesis-board.json",
);
const fail = (message, code = 2) => {
  process.stderr.write(`hypothesis-board: ${message}\n`);
  process.exit(code);
};

const {
  createHypothesis,
  transitionHypothesis,
  hypothesisRecordSchema,
  hypothesisCommandSchema,
} = await import(
  new URL("../dist/domain/investigation/HypothesisBoard.js", import.meta.url)
    .href
);

const load = async () => {
  const raw = await readFile(storePath, "utf8").catch(() => null);
  if (raw === null) return { schema: "xtna.hypothesis-board/1", records: [] };
  const parsed = JSON.parse(raw);
  if (parsed.schema !== "xtna.hypothesis-board/1")
    fail(`unsupported store schema in ${storePath}`);
  for (const record of parsed.records) hypothesisRecordSchema.parse(record);
  return parsed;
};
const save = async (store) => {
  await mkdir(dirname(storePath), { recursive: true });
  await writeFile(storePath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
};
const showError = (error) => {
  fail(`${error.code}: ${error.message}`, 3);
};

const create = async () => {
  const id = flag("id");
  const statement = flag("statement");
  if (id === undefined || statement === undefined)
    fail("--id and --statement are required");
  const checklist = valuesOf("checklist").map((entry) => {
    const match = /^([^=]+)=([^:]+):(supporting|contradicting)$/u.exec(entry);
    if (match === null)
      fail(`--checklist must look like id=label:supporting — got ${entry}`);
    return { id: match[1], label: match[2], direction: match[3] };
  });
  const store = await load();
  if (store.records.some((record) => record.id === id))
    fail(`hypothesis ${id} already exists`);
  let created;
  try {
    created = createHypothesis({ id, statement, checklist });
  } catch (error) {
    fail(String(error instanceof Error ? error.message : error), 3);
  }
  store.records.push(created);
  await save(store);
  process.stdout.write(`${id} created\n`);
};

const applyCommand = async () => {
  const id = flag("id");
  const raw =
    flag("json") ??
    (flag("json-file") === undefined
      ? undefined
      : await readFile(flag("json-file"), "utf8"));
  if (id === undefined || raw === undefined)
    fail("--id and (--json or --json-file) are required");
  let parsed;
  try {
    parsed = JSON.parse(raw.replace(/^﻿/u, ""));
  } catch {
    fail("--json/--json-file must contain a JSON object");
  }
  const commandValue = hypothesisCommandSchema.parse(parsed);
  const store = await load();
  const index = store.records.findIndex((record) => record.id === id);
  if (index < 0) fail(`no hypothesis ${id}`);
  const result = transitionHypothesis(store.records[index], commandValue);
  if (!result.ok) showError(result.error);
  store.records[index] = result.value;
  await save(store);
  process.stdout.write(`${id} -> ${result.value.status}\n`);
};

const list = async () => {
  const store = await load();
  if (has("json")) {
    process.stdout.write(`${JSON.stringify(store.records, null, 2)}\n`);
    return;
  }
  if (store.records.length === 0) {
    process.stdout.write("no hypotheses\n");
    return;
  }
  for (const record of store.records)
    process.stdout.write(
      `${record.id}  ${record.status.padEnd(13)} ${record.statement}\n`,
    );
};

const show = async () => {
  const id = flag("id");
  if (id === undefined) fail("--id is required");
  const store = await load();
  const record = store.records.find((candidate) => candidate.id === id);
  if (record === undefined) fail(`no hypothesis ${id}`);
  process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
};

const check = async () => {
  const evidence = flag("evidence");
  if (evidence === undefined) fail("--evidence is required");
  const store = await load();
  const hits = store.records.filter((record) => {
    const ids = [
      ...record.history.flatMap((event) => event.evidence_ids),
      ...record.checklist.flatMap((item) => item.evidence_ids),
      ...record.conflicts.flatMap((conflict) => conflict.evidence_ids),
    ];
    return ids.includes(evidence);
  });
  process.stdout.write(
    hits.length === 0
      ? "no hypothesis references this evidence\n"
      : `${hits.map((record) => `${record.id}  ${record.status}  ${record.statement}`).join("\n")}\n`,
  );
};

const usage = `usage: node scripts/hypothesis-board.mjs <command>

  create  --id h1 --statement "..." [--checklist id=label:supporting]...
  command --id h1 (--json '<object>' | --json-file <path>)
  list    [--json]
  show    --id h1
  check   --evidence ev_...

Store: --store <file>, else $XTNA_HYPOTHESIS_BOARD, else ./.xtna/hypothesis-board.json
`;

if (command === undefined || command === "--help" || command === "-h") {
  process.stdout.write(usage);
} else if (command === "create") await create();
else if (command === "command") await applyCommand();
else if (command === "list") await list();
else if (command === "show") await show();
else if (command === "check") await check();
else fail(`unknown command: ${command}`, 2);
