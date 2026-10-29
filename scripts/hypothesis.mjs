#!/usr/bin/env node
/** Hypothesis board: explicit claims with status and evidence links. */
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const SCHEMA = "xtna.hypotheses/1";
const args = process.argv.slice(2);
const command = args[0];
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const valuesOf = (name) => {
  const out = [];
  for (let i = 0; i < args.length; i += 1)
    if (args[i] === `--${name}` && args[i + 1]) out.push(args[i + 1]);
  return out;
};
const has = (name) => args.includes(`--${name}`);
const dir = resolve(
  process.env.XTNA_HYPOTHESIS_DIR ?? join(homedir(), ".xtna", "hypotheses"),
);
const file = join(dir, "hypotheses.json");
const fail = (message) => {
  process.stderr.write(`hypothesis: ${message}\n`);
  process.exit(2);
};
const CONFIDENCE = new Set(["observed", "inferred", "guessed"]);
const STATUS = new Set(["open", "supported", "contradicted", "refuted"]);

const load = async () => {
  const raw = await readFile(file, "utf8").catch(() => null);
  if (raw === null) return { schema: SCHEMA, items: [] };
  const parsed = JSON.parse(raw);
  if (parsed.schema !== SCHEMA) fail("unsupported hypothesis store");
  return parsed;
};
const save = async (store) => {
  await mkdir(dir, { recursive: true });
  await writeFile(file, JSON.stringify(store, null, 2) + "\n", "utf8");
};
const newId = () =>
  `hyp_${Date.now().toString(36)}_${randomBytes(3).toString("hex")}`;

const add = async () => {
  const statement = flag("statement");
  if (statement === undefined) fail("--statement is required");
  const confidence = flag("confidence") ?? "inferred";
  if (!CONFIDENCE.has(confidence)) fail("bad --confidence");
  const store = await load();
  const item = {
    id: newId(),
    statement,
    confidence,
    status: "open",
    evidence_ids: valuesOf("evidence"),
    contradictions: [],
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  store.items.push(item);
  await save(store);
  process.stdout.write(`added ${item.id}\n`);
};

const list = async () => {
  const store = await load();
  const status = flag("status");
  const items = store.items.filter(
    (item) => status === undefined || item.status === status,
  );
  if (has("json")) {
    process.stdout.write(JSON.stringify(items, null, 2) + "\n");
    return;
  }
  if (items.length === 0) {
    process.stdout.write("no hypotheses\n");
    return;
  }
  for (const item of items)
    process.stdout.write(
      `${item.id}  ${item.status.padEnd(12)} ${item.confidence.padEnd(9)} ${item.statement}\n`,
    );
};

const setStatus = async () => {
  const id = flag("id");
  if (id === undefined) fail("--id is required");
  const status = flag("status");
  if (status === undefined || !STATUS.has(status))
    fail("--status must be open|supported|contradicted|refuted");
  const store = await load();
  const item = store.items.find((candidate) => candidate.id === id);
  if (item === undefined) fail(`no hypothesis ${id}`);
  item.status = status;
  item.updated_at = new Date().toISOString();
  for (const evidence of valuesOf("evidence")) {
    if (status === "contradicted" || status === "refuted")
      item.contradictions.push(evidence);
    else if (!item.evidence_ids.includes(evidence))
      item.evidence_ids.push(evidence);
  }
  await save(store);
  process.stdout.write(`${id} -> ${status}\n`);
};

const show = async () => {
  const id = flag("id");
  if (id === undefined) fail("--id is required");
  const store = await load();
  const item = store.items.find((candidate) => candidate.id === id);
  if (item === undefined) fail(`no hypothesis ${id}`);
  process.stdout.write(JSON.stringify(item, null, 2) + "\n");
};

const remove = async () => {
  const id = flag("id");
  if (id === undefined) fail("--id is required");
  const store = await load();
  const before = store.items.length;
  store.items = store.items.filter((item) => item.id !== id);
  await save(store);
  process.stdout.write(`removed ${before - store.items.length}\n`);
};

const check = async () => {
  const evidence = flag("evidence");
  if (evidence === undefined) fail("--evidence is required");
  const store = await load();
  const hits = store.items.filter(
    (item) =>
      item.evidence_ids.includes(evidence) ||
      item.contradictions.includes(evidence),
  );
  process.stdout.write(
    hits.length === 0
      ? "no hypothesis references this evidence\n"
      : hits
          .map((item) => `${item.id}  ${item.status}  ${item.statement}`)
          .join("\n") + "\n",
  );
};

const usage = `usage: node scripts/hypothesis.mjs <command>

  add      --statement "..." [--confidence observed|inferred|guessed] [--evidence ev_...]...
  list     [--status open|supported|contradicted|refuted] [--json]
  status   --id hyp_... --status <status> [--evidence ev_...]...
  show     --id hyp_...
  check    --evidence ev_...
  delete   --id hyp_...

Environment: XTNA_HYPOTHESIS_DIR (default ~/.xtna/hypotheses)
`;

const main = async () => {
  if (command === undefined || command === "--help" || command === "-h") {
    process.stdout.write(usage);
    return;
  }
  if (command === "add") return add();
  if (command === "list") return list();
  if (command === "status") return setStatus();
  if (command === "show") return show();
  if (command === "check") return check();
  if (command === "delete") return remove();
  fail(`unknown command: ${command}`);
};
await main();
